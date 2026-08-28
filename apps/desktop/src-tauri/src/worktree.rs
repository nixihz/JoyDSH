use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fmt, fs, io,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_TEXT_DIFF_BYTES: u64 = 2 * 1024 * 1024;
const MAX_INSPECTION_FILES: usize = 1_000;
const MAX_INSPECTION_DIFF_LINES: u64 = 50_000;
const MAX_INSPECTION_DIFF_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorkspace {
    pub(crate) repository_root: PathBuf,
    pub(crate) head_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskBaseline {
    pub(crate) repository_root: PathBuf,
    pub(crate) revision: String,
    pub(crate) captured_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeInspection {
    pub(crate) repository_root: PathBuf,
    pub(crate) baseline_revision: String,
    pub(crate) head_revision: Option<String>,
    pub(crate) clean: bool,
    pub(crate) changes: Vec<FileChange>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChange {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) previous_path: Option<String>,
    pub(crate) status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) similarity: Option<u8>,
    pub(crate) diff: FileDiff,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Untracked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum FileDiff {
    Text {
        additions: u64,
        deletions: u64,
        hunks: Vec<DiffHunk>,
    },
    Binary,
    TooLarge {
        max_bytes: u64,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffHunk {
    pub(crate) old_start: u64,
    pub(crate) old_lines: u64,
    pub(crate) new_start: u64,
    pub(crate) new_lines: u64,
    pub(crate) heading: String,
    pub(crate) lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffLine {
    pub(crate) kind: DiffLineKind,
    pub(crate) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) old_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) new_line: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DiffLineKind {
    Context,
    Addition,
    Deletion,
    NoNewlineMarker,
}

#[derive(Debug)]
pub(crate) enum WorktreeError {
    PathUnavailable {
        path: PathBuf,
        source: io::Error,
    },
    NotDirectory(PathBuf),
    GitUnavailable(io::Error),
    NotGitWorkspace {
        path: PathBuf,
        detail: String,
    },
    InvalidRevision(String),
    DirtyTaskBaseline,
    BaselineRepositoryMismatch {
        expected: PathBuf,
        actual: PathBuf,
    },
    RepositoryChangedDuringCapture,
    RepositoryChangedDuringInspection,
    InspectionLimitExceeded {
        resource: &'static str,
        max: u64,
    },
    SystemClock(String),
    GitCommand {
        operation: &'static str,
        detail: String,
    },
    InvalidGitOutput {
        operation: &'static str,
        detail: String,
    },
}

impl fmt::Display for WorktreeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PathUnavailable { path, source } => {
                write!(formatter, "工作空间路径不可用 {}：{source}", path.display())
            }
            Self::NotDirectory(path) => {
                write!(formatter, "工作空间路径不是目录：{}", path.display())
            }
            Self::GitUnavailable(error) => write!(formatter, "无法运行 Git：{error}"),
            Self::NotGitWorkspace { path, detail } => {
                write!(
                    formatter,
                    "路径不是 Git 工作区 {}：{detail}",
                    path.display()
                )
            }
            Self::InvalidRevision(revision) => write!(formatter, "Git 基线无效：{revision}"),
            Self::DirtyTaskBaseline => {
                write!(formatter, "工作区已有未提交变更，不能建立可靠的任务基线")
            }
            Self::BaselineRepositoryMismatch { expected, actual } => write!(
                formatter,
                "任务基线属于其他 Git 工作区（期望 {}，实际 {}）",
                expected.display(),
                actual.display()
            ),
            Self::RepositoryChangedDuringCapture => {
                write!(formatter, "建立任务基线期间 HEAD 发生变化，请重试")
            }
            Self::RepositoryChangedDuringInspection => {
                write!(formatter, "检查变更期间 Git 工作区发生变化，请重试")
            }
            Self::InspectionLimitExceeded { resource, max } => {
                write!(formatter, "检查结果超过资源上限（{resource} 最多 {max}）")
            }
            Self::SystemClock(detail) => write!(formatter, "无法记录任务基线时间：{detail}"),
            Self::GitCommand { operation, detail } => {
                write!(formatter, "Git {operation}失败：{detail}")
            }
            Self::InvalidGitOutput { operation, detail } => {
                write!(formatter, "Git {operation}输出无效：{detail}")
            }
        }
    }
}

impl std::error::Error for WorktreeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::PathUnavailable { source, .. } | Self::GitUnavailable(source) => Some(source),
            _ => None,
        }
    }
}

/// Resolves a directory (or a directory inside a repository) to its Git worktree.
pub(crate) fn validate_git_workspace(path: &Path) -> Result<GitWorkspace, WorktreeError> {
    let directory = fs::canonicalize(path).map_err(|source| WorktreeError::PathUnavailable {
        path: path.to_path_buf(),
        source,
    })?;
    if !directory.is_dir() {
        return Err(WorktreeError::NotDirectory(directory));
    }

    let inside = run_git_raw(&directory, ["rev-parse", "--is-inside-work-tree"])?;
    if !inside.status.success() || trimmed_utf8(&inside.stdout, "验证工作区")? != "true" {
        return Err(WorktreeError::NotGitWorkspace {
            path: directory,
            detail: stderr_detail(&inside),
        });
    }

    let root_output = run_git(
        &directory,
        "读取工作区根目录",
        ["rev-parse", "--show-toplevel"],
    )?;
    let root_text = trimmed_utf8(&root_output.stdout, "读取工作区根目录")?;
    if root_text.is_empty() {
        return Err(WorktreeError::InvalidGitOutput {
            operation: "读取工作区根目录",
            detail: "根目录为空".into(),
        });
    }
    let repository_root =
        fs::canonicalize(root_text).map_err(|source| WorktreeError::PathUnavailable {
            path: PathBuf::from(root_text),
            source,
        })?;
    let head_revision = try_resolve_revision(&repository_root, "HEAD")?;

    Ok(GitWorkspace {
        repository_root,
        head_revision,
    })
}

/// Captures a commit-backed task boundary. A dirty worktree is rejected because a commit hash
/// cannot faithfully distinguish pre-existing edits from edits made by the new task.
pub(crate) fn capture_task_baseline(path: &Path) -> Result<TaskBaseline, WorktreeError> {
    let workspace = validate_git_workspace(path)?;
    let revision = workspace
        .head_revision
        .ok_or_else(|| WorktreeError::InvalidRevision("HEAD（仓库尚无提交）".into()))?;
    let status = run_git(
        &workspace.repository_root,
        "检查任务基线",
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    if !status.stdout.is_empty() {
        return Err(WorktreeError::DirtyTaskBaseline);
    }
    if try_resolve_revision(&workspace.repository_root, "HEAD")?.as_deref()
        != Some(revision.as_str())
    {
        return Err(WorktreeError::RepositoryChangedDuringCapture);
    }
    let captured_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| WorktreeError::SystemClock(error.to_string()))?
        .as_millis()
        .try_into()
        .map_err(|_| WorktreeError::SystemClock("毫秒时间戳超出 u64 范围".into()))?;

    Ok(TaskBaseline {
        repository_root: workspace.repository_root,
        revision,
        captured_at,
    })
}

pub(crate) fn inspect_changes_from_task_baseline(
    path: &Path,
    baseline: &TaskBaseline,
) -> Result<WorktreeInspection, WorktreeError> {
    let workspace = validate_git_workspace(path)?;
    if workspace.repository_root != baseline.repository_root {
        return Err(WorktreeError::BaselineRepositoryMismatch {
            expected: baseline.repository_root.clone(),
            actual: workspace.repository_root,
        });
    }
    let revision = resolve_revision(&baseline.repository_root, &baseline.revision)?;
    inspect_resolved_revision(workspace, revision)
}

/// Supports explicit compare targets independently from the persisted task-baseline flow.
#[allow(dead_code)]
pub(crate) fn inspect_changes_from_revision(
    path: &Path,
    revision: &str,
) -> Result<WorktreeInspection, WorktreeError> {
    let workspace = validate_git_workspace(path)?;
    let revision = resolve_revision(&workspace.repository_root, revision)?;
    inspect_resolved_revision(workspace, revision)
}

fn inspect_resolved_revision(
    workspace: GitWorkspace,
    baseline_revision: String,
) -> Result<WorktreeInspection, WorktreeError> {
    inspect_resolved_revision_with_hook(workspace, baseline_revision, || {})
}

fn inspect_resolved_revision_with_hook<F>(
    workspace: GitWorkspace,
    baseline_revision: String,
    before_final_fingerprint: F,
) -> Result<WorktreeInspection, WorktreeError>
where
    F: FnOnce(),
{
    let repository_root = workspace.repository_root;
    let initial_fingerprint = repository_fingerprint(&repository_root)?;
    let mut changes = tracked_changes(&repository_root, &baseline_revision)?;
    for path in unmerged_paths(&repository_root)? {
        if let Some(change) = changes.iter_mut().find(|change| change.path == path) {
            change.status = FileStatus::Unmerged;
            change.previous_path = None;
            change.similarity = None;
            change.index_only = false;
        } else {
            changes.push(ChangeDescriptor {
                path,
                previous_path: None,
                status: FileStatus::Unmerged,
                similarity: None,
                index_only: false,
            });
        }
    }
    let existing_paths = changes
        .iter()
        .map(|change| change.path.clone())
        .collect::<BTreeSet<_>>();
    for path in untracked_paths(&repository_root)? {
        if !existing_paths.contains(&path) {
            changes.push(ChangeDescriptor {
                path,
                previous_path: None,
                status: FileStatus::Untracked,
                similarity: None,
                index_only: false,
            });
        }
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    if changes.len() > MAX_INSPECTION_FILES {
        return Err(WorktreeError::InspectionLimitExceeded {
            resource: "文件数",
            max: MAX_INSPECTION_FILES as u64,
        });
    }

    let mut inspection_budget = InspectionBudget::default();
    let mut inspected_changes = Vec::with_capacity(changes.len());
    for change in changes {
        let diff = file_diff(&repository_root, &baseline_revision, &change)?;
        inspection_budget.include(&diff)?;
        inspected_changes.push(FileChange {
            path: change.path,
            previous_path: change.previous_path,
            status: change.status,
            similarity: change.similarity,
            diff,
        });
    }

    before_final_fingerprint();
    if repository_fingerprint(&repository_root)? != initial_fingerprint {
        return Err(WorktreeError::RepositoryChangedDuringInspection);
    }

    Ok(WorktreeInspection {
        repository_root,
        baseline_revision,
        head_revision: initial_fingerprint.head_revision,
        clean: inspected_changes.is_empty(),
        changes: inspected_changes,
    })
}

#[derive(Debug, Eq, PartialEq)]
struct RepositoryFingerprint {
    head_revision: Option<String>,
    index_and_worktree_status: Vec<u8>,
    index_entries_hash: u64,
    worktree_paths: Vec<WorktreePathFingerprint>,
}

fn repository_fingerprint(repository_root: &Path) -> Result<RepositoryFingerprint, WorktreeError> {
    let head_before = try_resolve_revision(repository_root, "HEAD")?;
    let status = run_git(
        repository_root,
        "读取工作区一致性指纹",
        [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    let index_entries = run_git(
        repository_root,
        "读取索引一致性指纹",
        ["ls-files", "--stage", "-z", "--"],
    )?;
    let worktree_paths = fingerprint_status_paths(repository_root, &status.stdout)?;
    let head_after = try_resolve_revision(repository_root, "HEAD")?;
    if head_before != head_after {
        return Err(WorktreeError::RepositoryChangedDuringInspection);
    }
    Ok(RepositoryFingerprint {
        head_revision: head_after,
        index_and_worktree_status: status.stdout,
        index_entries_hash: fingerprint_bytes(&index_entries.stdout),
        worktree_paths,
    })
}

#[derive(Debug, Eq, PartialEq)]
struct WorktreePathFingerprint {
    path: String,
    metadata: Option<PathMetadataFingerprint>,
}

#[derive(Debug, Eq, PartialEq)]
struct PathMetadataFingerprint {
    kind: u8,
    len: u64,
    modified_nanos: Option<u128>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    change_seconds: i64,
    #[cfg(unix)]
    change_nanos: i64,
}

fn fingerprint_status_paths(
    repository_root: &Path,
    status: &[u8],
) -> Result<Vec<WorktreePathFingerprint>, WorktreeError> {
    let fields = status
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut paths = BTreeSet::new();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.len() < 4 || record[2] != b' ' {
            return Err(WorktreeError::InvalidGitOutput {
                operation: "读取工作区一致性指纹",
                detail: "porcelain 状态记录无效".into(),
            });
        }
        let status_code = &record[..2];
        let path = String::from_utf8(record[3..].to_vec()).map_err(|_| {
            WorktreeError::InvalidGitOutput {
                operation: "读取工作区一致性指纹",
                detail: "文件路径不是 UTF-8".into(),
            }
        })?;
        ensure_relative_git_path(&path, "读取工作区一致性指纹")?;
        paths.insert(path);
        if status_code.iter().any(|code| matches!(*code, b'R' | b'C')) {
            let previous = fields
                .get(index)
                .ok_or_else(|| WorktreeError::InvalidGitOutput {
                    operation: "读取工作区一致性指纹",
                    detail: "重命名状态缺少原路径".into(),
                })?;
            index += 1;
            let previous = String::from_utf8(previous.to_vec()).map_err(|_| {
                WorktreeError::InvalidGitOutput {
                    operation: "读取工作区一致性指纹",
                    detail: "原文件路径不是 UTF-8".into(),
                }
            })?;
            ensure_relative_git_path(&previous, "读取工作区一致性指纹")?;
            paths.insert(previous);
        }
    }

    paths
        .into_iter()
        .map(|path| {
            let absolute = repository_root.join(&path);
            let metadata = match fs::symlink_metadata(&absolute) {
                Ok(metadata) => Some(path_metadata_fingerprint(&metadata)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(source) => {
                    return Err(WorktreeError::PathUnavailable {
                        path: absolute,
                        source,
                    })
                }
            };
            Ok(WorktreePathFingerprint { path, metadata })
        })
        .collect()
}

fn path_metadata_fingerprint(metadata: &fs::Metadata) -> PathMetadataFingerprint {
    let file_type = metadata.file_type();
    let kind = if file_type.is_file() {
        1
    } else if file_type.is_dir() {
        2
    } else if file_type.is_symlink() {
        3
    } else {
        4
    };
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        PathMetadataFingerprint {
            kind,
            len: metadata.len(),
            modified_nanos,
            device: metadata.dev(),
            inode: metadata.ino(),
            change_seconds: metadata.ctime(),
            change_nanos: metadata.ctime_nsec(),
        }
    }
    #[cfg(not(unix))]
    {
        PathMetadataFingerprint {
            kind,
            len: metadata.len(),
            modified_nanos,
        }
    }
}

fn fingerprint_bytes(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[derive(Default)]
struct InspectionBudget {
    diff_lines: u64,
    diff_bytes: u64,
}

impl InspectionBudget {
    fn include(&mut self, diff: &FileDiff) -> Result<(), WorktreeError> {
        let (lines, bytes) = diff_usage(diff);
        self.diff_lines =
            self.diff_lines
                .checked_add(lines)
                .ok_or(WorktreeError::InspectionLimitExceeded {
                    resource: "diff 行数",
                    max: MAX_INSPECTION_DIFF_LINES,
                })?;
        self.diff_bytes =
            self.diff_bytes
                .checked_add(bytes)
                .ok_or(WorktreeError::InspectionLimitExceeded {
                    resource: "diff 字节数",
                    max: MAX_INSPECTION_DIFF_BYTES,
                })?;
        if self.diff_lines > MAX_INSPECTION_DIFF_LINES {
            return Err(WorktreeError::InspectionLimitExceeded {
                resource: "diff 行数",
                max: MAX_INSPECTION_DIFF_LINES,
            });
        }
        if self.diff_bytes > MAX_INSPECTION_DIFF_BYTES {
            return Err(WorktreeError::InspectionLimitExceeded {
                resource: "diff 字节数",
                max: MAX_INSPECTION_DIFF_BYTES,
            });
        }
        Ok(())
    }
}

fn diff_usage(diff: &FileDiff) -> (u64, u64) {
    let FileDiff::Text { hunks, .. } = diff else {
        return (0, 0);
    };
    let mut lines = 0_u64;
    let mut bytes = 0_u64;
    for hunk in hunks {
        bytes = bytes.saturating_add(hunk.heading.len() as u64);
        for line in &hunk.lines {
            lines = lines.saturating_add(1);
            bytes = bytes.saturating_add(line.content.len() as u64);
        }
    }
    (lines, bytes)
}

fn ensure_diff_materialization_budget(lines: u64, bytes: u64) -> Result<(), WorktreeError> {
    if lines > MAX_INSPECTION_DIFF_LINES {
        return Err(WorktreeError::InspectionLimitExceeded {
            resource: "diff 行数",
            max: MAX_INSPECTION_DIFF_LINES,
        });
    }
    if bytes > MAX_INSPECTION_DIFF_BYTES {
        return Err(WorktreeError::InspectionLimitExceeded {
            resource: "diff 字节数",
            max: MAX_INSPECTION_DIFF_BYTES,
        });
    }
    Ok(())
}

#[derive(Debug)]
struct ChangeDescriptor {
    path: String,
    previous_path: Option<String>,
    status: FileStatus,
    similarity: Option<u8>,
    index_only: bool,
}

fn tracked_changes(
    repository_root: &Path,
    baseline_revision: &str,
) -> Result<Vec<ChangeDescriptor>, WorktreeError> {
    let worktree_args: Vec<String> = vec![
        "diff".into(),
        "--name-status".into(),
        "-z".into(),
        "--find-renames=50%".into(),
        "--find-copies=50%".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        baseline_revision.into(),
        "--".into(),
    ];
    let worktree_output = run_git(repository_root, "列出工作区文件变更", worktree_args)?;
    let mut changes = parse_name_status(&worktree_output.stdout, "列出工作区文件变更", false)?;

    let cached_args: Vec<String> = vec![
        "diff".into(),
        "--cached".into(),
        "--name-status".into(),
        "-z".into(),
        "--find-renames=50%".into(),
        "--find-copies=50%".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        baseline_revision.into(),
        "--".into(),
    ];
    let cached_output = run_git(repository_root, "列出暂存区文件变更", cached_args)?;
    let worktree_paths = changes
        .iter()
        .map(|change| change.path.clone())
        .collect::<BTreeSet<_>>();
    changes.extend(
        parse_name_status(&cached_output.stdout, "列出暂存区文件变更", true)?
            .into_iter()
            .filter(|change| !worktree_paths.contains(&change.path)),
    );
    Ok(changes)
}

fn parse_name_status(
    output: &[u8],
    operation: &'static str,
    index_only: bool,
) -> Result<Vec<ChangeDescriptor>, WorktreeError> {
    let fields = nul_terminated_utf8(output, operation)?;
    let mut changes = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let token = &fields[index];
        index += 1;
        if token.is_empty() {
            continue;
        }
        let code = token
            .chars()
            .next()
            .ok_or_else(|| WorktreeError::InvalidGitOutput {
                operation,
                detail: "缺少状态码".into(),
            })?;
        let (status, two_paths) = match code {
            'A' => (FileStatus::Added, false),
            'M' => (FileStatus::Modified, false),
            'D' => (FileStatus::Deleted, false),
            'R' => (FileStatus::Renamed, true),
            'C' => (FileStatus::Copied, true),
            'T' => (FileStatus::TypeChanged, false),
            'U' => (FileStatus::Unmerged, false),
            other => {
                return Err(WorktreeError::InvalidGitOutput {
                    operation,
                    detail: format!("未知状态码 {other}"),
                })
            }
        };
        let similarity = if two_paths {
            token.get(1..).and_then(|score| score.parse::<u8>().ok())
        } else {
            None
        };
        let first = fields
            .get(index)
            .ok_or_else(|| WorktreeError::InvalidGitOutput {
                operation,
                detail: format!("状态 {token} 缺少文件路径"),
            })?
            .clone();
        ensure_relative_git_path(&first, operation)?;
        index += 1;
        let (path, previous_path) = if two_paths {
            let second = fields
                .get(index)
                .ok_or_else(|| WorktreeError::InvalidGitOutput {
                    operation,
                    detail: format!("状态 {token} 缺少目标路径"),
                })?
                .clone();
            ensure_relative_git_path(&second, operation)?;
            index += 1;
            (second, Some(first))
        } else {
            (first, None)
        };
        changes.push(ChangeDescriptor {
            path,
            previous_path,
            status,
            similarity,
            index_only,
        });
    }
    Ok(changes)
}

fn untracked_paths(repository_root: &Path) -> Result<Vec<String>, WorktreeError> {
    let output = run_git(
        repository_root,
        "列出未跟踪文件",
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    )?;
    let mut paths = nul_terminated_utf8(&output.stdout, "列出未跟踪文件")?;
    paths.retain(|path| !path.is_empty());
    for path in &paths {
        ensure_relative_git_path(path, "列出未跟踪文件")?;
    }
    Ok(paths)
}

fn unmerged_paths(repository_root: &Path) -> Result<Vec<String>, WorktreeError> {
    let output = run_git(
        repository_root,
        "读取未解决冲突",
        ["ls-files", "--unmerged", "-z", "--"],
    )?;
    let mut paths = BTreeSet::new();
    for record in output.stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let separator = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| WorktreeError::InvalidGitOutput {
                operation: "读取未解决冲突",
                detail: "索引冲突记录缺少文件路径".into(),
            })?;
        let path = &record[separator + 1..];
        let path =
            String::from_utf8(path.to_vec()).map_err(|_| WorktreeError::InvalidGitOutput {
                operation: "读取未解决冲突",
                detail: "冲突文件路径不是 UTF-8".into(),
            })?;
        ensure_relative_git_path(&path, "读取未解决冲突")?;
        paths.insert(path);
    }
    Ok(paths.into_iter().collect())
}

fn file_diff(
    repository_root: &Path,
    baseline_revision: &str,
    change: &ChangeDescriptor,
) -> Result<FileDiff, WorktreeError> {
    if change.status == FileStatus::Untracked {
        return untracked_file_diff(repository_root, &change.path);
    }
    if change.status == FileStatus::Unmerged {
        return Ok(FileDiff::Unavailable {
            reason: "文件存在未解决的 Git 冲突".into(),
        });
    }

    let paths = diff_paths(change);
    let status_filter = format!("--diff-filter={}", diff_filter_code(change.status));
    let statistics = diff_statistics(
        repository_root,
        baseline_revision,
        &status_filter,
        &paths,
        change.index_only,
    )?;
    if statistics.binary {
        return Ok(FileDiff::Binary);
    }
    if paths_exceed_diff_limit(repository_root, baseline_revision, change)? {
        return Ok(FileDiff::TooLarge {
            max_bytes: MAX_TEXT_DIFF_BYTES,
        });
    }

    let mut args: Vec<String> = vec!["diff".into()];
    if change.index_only {
        args.push("--cached".into());
    }
    args.extend([
        "--patch".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--find-renames=50%".into(),
        "--find-copies=50%".into(),
        status_filter,
        "--unified=3".into(),
        baseline_revision.into(),
        "--".into(),
    ]);
    args.extend(paths.iter().cloned());
    let output = run_git(repository_root, "读取文件差异", args)?;
    let patch = match String::from_utf8(output.stdout) {
        Ok(patch) => patch,
        Err(_) => return Ok(FileDiff::Binary),
    };
    ensure_diff_materialization_budget(patch.lines().count() as u64, patch.len() as u64)?;
    let hunks = parse_unified_hunks(&patch)?;
    Ok(FileDiff::Text {
        additions: statistics.additions,
        deletions: statistics.deletions,
        hunks,
    })
}

fn diff_paths(change: &ChangeDescriptor) -> Vec<String> {
    let mut paths = Vec::with_capacity(2);
    if let Some(previous_path) = &change.previous_path {
        paths.push(previous_path.clone());
    }
    paths.push(change.path.clone());
    paths
}

fn diff_filter_code(status: FileStatus) -> char {
    match status {
        FileStatus::Added => 'A',
        FileStatus::Modified => 'M',
        FileStatus::Deleted => 'D',
        FileStatus::Renamed => 'R',
        FileStatus::Copied => 'C',
        FileStatus::TypeChanged => 'T',
        FileStatus::Unmerged => 'U',
        FileStatus::Untracked => unreachable!("untracked files do not use git diff"),
    }
}

#[derive(Default)]
struct DiffStatistics {
    additions: u64,
    deletions: u64,
    binary: bool,
}

fn diff_statistics(
    repository_root: &Path,
    baseline_revision: &str,
    status_filter: &str,
    paths: &[String],
    index_only: bool,
) -> Result<DiffStatistics, WorktreeError> {
    let mut args: Vec<String> = vec!["diff".into()];
    if index_only {
        args.push("--cached".into());
    }
    args.extend([
        "--numstat".into(),
        "-z".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--find-renames=50%".into(),
        "--find-copies=50%".into(),
        status_filter.into(),
        baseline_revision.into(),
        "--".into(),
    ]);
    args.extend(paths.iter().cloned());
    let output = run_git(repository_root, "统计文件差异", args)?;
    let mut statistics = DiffStatistics::default();
    for field in output.stdout.split(|byte| *byte == 0) {
        let mut columns = field.splitn(3, |byte| *byte == b'\t');
        let Some(additions) = columns.next() else {
            continue;
        };
        let Some(deletions) = columns.next() else {
            continue;
        };
        if additions == b"-" || deletions == b"-" {
            statistics.binary = true;
            continue;
        }
        statistics.additions += parse_ascii_u64(additions, "统计文件差异")?;
        statistics.deletions += parse_ascii_u64(deletions, "统计文件差异")?;
    }
    Ok(statistics)
}

fn paths_exceed_diff_limit(
    repository_root: &Path,
    baseline_revision: &str,
    change: &ChangeDescriptor,
) -> Result<bool, WorktreeError> {
    if change.status != FileStatus::Deleted {
        if change.index_only {
            if git_index_object_size(repository_root, &change.path)?
                .is_some_and(|size| size > MAX_TEXT_DIFF_BYTES)
            {
                return Ok(true);
            }
        } else {
            let path = repository_root.join(&change.path);
            match fs::symlink_metadata(&path) {
                Ok(metadata)
                    if metadata.file_type().is_file() && metadata.len() > MAX_TEXT_DIFF_BYTES =>
                {
                    return Ok(true)
                }
                Ok(_) | Err(_) => {}
            }
        }
    }
    if change.status != FileStatus::Added {
        let old_path = change.previous_path.as_deref().unwrap_or(&change.path);
        if git_object_size(repository_root, baseline_revision, old_path)?
            .is_some_and(|size| size > MAX_TEXT_DIFF_BYTES)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn git_object_size(
    repository_root: &Path,
    baseline_revision: &str,
    path: &str,
) -> Result<Option<u64>, WorktreeError> {
    let object = format!("{baseline_revision}:{path}");
    git_object_size_by_spec(repository_root, &object, "读取基线文件大小")
}

fn git_index_object_size(repository_root: &Path, path: &str) -> Result<Option<u64>, WorktreeError> {
    let object = format!(":{path}");
    git_object_size_by_spec(repository_root, &object, "读取暂存区文件大小")
}

fn git_object_size_by_spec(
    repository_root: &Path,
    object: &str,
    operation: &'static str,
) -> Result<Option<u64>, WorktreeError> {
    let output = run_git_raw(repository_root, ["cat-file", "-s", object])?;
    if !output.status.success() {
        return Ok(None);
    }
    let size = trimmed_utf8(&output.stdout, operation)?
        .parse::<u64>()
        .map_err(|_| WorktreeError::InvalidGitOutput {
            operation,
            detail: "文件大小不是整数".into(),
        })?;
    Ok(Some(size))
}

fn untracked_file_diff(repository_root: &Path, path: &str) -> Result<FileDiff, WorktreeError> {
    untracked_file_diff_with_hook(repository_root, path, || {})
}

fn untracked_file_diff_with_hook<F>(
    repository_root: &Path,
    path: &str,
    before_read: F,
) -> Result<FileDiff, WorktreeError>
where
    F: FnOnce(),
{
    let absolute = repository_root.join(path);
    if let Some(reason) = unsafe_untracked_path_reason(repository_root, path)? {
        return Ok(FileDiff::Unavailable {
            reason: reason.into(),
        });
    }

    // std::fs cannot atomically open every component without following links. The repeated
    // path and file-identity checks below narrow, but cannot eliminate, that TOCTOU window.
    let file = match fs::File::open(&absolute) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(FileDiff::Unavailable {
                reason: "文件在检查期间已移动或删除".into(),
            })
        }
        Err(source) => {
            return Err(WorktreeError::PathUnavailable {
                path: absolute.clone(),
                source,
            })
        }
    };
    let opened_metadata = file
        .metadata()
        .map_err(|source| WorktreeError::PathUnavailable {
            path: absolute.clone(),
            source,
        })?;
    if !opened_metadata.file_type().is_file() {
        return Ok(FileDiff::Unavailable {
            reason: "路径不是普通文件".into(),
        });
    }
    if opened_metadata.len() > MAX_TEXT_DIFF_BYTES {
        return Ok(FileDiff::TooLarge {
            max_bytes: MAX_TEXT_DIFF_BYTES,
        });
    }
    let path_metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(FileDiff::Unavailable {
                reason: "文件在检查期间已移动或删除".into(),
            })
        }
        Err(source) => {
            return Err(WorktreeError::PathUnavailable {
                path: absolute.clone(),
                source,
            })
        }
    };
    if path_metadata.file_type().is_symlink()
        || !path_metadata.file_type().is_file()
        || !same_file_identity(&opened_metadata, &path_metadata)
    {
        return Ok(FileDiff::Unavailable {
            reason: "文件路径在打开期间发生变化或指向符号链接".into(),
        });
    }

    before_read();
    let mut bytes = Vec::with_capacity(
        opened_metadata
            .len()
            .min(MAX_TEXT_DIFF_BYTES)
            .saturating_add(1) as usize,
    );
    file.take(MAX_TEXT_DIFF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| WorktreeError::PathUnavailable {
            path: absolute.clone(),
            source,
        })?;
    if bytes.len() as u64 > MAX_TEXT_DIFF_BYTES {
        return Ok(FileDiff::TooLarge {
            max_bytes: MAX_TEXT_DIFF_BYTES,
        });
    }

    let final_metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(FileDiff::Unavailable {
                reason: "文件在检查期间已移动或删除".into(),
            })
        }
        Err(source) => {
            return Err(WorktreeError::PathUnavailable {
                path: absolute.clone(),
                source,
            })
        }
    };
    if final_metadata.file_type().is_symlink()
        || !final_metadata.file_type().is_file()
        || !same_file_identity(&opened_metadata, &final_metadata)
    {
        return Ok(FileDiff::Unavailable {
            reason: "文件路径在读取期间发生变化或指向符号链接".into(),
        });
    }
    if final_metadata.len() > MAX_TEXT_DIFF_BYTES {
        return Ok(FileDiff::TooLarge {
            max_bytes: MAX_TEXT_DIFF_BYTES,
        });
    }
    if bytes.contains(&0) {
        return Ok(FileDiff::Binary);
    }
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return Ok(FileDiff::Binary),
    };
    let diff_lines = if text.is_empty() {
        0
    } else {
        text.split_terminator('\n').count() as u64 + u64::from(!text.ends_with('\n'))
    };
    ensure_diff_materialization_budget(diff_lines, text.len() as u64)?;
    Ok(added_text_diff(&text))
}

fn unsafe_untracked_path_reason(
    repository_root: &Path,
    path: &str,
) -> Result<Option<&'static str>, WorktreeError> {
    ensure_relative_git_path(path, "读取未跟踪文件")?;
    let mut current = repository_root.to_path_buf();
    let mut components = Path::new(path).components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(WorktreeError::InvalidGitOutput {
                operation: "读取未跟踪文件",
                detail: format!("Git 返回了不安全的相对路径：{path:?}"),
            });
        };
        current.push(name);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Some("文件在检查期间已移动或删除"))
            }
            Err(source) => {
                return Err(WorktreeError::PathUnavailable {
                    path: current,
                    source,
                })
            }
        };
        if metadata.file_type().is_symlink() {
            return Ok(Some("未跟踪路径包含符号链接，已拒绝读取"));
        }
        if components.peek().is_some() && !metadata.file_type().is_dir() {
            return Ok(Some("未跟踪路径的中间组件不是目录"));
        }
        if components.peek().is_none() && !metadata.file_type().is_file() {
            return Ok(Some("未跟踪路径不是普通文件"));
        }
    }
    Ok(None)
}

#[cfg(unix)]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.file_type() == right.file_type()
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
}

fn added_text_diff(text: &str) -> FileDiff {
    if text.is_empty() {
        return FileDiff::Text {
            additions: 0,
            deletions: 0,
            hunks: Vec::new(),
        };
    }
    let mut lines = Vec::new();
    for (index, line) in text.split_terminator('\n').enumerate() {
        lines.push(DiffLine {
            kind: DiffLineKind::Addition,
            content: line.to_string(),
            old_line: None,
            new_line: Some(index as u64 + 1),
        });
    }
    let additions = lines.len() as u64;
    if !text.ends_with('\n') {
        lines.push(DiffLine {
            kind: DiffLineKind::NoNewlineMarker,
            content: "No newline at end of file".into(),
            old_line: None,
            new_line: None,
        });
    }
    FileDiff::Text {
        additions,
        deletions: 0,
        hunks: vec![DiffHunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: additions,
            heading: String::new(),
            lines,
        }],
    }
}

fn parse_unified_hunks(patch: &str) -> Result<Vec<DiffHunk>, WorktreeError> {
    let mut hunks = Vec::new();
    let mut current: Option<(DiffHunk, u64, u64)> = None;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            if let Some((hunk, _, _)) = current.take() {
                hunks.push(hunk);
            }
            continue;
        }
        if line.starts_with("@@ ") {
            if let Some((hunk, _, _)) = current.take() {
                hunks.push(hunk);
            }
            let (old_start, old_lines, new_start, new_lines, heading) = parse_hunk_header(line)?;
            current = Some((
                DiffHunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    heading,
                    lines: Vec::new(),
                },
                old_start,
                new_start,
            ));
            continue;
        }
        let Some((hunk, old_line, new_line)) = current.as_mut() else {
            continue;
        };
        let Some(marker) = line.as_bytes().first().copied() else {
            continue;
        };
        let content = line.get(1..).unwrap_or_default().to_string();
        match marker {
            b' ' => {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    content,
                    old_line: Some(*old_line),
                    new_line: Some(*new_line),
                });
                *old_line += 1;
                *new_line += 1;
            }
            b'+' => {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Addition,
                    content,
                    old_line: None,
                    new_line: Some(*new_line),
                });
                *new_line += 1;
            }
            b'-' => {
                hunk.lines.push(DiffLine {
                    kind: DiffLineKind::Deletion,
                    content,
                    old_line: Some(*old_line),
                    new_line: None,
                });
                *old_line += 1;
            }
            b'\\' => hunk.lines.push(DiffLine {
                kind: DiffLineKind::NoNewlineMarker,
                content: content.trim_start().to_string(),
                old_line: None,
                new_line: None,
            }),
            _ => {}
        }
    }
    if let Some((hunk, _, _)) = current {
        hunks.push(hunk);
    }
    Ok(hunks)
}

fn parse_hunk_header(line: &str) -> Result<(u64, u64, u64, u64, String), WorktreeError> {
    let body = line
        .strip_prefix("@@ -")
        .ok_or_else(|| invalid_hunk(line))?;
    let (ranges, heading) = body.split_once(" @@").ok_or_else(|| invalid_hunk(line))?;
    let (old_range, new_range) = ranges.split_once(" +").ok_or_else(|| invalid_hunk(line))?;
    let (old_start, old_lines) = parse_hunk_range(old_range).ok_or_else(|| invalid_hunk(line))?;
    let (new_start, new_lines) = parse_hunk_range(new_range).ok_or_else(|| invalid_hunk(line))?;
    Ok((
        old_start,
        old_lines,
        new_start,
        new_lines,
        heading.strip_prefix(' ').unwrap_or(heading).to_string(),
    ))
}

fn parse_hunk_range(range: &str) -> Option<(u64, u64)> {
    match range.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((range.parse().ok()?, 1)),
    }
}

fn invalid_hunk(line: &str) -> WorktreeError {
    WorktreeError::InvalidGitOutput {
        operation: "解析文件差异",
        detail: format!("无效的 hunk 头：{line}"),
    }
}

fn resolve_revision(repository_root: &Path, revision: &str) -> Result<String, WorktreeError> {
    try_resolve_revision(repository_root, revision)?
        .ok_or_else(|| WorktreeError::InvalidRevision(revision.to_string()))
}

fn try_resolve_revision(
    repository_root: &Path,
    revision: &str,
) -> Result<Option<String>, WorktreeError> {
    if revision.is_empty() || revision.contains('\0') {
        return Ok(None);
    }
    let commit = format!("{revision}^{{commit}}");
    let output = run_git_raw(
        repository_root,
        [
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new("--end-of-options"),
            OsStr::new(&commit),
        ],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let oid = trimmed_utf8(&output.stdout, "解析 Git 基线")?;
    if oid.len() < 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorktreeError::InvalidGitOutput {
            operation: "解析 Git 基线",
            detail: "Git 未返回完整对象 ID".into(),
        });
    }
    Ok(Some(oid.to_ascii_lowercase()))
}

fn ensure_relative_git_path(path: &str, operation: &'static str) -> Result<(), WorktreeError> {
    if path.is_empty()
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(WorktreeError::InvalidGitOutput {
            operation,
            detail: format!("Git 返回了不安全的相对路径：{path:?}"),
        });
    }
    Ok(())
}

fn parse_ascii_u64(bytes: &[u8], operation: &'static str) -> Result<u64, WorktreeError> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| WorktreeError::InvalidGitOutput {
            operation,
            detail: "增删行数不是整数".into(),
        })
}

fn nul_terminated_utf8(
    output: &[u8],
    operation: &'static str,
) -> Result<Vec<String>, WorktreeError> {
    output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| {
            String::from_utf8(field.to_vec()).map_err(|_| WorktreeError::InvalidGitOutput {
                operation,
                detail: "文件路径不是 UTF-8".into(),
            })
        })
        .collect()
}

fn trimmed_utf8<'a>(output: &'a [u8], operation: &'static str) -> Result<&'a str, WorktreeError> {
    std::str::from_utf8(output)
        .map(str::trim)
        .map_err(|_| WorktreeError::InvalidGitOutput {
            operation,
            detail: "输出不是 UTF-8".into(),
        })
}

fn run_git<I, S>(
    repository_root: &Path,
    operation: &'static str,
    args: I,
) -> Result<Output, WorktreeError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_raw(repository_root, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

fn run_git_raw<I, S>(repository_root: &Path, args: I) -> Result<Output, WorktreeError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new("git")
        .arg("--no-pager")
        .arg("--literal-pathspecs")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-C")
        .arg(repository_root)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_PREFIX")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .output()
        .map_err(WorktreeError::GitUnavailable)
}

fn stderr_detail(output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        format!("退出码 {}", output.status)
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::{
        capture_task_baseline, inspect_changes_from_revision, inspect_changes_from_task_baseline,
        inspect_resolved_revision_with_hook, parse_unified_hunks, untracked_file_diff,
        untracked_file_diff_with_hook, validate_git_workspace, DiffLineKind, FileDiff, FileStatus,
        TaskBaseline, WorktreeError, MAX_INSPECTION_DIFF_LINES, MAX_INSPECTION_FILES,
        MAX_TEXT_DIFF_BYTES,
    };
    use std::{
        ffi::OsStr,
        fs,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRepository(PathBuf);

    impl TestRepository {
        fn new() -> Self {
            let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("joydsh-worktree-test-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            let repository = Self(path);
            repository.git(["init", "--quiet"]);
            repository
        }

        fn git<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .env("LC_ALL", "C")
                .env("GIT_AUTHOR_NAME", "JoyDSH tests")
                .env("GIT_AUTHOR_EMAIL", "joydsh-tests@example.invalid")
                .env("GIT_COMMITTER_NAME", "JoyDSH tests")
                .env("GIT_COMMITTER_EMAIL", "joydsh-tests@example.invalid")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }

        fn git_must_fail<I, S>(&self, args: I)
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .env("LC_ALL", "C")
                .env("GIT_AUTHOR_NAME", "JoyDSH tests")
                .env("GIT_AUTHOR_EMAIL", "joydsh-tests@example.invalid")
                .env("GIT_COMMITTER_NAME", "JoyDSH tests")
                .env("GIT_COMMITTER_EMAIL", "joydsh-tests@example.invalid")
                .env("GIT_MERGE_AUTOEDIT", "no")
                .output()
                .unwrap();
            assert!(
                !output.status.success(),
                "git unexpectedly succeeded: {}",
                String::from_utf8_lossy(&output.stdout)
            );
        }

        fn commit_all(&self, message: &str) -> String {
            self.git(["add", "--all"]);
            self.git(["commit", "--quiet", "-m", message]);
            self.git(["rev-parse", "HEAD"])
        }
    }

    impl Drop for TestRepository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn change<'a>(inspection: &'a super::WorktreeInspection, path: &str) -> &'a super::FileChange {
        inspection
            .changes
            .iter()
            .find(|change| change.path == path)
            .unwrap_or_else(|| panic!("missing change {path:?}: {:?}", inspection.changes))
    }

    #[test]
    fn validates_a_repository_from_a_nested_directory() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("README.md"), "hello\n").unwrap();
        let revision = repository.commit_all("initial");
        let nested = repository.0.join("nested folder");
        fs::create_dir(&nested).unwrap();

        let workspace = validate_git_workspace(&nested).unwrap();

        assert_eq!(
            workspace.repository_root,
            fs::canonicalize(&repository.0).unwrap()
        );
        assert_eq!(workspace.head_revision.as_deref(), Some(revision.as_str()));
    }

    #[test]
    fn rejects_a_non_repository() {
        let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "joydsh-worktree-not-git-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();

        let error = validate_git_workspace(&path).unwrap_err();

        assert!(matches!(error, WorktreeError::NotGitWorkspace { .. }));
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn task_baseline_requires_a_clean_committed_workspace() {
        let repository = TestRepository::new();
        assert!(matches!(
            capture_task_baseline(&repository.0).unwrap_err(),
            WorktreeError::InvalidRevision(_)
        ));
        fs::write(repository.0.join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        fs::write(repository.0.join("untracked.txt"), "before task\n").unwrap();

        assert!(matches!(
            capture_task_baseline(&repository.0).unwrap_err(),
            WorktreeError::DirtyTaskBaseline
        ));
    }

    #[test]
    fn task_baseline_round_trips_for_persistence() {
        let baseline = TaskBaseline {
            repository_root: PathBuf::from("/workspace/project"),
            revision: "0123456789012345678901234567890123456789".into(),
            captured_at: 1_787_788_800_000,
        };

        let json = serde_json::to_string(&baseline).unwrap();
        let restored: TaskBaseline = serde_json::from_str(&json).unwrap();

        assert_eq!(restored, baseline);
        assert!(json.contains("repositoryRoot"));
        assert!(json.contains("capturedAt"));
    }

    #[test]
    fn task_baseline_without_capture_time_is_rejected_as_corrupt() {
        let json = r#"{
            "repositoryRoot": "/workspace/project",
            "revision": "0123456789012345678901234567890123456789"
        }"#;

        let error = serde_json::from_str::<TaskBaseline>(json).unwrap_err();

        assert!(error.to_string().contains("capturedAt"));
    }

    #[test]
    fn reports_baseline_relative_statuses_and_structured_text_diffs() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("modified.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(repository.0.join("deleted.txt"), "remove me\n").unwrap();
        fs::write(repository.0.join("old-name.txt"), "rename me\n").unwrap();
        fs::write(repository.0.join("binary.dat"), [0, 1, 2, 3]).unwrap();
        let baseline = repository.commit_all("initial");

        fs::write(repository.0.join("modified.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        fs::remove_file(repository.0.join("deleted.txt")).unwrap();
        repository.git(["mv", "old-name.txt", "new-name.txt"]);
        fs::write(repository.0.join("binary.dat"), [0, 9, 2, 3]).unwrap();
        fs::write(repository.0.join("new file.txt"), "alpha\nbeta").unwrap();

        let inspection = inspect_changes_from_revision(&repository.0, &baseline).unwrap();

        assert!(!inspection.clean);
        assert_eq!(
            change(&inspection, "deleted.txt").status,
            FileStatus::Deleted
        );
        assert_eq!(
            change(&inspection, "modified.txt").status,
            FileStatus::Modified
        );
        assert_eq!(
            change(&inspection, "new file.txt").status,
            FileStatus::Untracked
        );
        assert_eq!(
            change(&inspection, "new-name.txt").status,
            FileStatus::Renamed
        );
        assert_eq!(
            change(&inspection, "new-name.txt").previous_path.as_deref(),
            Some("old-name.txt")
        );
        assert_eq!(change(&inspection, "binary.dat").diff, FileDiff::Binary);

        let FileDiff::Text {
            additions,
            deletions,
            hunks,
        } = &change(&inspection, "modified.txt").diff
        else {
            panic!("modified text must have a text diff")
        };
        assert_eq!((*additions, *deletions), (2, 1));
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == DiffLineKind::Deletion
                && line.old_line == Some(2)
                && line.content == "two"));
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == DiffLineKind::Addition
                && line.new_line == Some(2)
                && line.content == "TWO"));

        let FileDiff::Text {
            additions,
            deletions,
            hunks,
        } = &change(&inspection, "new file.txt").diff
        else {
            panic!("untracked text must have a text diff")
        };
        assert_eq!((*additions, *deletions), (2, 0));
        assert_eq!(hunks[0].old_start, 0);
        assert_eq!(hunks[0].new_start, 1);
        assert_eq!(
            hunks[0].lines.last().unwrap().kind,
            DiffLineKind::NoNewlineMarker
        );
    }

    #[test]
    fn reports_an_index_only_change_with_its_staged_diff() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("tracked.txt"), "before\n").unwrap();
        let baseline = repository.commit_all("initial");
        fs::write(repository.0.join("tracked.txt"), "staged only\n").unwrap();
        repository.git(["add", "tracked.txt"]);
        fs::write(repository.0.join("tracked.txt"), "before\n").unwrap();

        let inspection = inspect_changes_from_revision(&repository.0, &baseline).unwrap();

        assert_eq!(inspection.changes.len(), 1);
        let staged = change(&inspection, "tracked.txt");
        assert_eq!(staged.status, FileStatus::Modified);
        let FileDiff::Text {
            additions,
            deletions,
            hunks,
        } = &staged.diff
        else {
            panic!("index-only text must have a text diff")
        };
        assert_eq!((*additions, *deletions), (1, 1));
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| { line.kind == DiffLineKind::Addition && line.content == "staged only" }));
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| { line.kind == DiffLineKind::Deletion && line.content == "before" }));
    }

    #[test]
    fn reports_a_staged_and_worktree_change_once_using_the_worktree_diff() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("tracked.txt"), "before\n").unwrap();
        let baseline = repository.commit_all("initial");
        fs::write(repository.0.join("tracked.txt"), "staged\n").unwrap();
        repository.git(["add", "tracked.txt"]);
        fs::write(repository.0.join("tracked.txt"), "worktree\n").unwrap();

        let inspection = inspect_changes_from_revision(&repository.0, &baseline).unwrap();

        assert_eq!(inspection.changes.len(), 1);
        let FileDiff::Text { hunks, .. } = &inspection.changes[0].diff else {
            panic!("tracked text must have a text diff")
        };
        assert!(hunks[0]
            .lines
            .iter()
            .any(|line| { line.kind == DiffLineKind::Addition && line.content == "worktree" }));
        assert!(!hunks[0]
            .lines
            .iter()
            .any(|line| line.kind == DiffLineKind::Addition && line.content == "staged"));
    }

    #[test]
    fn rejects_an_inspection_when_the_worktree_changes_before_validation() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("tracked.txt"), "base\n").unwrap();
        let baseline = repository.commit_all("initial");
        fs::write(repository.0.join("tracked.txt"), "before\n").unwrap();
        let workspace = validate_git_workspace(&repository.0).unwrap();

        let error = inspect_resolved_revision_with_hook(workspace, baseline, || {
            fs::write(repository.0.join("tracked.txt"), "after!\n").unwrap();
        })
        .unwrap_err();

        assert!(matches!(
            error,
            WorktreeError::RepositoryChangedDuringInspection
        ));
    }

    #[test]
    fn bounds_an_untracked_file_that_grows_after_it_is_opened() {
        let repository = TestRepository::new();
        let path = repository.0.join("growing.txt");
        fs::write(&path, "small\n").unwrap();

        let diff = untracked_file_diff_with_hook(&repository.0, "growing.txt", || {
            fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(MAX_TEXT_DIFF_BYTES + 1)
                .unwrap();
        })
        .unwrap();

        assert_eq!(
            diff,
            FileDiff::TooLarge {
                max_bytes: MAX_TEXT_DIFF_BYTES
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_read_an_untracked_symbolic_link() {
        use std::os::unix::fs::symlink;

        let repository = TestRepository::new();
        fs::write(repository.0.join("target.txt"), "secret\n").unwrap();
        symlink("target.txt", repository.0.join("link.txt")).unwrap();

        let diff = untracked_file_diff(&repository.0, "link.txt").unwrap();

        assert!(matches!(
            diff,
            FileDiff::Unavailable { reason } if reason.contains("符号链接")
        ));
    }

    #[test]
    fn rejects_an_inspection_that_exceeds_the_file_count_budget() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("tracked.txt"), "base\n").unwrap();
        let baseline = repository.commit_all("initial");
        for index in 0..=MAX_INSPECTION_FILES {
            fs::write(
                repository.0.join(format!("untracked-{index:04}.txt")),
                "x\n",
            )
            .unwrap();
        }

        let error = inspect_changes_from_revision(&repository.0, &baseline).unwrap_err();

        assert!(matches!(
            error,
            WorktreeError::InspectionLimitExceeded {
                resource: "文件数",
                ..
            }
        ));
    }

    #[test]
    fn rejects_an_inspection_that_exceeds_the_total_diff_line_budget() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("tracked.txt"), "base\n").unwrap();
        let baseline = repository.commit_all("initial");
        let lines_per_file = MAX_INSPECTION_DIFF_LINES / 2 + 1;
        let content = "x\n".repeat(lines_per_file as usize);
        fs::write(repository.0.join("first.txt"), &content).unwrap();
        fs::write(repository.0.join("second.txt"), &content).unwrap();

        let error = inspect_changes_from_revision(&repository.0, &baseline).unwrap_err();

        assert!(matches!(
            error,
            WorktreeError::InspectionLimitExceeded {
                resource: "diff 行数",
                ..
            }
        ));
    }

    #[test]
    fn a_copied_file_diff_does_not_include_changes_to_its_source() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("source.txt"), "base\n").unwrap();
        let baseline = repository.commit_all("initial");
        fs::copy(
            repository.0.join("source.txt"),
            repository.0.join("copy.txt"),
        )
        .unwrap();
        repository.git(["add", "copy.txt"]);
        fs::write(repository.0.join("source.txt"), "source changed\n").unwrap();

        let inspection = inspect_changes_from_revision(&repository.0, &baseline).unwrap();

        assert_eq!(change(&inspection, "copy.txt").status, FileStatus::Copied);
        let FileDiff::Text {
            additions,
            deletions,
            hunks,
        } = &change(&inspection, "copy.txt").diff
        else {
            panic!("copied text must have a text diff")
        };
        assert_eq!((*additions, *deletions), (0, 0));
        assert!(hunks.is_empty());
        let FileDiff::Text {
            additions,
            deletions,
            ..
        } = &change(&inspection, "source.txt").diff
        else {
            panic!("modified source must have a text diff")
        };
        assert_eq!((*additions, *deletions), (1, 1));
    }

    #[test]
    fn reports_index_conflicts_as_unmerged_instead_of_modified() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("conflict.txt"), "base\n").unwrap();
        let baseline = repository.commit_all("initial");
        let main_branch = repository.git(["branch", "--show-current"]);
        repository.git(["checkout", "--quiet", "-b", "conflict-side"]);
        fs::write(repository.0.join("conflict.txt"), "side\n").unwrap();
        repository.commit_all("side change");
        repository.git(["checkout", "--quiet", main_branch.as_str()]);
        fs::write(repository.0.join("conflict.txt"), "main\n").unwrap();
        repository.commit_all("main change");
        repository.git_must_fail(["merge", "--no-edit", "conflict-side"]);

        let inspection = inspect_changes_from_revision(&repository.0, &baseline).unwrap();

        let conflict = change(&inspection, "conflict.txt");
        assert_eq!(conflict.status, FileStatus::Unmerged);
        assert!(matches!(conflict.diff, FileDiff::Unavailable { .. }));
    }

    #[test]
    fn a_task_baseline_can_be_used_after_head_advances() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("result.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = capture_task_baseline(&repository.0).unwrap();
        assert!(baseline.captured_at > 1_000_000_000_000);
        fs::write(repository.0.join("result.txt"), "task result\n").unwrap();
        repository.commit_all("task commit");

        let inspection = inspect_changes_from_task_baseline(&repository.0, &baseline).unwrap();

        assert_eq!(inspection.changes.len(), 1);
        assert_eq!(inspection.changes[0].path, "result.txt");
        assert_eq!(inspection.changes[0].status, FileStatus::Modified);
    }

    #[test]
    fn revision_arguments_cannot_be_interpreted_as_git_options() {
        let repository = TestRepository::new();
        fs::write(repository.0.join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");

        let error = inspect_changes_from_revision(&repository.0, "--help").unwrap_err();

        assert!(matches!(error, WorktreeError::InvalidRevision(revision) if revision == "--help"));
    }

    #[cfg(not(windows))]
    #[test]
    fn git_paths_are_always_reused_as_literal_pathspecs() {
        let repository = TestRepository::new();
        let magic_path = ":(glob)*.txt";
        fs::write(repository.0.join(magic_path), "magic base\n").unwrap();
        fs::write(repository.0.join("other.txt"), "other base\n").unwrap();
        let baseline = repository.commit_all("initial");
        fs::write(repository.0.join(magic_path), "magic changed\n").unwrap();
        fs::write(repository.0.join("other.txt"), "other changed\n").unwrap();

        let inspection = inspect_changes_from_revision(&repository.0, &baseline).unwrap();

        let FileDiff::Text {
            additions,
            deletions,
            ..
        } = &change(&inspection, magic_path).diff
        else {
            panic!("magic path must have a text diff")
        };
        assert_eq!((*additions, *deletions), (1, 1));
    }

    #[test]
    fn parses_single_line_and_empty_ranges_in_hunk_headers() {
        let hunks = parse_unified_hunks(
            "diff --git a/a b/a\n@@ -1 +1,2 @@ heading\n old\n+new\n@@ -3,0 +5 @@\n+tail\n",
        )
        .unwrap();

        assert_eq!((hunks[0].old_start, hunks[0].old_lines), (1, 1));
        assert_eq!((hunks[0].new_start, hunks[0].new_lines), (1, 2));
        assert_eq!(hunks[0].heading, "heading");
        assert_eq!((hunks[1].old_start, hunks[1].old_lines), (3, 0));
        assert_eq!((hunks[1].new_start, hunks[1].new_lines), (5, 1));
    }

    #[test]
    fn separates_hunks_from_adjacent_file_patches() {
        let hunks = parse_unified_hunks(
            "diff --git a/a b/a\n@@ -0,0 +1 @@\n+first\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1 @@\n+second\n",
        )
        .unwrap();

        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].lines.len(), 1);
        assert_eq!(hunks[0].lines[0].content, "first");
        assert_eq!(hunks[1].lines.len(), 1);
        assert_eq!(hunks[1].lines[0].content, "second");
    }

    #[test]
    fn rejects_a_task_baseline_from_another_repository() {
        let first = TestRepository::new();
        fs::write(first.0.join("tracked.txt"), "first\n").unwrap();
        first.commit_all("initial");
        let baseline = capture_task_baseline(&first.0).unwrap();
        let second = TestRepository::new();
        fs::write(second.0.join("tracked.txt"), "second\n").unwrap();
        second.commit_all("initial");

        let error = inspect_changes_from_task_baseline(&second.0, &baseline).unwrap_err();

        assert!(matches!(
            error,
            WorktreeError::BaselineRepositoryMismatch { .. }
        ));
    }
}
