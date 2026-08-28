use crate::worktree::{validate_git_workspace, FileStatus, TaskBaseline, WorktreeError};
use crate::worktree_mutations::{capture_task_change_snapshots, WorktreeMutationError};
#[cfg(unix)]
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    fmt, fs, io,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Mutex, OnceLock},
};

#[cfg(unix)]
use rustix::{
    fd::OwnedFd,
    fs::{
        fchmod, fstat, fsync, mkdirat, open, openat, readlinkat, renameat, renameat_with, statat,
        unlinkat, AtFlags, FileType, Mode, OFlags, RenameFlags,
    },
    io::{dup, fcntl_setfd, Errno, FdFlags},
};
#[cfg(unix)]
use std::{
    os::fd::{AsRawFd, BorrowedFd},
    os::unix::process::CommandExt,
};

const JOURNAL_VERSION: u32 = 1;
const JOURNAL_ROOT_NAME: &str = "joydsh-commit-journals";
const INTENT_FILE_NAME: &str = "intent.json";
const JOURNAL_FILE_NAME: &str = "journal.json";
const PREPARED_INDEX_FILE_NAME: &str = "prepared.index";
const COMMIT_INDEX_FILE_NAME: &str = "commit.index";
const HEAD_MARKER_FILE_NAME: &str = "head.marker";
const INDEX_MARKER_FILE_NAME: &str = "index.marker";
const HEAD_LOCK_NAME: &str = "HEAD.lock";
const INDEX_NAME: &str = "index";
const INDEX_LOCK_NAME: &str = "index.lock";
const OWNER_LOCK_NAME: &str = "joydsh-commit.lock";
const MAX_ACCEPTED_PATHS: usize = 1_000;
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_COMMIT_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_PENDING_JOURNALS: usize = 32;
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

static COMMIT_PROCESS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcceptedCommitPath {
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) previous_path: Option<String>,
    pub(crate) expected_snapshot_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeCommit {
    pub(crate) revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recovery_journal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) warning: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CommitRecoveryAction {
    DiscardedBeforeRefUpdate,
    InstalledPreparedIndex,
    CompletedAlready,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitRecovery {
    pub(crate) journal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) revision: Option<String>,
    pub(crate) action: CommitRecoveryAction,
}

#[derive(Debug)]
pub(crate) enum WorktreeCommitError {
    Workspace(WorktreeError),
    BaselineRepositoryMismatch {
        expected: PathBuf,
        actual: PathBuf,
    },
    HeadChanged {
        expected: String,
        actual: Option<String>,
    },
    DetachedHead,
    BranchChanged,
    EmptySelection,
    TooManyPaths {
        max: usize,
    },
    InvalidCommitMessage(String),
    UnsafePath {
        path: String,
        detail: String,
    },
    OverlappingPaths {
        path: String,
    },
    UnsupportedFileType {
        path: String,
    },
    UnmergedChanges {
        paths: Vec<String>,
    },
    OperationInProgress {
        operation: &'static str,
    },
    RepositoryBusy {
        lock: &'static str,
    },
    IndexChanged,
    ExpectedChangeChanged {
        path: String,
    },
    NothingToCommit,
    #[cfg_attr(unix, allow(dead_code))]
    UnsupportedPlatform {
        platform: &'static str,
    },
    ResourceLimit {
        resource: &'static str,
        max: usize,
    },
    RecoveryRequired {
        journal_id: String,
        detail: String,
    },
    PathUnavailable {
        path: PathBuf,
        source: io::Error,
    },
    GitUnavailable(io::Error),
    GitCommand {
        operation: &'static str,
        detail: String,
    },
    InvalidGitOutput {
        operation: &'static str,
        detail: String,
    },
    InvalidIndex(String),
    DamagedJournal {
        journal_id: String,
        detail: String,
    },
}

impl fmt::Display for WorktreeCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workspace(error) => write!(formatter, "无法检查 Git 工作区：{error}"),
            Self::BaselineRepositoryMismatch { expected, actual } => write!(
                formatter,
                "任务基线属于其他 Git 工作区（期望 {}，实际 {}）",
                expected.display(),
                actual.display()
            ),
            Self::HeadChanged { expected, actual } => write!(
                formatter,
                "HEAD 已偏离任务基线（期望 {expected}，实际 {}）",
                actual.as_deref().unwrap_or("无提交")
            ),
            Self::DetachedHead => write!(formatter, "HEAD 未指向符号分支，不能提交任务成果"),
            Self::BranchChanged => write!(formatter, "提交期间当前分支发生变化，请重新检查成果"),
            Self::EmptySelection => write!(formatter, "没有已接受的文件可提交"),
            Self::TooManyPaths { max } => write!(formatter, "已接受文件数超过上限（最多 {max}）"),
            Self::InvalidCommitMessage(detail) => write!(formatter, "提交说明无效：{detail}"),
            Self::UnsafePath { path, detail } => {
                write!(formatter, "拒绝提交不安全的文件路径 {path:?}：{detail}")
            }
            Self::OverlappingPaths { path } => {
                write!(formatter, "已接受文件路径互相重叠或重复：{path}")
            }
            Self::UnsupportedFileType { path } => {
                write!(formatter, "文件类型不支持安全提交：{path}")
            }
            Self::UnmergedChanges { paths } => write!(
                formatter,
                "工作区存在未解决冲突，不能提交任务成果：{}",
                paths.join("、")
            ),
            Self::OperationInProgress { operation } => {
                write!(formatter, "Git 正在进行{operation}，不能提交任务成果")
            }
            Self::RepositoryBusy { lock } => {
                write!(formatter, "Git {lock} 已被其他操作锁定")
            }
            Self::IndexChanged => write!(formatter, "Git 索引在提交期间发生变化"),
            Self::ExpectedChangeChanged { path } => {
                write!(formatter, "已接受成果在提交前发生变化：{path}")
            }
            Self::NothingToCommit => write!(formatter, "已接受文件没有产生可提交内容"),
            Self::UnsupportedPlatform { platform } => {
                write!(formatter, "当前 {platform} 构建尚不支持安全提交事务")
            }
            Self::ResourceLimit { resource, max } => {
                write!(formatter, "{resource}超过资源上限（最多 {max}）")
            }
            Self::RecoveryRequired { journal_id, detail } => write!(
                formatter,
                "提交事务需要恢复（journal {journal_id}）：{detail}"
            ),
            Self::PathUnavailable { path, source } => {
                write!(formatter, "文件路径不可用 {}：{source}", path.display())
            }
            Self::GitUnavailable(error) => write!(formatter, "无法运行 Git：{error}"),
            Self::GitCommand { operation, detail } => {
                write!(formatter, "Git {operation}失败：{detail}")
            }
            Self::InvalidGitOutput { operation, detail } => {
                write!(formatter, "Git {operation}输出无效：{detail}")
            }
            Self::InvalidIndex(detail) => write!(formatter, "Git 索引格式无效：{detail}"),
            Self::DamagedJournal { journal_id, detail } => {
                write!(formatter, "提交恢复 journal {journal_id} 已损坏：{detail}")
            }
        }
    }
}

impl std::error::Error for WorktreeCommitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Workspace(error) => Some(error),
            Self::PathUnavailable { source, .. } | Self::GitUnavailable(source) => Some(source),
            _ => None,
        }
    }
}

impl From<WorktreeError> for WorktreeCommitError {
    fn from(error: WorktreeError) -> Self {
        Self::Workspace(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitIntent {
    version: u32,
    journal_id: String,
    lock_token: String,
    repository_root: PathBuf,
    baseline_revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitJournal {
    version: u32,
    journal_id: String,
    lock_token: String,
    repository_root: PathBuf,
    branch_ref: String,
    baseline_revision: String,
    new_revision: String,
    original_index_sha256: String,
    prepared_index_sha256: String,
    original_index_mode: u16,
    accepted_paths: Vec<AcceptedCommitPath>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CommitFaults {
    pub(crate) stop_after_journal: bool,
    pub(crate) stop_after_ref_update: bool,
    pub(crate) stop_after_index_publish: bool,
}

fn commit_process_lock() -> &'static Mutex<()> {
    COMMIT_PROCESS_LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn commit_accepted_changes(
    workspace_path: &Path,
    baseline: &TaskBaseline,
    accepted_paths: &[AcceptedCommitPath],
    message: &str,
) -> Result<WorktreeCommit, WorktreeCommitError> {
    commit_accepted_changes_with_faults(
        workspace_path,
        baseline,
        accepted_paths,
        message,
        CommitFaults::default(),
    )
}

pub(crate) fn recover_pending_worktree_commits(
    workspace_path: &Path,
) -> Result<Vec<CommitRecovery>, WorktreeCommitError> {
    let _guard = commit_process_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    #[cfg(unix)]
    {
        let capability = open_workspace_capability(workspace_path, None)?;
        let git_directory = GitDirectory::open(&capability)?;
        let owner = RepositoryOwnerLock::acquire(&git_directory)?;
        recover_all_locked(&capability, &git_directory, &owner)
    }
    #[cfg(not(unix))]
    {
        let _ = workspace_path;
        Err(WorktreeCommitError::UnsupportedPlatform {
            platform: std::env::consts::OS,
        })
    }
}

pub(crate) fn commit_accepted_changes_with_faults(
    workspace_path: &Path,
    baseline: &TaskBaseline,
    accepted_paths: &[AcceptedCommitPath],
    message: &str,
    faults: CommitFaults,
) -> Result<WorktreeCommit, WorktreeCommitError> {
    validate_accepted_paths(accepted_paths)?;
    validate_commit_message(message)?;
    let _guard = commit_process_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    #[cfg(unix)]
    {
        commit_accepted_changes_unix(workspace_path, baseline, accepted_paths, message, faults)
    }
    #[cfg(not(unix))]
    {
        let _ = (workspace_path, baseline, accepted_paths, message, faults);
        Err(WorktreeCommitError::UnsupportedPlatform {
            platform: std::env::consts::OS,
        })
    }
}

fn validate_commit_message(message: &str) -> Result<(), WorktreeCommitError> {
    if message.as_bytes().contains(&0) {
        return Err(WorktreeCommitError::InvalidCommitMessage(
            "不能包含 NUL 字节".into(),
        ));
    }
    if message.trim().is_empty() {
        return Err(WorktreeCommitError::InvalidCommitMessage(
            "提交说明不能为空".into(),
        ));
    }
    if message.len() > MAX_COMMIT_MESSAGE_BYTES {
        return Err(WorktreeCommitError::InvalidCommitMessage(format!(
            "最多允许 {MAX_COMMIT_MESSAGE_BYTES} 字节"
        )));
    }
    Ok(())
}

fn validate_accepted_paths(paths: &[AcceptedCommitPath]) -> Result<(), WorktreeCommitError> {
    if paths.is_empty() {
        return Err(WorktreeCommitError::EmptySelection);
    }
    if paths.len() > MAX_ACCEPTED_PATHS {
        return Err(WorktreeCommitError::TooManyPaths {
            max: MAX_ACCEPTED_PATHS,
        });
    }
    let mut seen = BTreeSet::new();
    for accepted in paths {
        validate_relative_path(&accepted.path)?;
        if accepted.expected_snapshot_token.len() != 64
            || !accepted
                .expected_snapshot_token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(WorktreeCommitError::ExpectedChangeChanged {
                path: accepted.path.clone(),
            });
        }
        if !seen.insert(accepted.path.as_str()) {
            return Err(WorktreeCommitError::OverlappingPaths {
                path: accepted.path.clone(),
            });
        }
        if let Some(previous) = accepted.previous_path.as_deref() {
            validate_relative_path(previous)?;
            if !seen.insert(previous) {
                return Err(WorktreeCommitError::OverlappingPaths {
                    path: previous.to_string(),
                });
            }
        }
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), WorktreeCommitError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.as_bytes().contains(&0) {
        return Err(unsafe_path(path, "路径为空、过长或包含 NUL 字节"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(unsafe_path(path, "路径必须相对于工作区"));
    }
    let mut count = 0_usize;
    for component in candidate.components() {
        match component {
            Component::Normal(name) if !name.is_empty() => count += 1,
            _ => return Err(unsafe_path(path, "路径包含 .、..、根目录或平台前缀")),
        }
    }
    if count == 0 {
        return Err(unsafe_path(path, "路径没有文件名"));
    }
    Ok(())
}

fn validate_journal_id(journal_id: &str) -> Result<(), WorktreeCommitError> {
    if journal_id.len() == 32 && journal_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: "journal ID 格式无效".into(),
        })
    }
}

fn unsafe_path(path: &str, detail: impl Into<String>) -> WorktreeCommitError {
    WorktreeCommitError::UnsafePath {
        path: path.to_string(),
        detail: detail.into(),
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct RepositoryCapability {
    canonical_path: PathBuf,
    root: OwnedFd,
    device: u64,
    inode: u64,
    git_metadata: OnceLock<PinnedGitMetadata>,
}

#[cfg(unix)]
#[derive(Debug)]
struct PinnedDirectory {
    path: PathBuf,
    directory: OwnedFd,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl PinnedDirectory {
    fn open(path: PathBuf, label: &'static str) -> Result<Self, WorktreeCommitError> {
        let path = fs::canonicalize(&path)
            .map_err(|source| WorktreeCommitError::PathUnavailable { path, source })?;
        let directory = open_absolute_directory(&path)?;
        let stat = fstat(&directory).map_err(|error| path_errno(label, error))?;
        Ok(Self {
            path,
            directory,
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        })
    }

    fn verify_binding(&self, label: &'static str) -> Result<(), WorktreeCommitError> {
        let current = open_absolute_directory(&self.path)?;
        let stat = fstat(&current).map_err(|error| path_errno(label, error))?;
        if stat.st_dev as u64 != self.device || stat.st_ino != self.inode {
            return Err(unsafe_path(
                self.path.to_string_lossy().as_ref(),
                "Git 元数据目录或其祖先在事务期间发生替换",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct PinnedGitMetadata {
    git: PinnedDirectory,
    common: PinnedDirectory,
}

#[cfg(unix)]
impl PinnedGitMetadata {
    fn verify_bindings(&self) -> Result<(), WorktreeCommitError> {
        self.git.verify_binding("<git-directory>")?;
        self.common.verify_binding("<git-common-directory>")
    }
}

#[cfg(unix)]
impl RepositoryCapability {
    fn open(repository_root: &Path) -> Result<Self, WorktreeCommitError> {
        let canonical_path = fs::canonicalize(repository_root).map_err(|source| {
            WorktreeCommitError::PathUnavailable {
                path: repository_root.to_path_buf(),
                source,
            }
        })?;
        let root = open_absolute_directory(&canonical_path)?;
        let stat = fstat(&root).map_err(|error| path_errno("<repository-root>", error))?;
        let capability = Self {
            canonical_path,
            root,
            device: stat.st_dev as u64,
            inode: stat.st_ino as _,
            git_metadata: OnceLock::new(),
        };
        capability.verify_binding()?;
        Ok(capability)
    }

    fn verify_binding(&self) -> Result<(), WorktreeCommitError> {
        let current = open_absolute_directory(&self.canonical_path)?;
        let stat = fstat(&current).map_err(|error| path_errno("<repository-root>", error))?;
        if stat.st_dev as u64 != self.device || stat.st_ino as u64 != self.inode {
            return Err(unsafe_path(
                self.canonical_path.to_string_lossy().as_ref(),
                "工作区根目录或其祖先在操作期间发生替换",
            ));
        }
        if let Some(metadata) = self.git_metadata.get() {
            metadata.verify_bindings()?;
        }
        Ok(())
    }

    fn pin_git_metadata(&self) -> Result<(), WorktreeCommitError> {
        if self.git_metadata.get().is_some() {
            return Ok(());
        }
        let git_output = run_git(
            self,
            "定位 Git 元数据目录",
            ["rev-parse", "--absolute-git-dir"],
        )?;
        let git_path = PathBuf::from(trimmed_utf8(&git_output.stdout, "定位 Git 元数据目录")?);
        let common_output = run_git(
            self,
            "定位 Git 公共元数据目录",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        let common_path = PathBuf::from(trimmed_utf8(
            &common_output.stdout,
            "定位 Git 公共元数据目录",
        )?);
        if !git_path.is_absolute() || !common_path.is_absolute() {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation: "定位 Git 元数据目录",
                detail: "Git 元数据目录不是绝对路径".into(),
            });
        }
        let metadata = PinnedGitMetadata {
            git: PinnedDirectory::open(git_path, "<git-directory>")?,
            common: PinnedDirectory::open(common_path, "<git-common-directory>")?,
        };
        metadata.verify_bindings()?;
        self.git_metadata
            .set(metadata)
            .map_err(|_| WorktreeCommitError::InvalidGitOutput {
                operation: "固定 Git 元数据目录",
                detail: "Git 元数据目录被重复初始化".into(),
            })?;
        Ok(())
    }

    fn pinned_git_metadata(&self) -> Result<&PinnedGitMetadata, WorktreeCommitError> {
        self.git_metadata
            .get()
            .ok_or_else(|| WorktreeCommitError::InvalidGitOutput {
                operation: "读取固定 Git 元数据目录",
                detail: "Git 元数据目录尚未固定".into(),
            })
    }
}

#[cfg(unix)]
fn open_workspace_capability(
    workspace_path: &Path,
    baseline: Option<&TaskBaseline>,
) -> Result<RepositoryCapability, WorktreeCommitError> {
    let workspace = validate_git_workspace(workspace_path)?;
    if let Some(baseline) = baseline {
        let expected = fs::canonicalize(&baseline.repository_root).map_err(|source| {
            WorktreeCommitError::PathUnavailable {
                path: baseline.repository_root.clone(),
                source,
            }
        })?;
        if workspace.repository_root != expected {
            return Err(WorktreeCommitError::BaselineRepositoryMismatch {
                expected,
                actual: workspace.repository_root,
            });
        }
    }
    let capability = RepositoryCapability::open(&workspace.repository_root)?;
    capability.pin_git_metadata()?;
    Ok(capability)
}

#[cfg(unix)]
fn open_absolute_directory(path: &Path) -> Result<OwnedFd, WorktreeCommitError> {
    if !path.is_absolute() {
        return Err(unsafe_path(
            path.to_string_lossy().as_ref(),
            "目录不是绝对路径",
        ));
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut directory = open("/", flags, Mode::empty())
        .map_err(|error| path_errno(path.to_string_lossy().as_ref(), error))?;
    for component in path.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        directory = openat(&directory, name, flags, Mode::empty()).map_err(|error| {
            if matches!(error, Errno::LOOP | Errno::NOTDIR) {
                unsafe_path(
                    path.to_string_lossy().as_ref(),
                    "目录路径包含符号链接或非目录组件",
                )
            } else {
                path_errno(path.to_string_lossy().as_ref(), error)
            }
        })?;
    }
    Ok(directory)
}

#[cfg(unix)]
#[derive(Debug)]
struct GitDirectory {
    path: PathBuf,
    directory: OwnedFd,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl GitDirectory {
    fn open(capability: &RepositoryCapability) -> Result<Self, WorktreeCommitError> {
        let pinned = &capability.pinned_git_metadata()?.git;
        pinned.verify_binding("<git-directory>")?;
        let path = pinned.path.clone();
        let directory =
            dup(&pinned.directory).map_err(|error| path_errno("<git-directory>", error))?;
        let stat = fstat(&directory).map_err(|error| path_errno("<git-directory>", error))?;
        let result = Self {
            path,
            directory,
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        };
        result.verify_binding()?;
        Ok(result)
    }

    fn verify_binding(&self) -> Result<(), WorktreeCommitError> {
        let current = open_absolute_directory(&self.path)?;
        let stat = fstat(&current).map_err(|error| path_errno("<git-directory>", error))?;
        if stat.st_dev as u64 != self.device || stat.st_ino as u64 != self.inode {
            return Err(unsafe_path(
                self.path.to_string_lossy().as_ref(),
                "Git 元数据目录在事务期间发生替换",
            ));
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), WorktreeCommitError> {
        fsync(&self.directory).map_err(|error| path_errno("<git-directory>", error))
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct RepositoryOwnerLock {
    file: fs::File,
    git_directory: OwnedFd,
    device: u64,
    inode: u64,
    owner: u32,
}

#[cfg(unix)]
impl RepositoryOwnerLock {
    fn acquire(git: &GitDirectory) -> Result<Self, WorktreeCommitError> {
        git.verify_binding()?;
        let descriptor = openat(
            &git.directory,
            OWNER_LOCK_NAME,
            OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|error| path_errno(OWNER_LOCK_NAME, error))?;
        let stat = fstat(&descriptor).map_err(|error| path_errno(OWNER_LOCK_NAME, error))?;
        let git_stat =
            fstat(&git.directory).map_err(|error| path_errno("<git-directory>", error))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
            || stat.st_uid != git_stat.st_uid
            || stat.st_mode & 0o777 != 0o600
        {
            return Err(unsafe_path(
                OWNER_LOCK_NAME,
                "提交 owner lock 的类型、所有者或权限不安全",
            ));
        }
        let file: fs::File = descriptor.into();
        FileExt::try_lock_exclusive(&file).map_err(|source| {
            if source.kind() == io::ErrorKind::WouldBlock {
                WorktreeCommitError::RepositoryBusy {
                    lock: OWNER_LOCK_NAME,
                }
            } else {
                WorktreeCommitError::PathUnavailable {
                    path: git.path.join(OWNER_LOCK_NAME),
                    source,
                }
            }
        })?;
        git.sync()?;
        let owner = Self {
            file,
            git_directory: dup(&git.directory)
                .map_err(|error| path_errno("<git-directory>", error))?,
            device: stat.st_dev as u64,
            inode: stat.st_ino,
            owner: stat.st_uid,
        };
        owner.verify_binding()?;
        Ok(owner)
    }

    fn verify_binding(&self) -> Result<(), WorktreeCommitError> {
        let locked_stat = fstat(&self.file).map_err(|error| path_errno(OWNER_LOCK_NAME, error))?;
        let current = openat(
            &self.git_directory,
            OWNER_LOCK_NAME,
            OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno(OWNER_LOCK_NAME, error))?;
        let current_stat = fstat(&current).map_err(|error| path_errno(OWNER_LOCK_NAME, error))?;
        let valid = [locked_stat, current_stat].into_iter().all(|stat| {
            FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile
                && stat.st_dev as u64 == self.device
                && stat.st_ino == self.inode
                && stat.st_uid == self.owner
                && stat.st_mode & 0o777 == 0o600
        });
        if valid {
            Ok(())
        } else {
            Err(unsafe_path(
                OWNER_LOCK_NAME,
                "提交 owner lock 在事务期间发生替换",
            ))
        }
    }
}

#[cfg(unix)]
fn configured_git_command(capability: &RepositoryCapability) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("--literal-pathspecs")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-c")
        .arg("commit.gpgSign=false")
        .arg("-c")
        .arg("tag.gpgSign=false")
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
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
        .stdin(Stdio::null());
    let root_fd = capability.root.as_raw_fd();
    let metadata_fds = capability.git_metadata.get().map(|metadata| {
        (
            metadata.git.directory.as_raw_fd(),
            metadata.common.directory.as_raw_fd(),
        )
    });
    if capability.git_metadata.get().is_some() {
        #[cfg(target_os = "linux")]
        {
            let (git_fd, common_fd) =
                metadata_fds.expect("Git metadata was checked immediately above");
            command
                .env("GIT_WORK_TREE", format!("/proc/self/fd/{root_fd}"))
                .env("GIT_DIR", format!("/proc/self/fd/{git_fd}"))
                .env("GIT_COMMON_DIR", format!("/proc/self/fd/{common_fd}"));
        }
        #[cfg(not(target_os = "linux"))]
        {
            let metadata = capability
                .git_metadata
                .get()
                .expect("metadata_fds only exists for pinned Git metadata");
            command
                .env("GIT_WORK_TREE", &capability.canonical_path)
                .env("GIT_DIR", &metadata.git.path)
                .env("GIT_COMMON_DIR", &metadata.common.path);
        }
    }
    // SAFETY: capability owns all descriptors until spawn returns. The child clears CLOEXEC so
    // Git can keep resolving the pinned /dev/fd paths after exec; fchdir/fcntl are async-signal-safe.
    unsafe {
        command.pre_exec(move || {
            let root = BorrowedFd::borrow_raw(root_fd);
            fcntl_setfd(root, FdFlags::empty()).map_err(io::Error::from)?;
            if let Some((git_fd, common_fd)) = metadata_fds {
                fcntl_setfd(BorrowedFd::borrow_raw(git_fd), FdFlags::empty())
                    .map_err(io::Error::from)?;
                fcntl_setfd(BorrowedFd::borrow_raw(common_fd), FdFlags::empty())
                    .map_err(io::Error::from)?;
            }
            rustix::process::fchdir(root).map_err(io::Error::from)
        });
    }
    command
}

#[cfg(unix)]
fn run_git<I, S>(
    capability: &RepositoryCapability,
    operation: &'static str,
    args: I,
) -> Result<Output, WorktreeCommitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    capability.verify_binding()?;
    let output = configured_git_command(capability)
        .args(args)
        .output()
        .map_err(WorktreeCommitError::GitUnavailable)?;
    capability.verify_binding()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeCommitError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

#[cfg(unix)]
fn run_git_raw<I, S>(
    capability: &RepositoryCapability,
    args: I,
) -> Result<Output, WorktreeCommitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    capability.verify_binding()?;
    let output = configured_git_command(capability)
        .args(args)
        .output()
        .map_err(WorktreeCommitError::GitUnavailable)?;
    capability.verify_binding()?;
    Ok(output)
}

#[cfg(unix)]
fn run_git_with_index<I, S>(
    capability: &RepositoryCapability,
    index_path: &Path,
    operation: &'static str,
    args: I,
) -> Result<Output, WorktreeCommitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    if !index_path.is_absolute() {
        return Err(unsafe_path(
            index_path.to_string_lossy().as_ref(),
            "事务索引不是绝对路径",
        ));
    }
    capability.verify_binding()?;
    let output = configured_git_command(capability)
        .env("GIT_INDEX_FILE", index_path)
        .args(args)
        .output()
        .map_err(WorktreeCommitError::GitUnavailable)?;
    capability.verify_binding()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeCommitError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

#[cfg(unix)]
fn run_git_with_stdin<I, S, R>(
    capability: &RepositoryCapability,
    operation: &'static str,
    args: I,
    mut input: R,
) -> Result<Output, WorktreeCommitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
    R: Read,
{
    capability.verify_binding()?;
    let mut child = configured_git_command(capability)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(args)
        .spawn()
        .map_err(WorktreeCommitError::GitUnavailable)?;
    let copy_result = child
        .stdin
        .take()
        .ok_or_else(|| WorktreeCommitError::InvalidGitOutput {
            operation,
            detail: "无法打开 Git 标准输入".into(),
        })
        .and_then(|mut stdin| {
            io::copy(&mut input, &mut stdin).map_err(|source| {
                WorktreeCommitError::PathUnavailable {
                    path: PathBuf::from("<git-stdin>"),
                    source,
                }
            })?;
            stdin
                .flush()
                .map_err(|source| WorktreeCommitError::PathUnavailable {
                    path: PathBuf::from("<git-stdin>"),
                    source,
                })
        });
    if copy_result.is_err() {
        let _ = child.kill();
    }
    let output = child
        .wait_with_output()
        .map_err(WorktreeCommitError::GitUnavailable)?;
    capability.verify_binding()?;
    copy_result?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeCommitError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

#[cfg(unix)]
fn trimmed_utf8<'a>(
    bytes: &'a [u8],
    operation: &'static str,
) -> Result<&'a str, WorktreeCommitError> {
    std::str::from_utf8(bytes)
        .map(str::trim)
        .map_err(|_| WorktreeCommitError::InvalidGitOutput {
            operation,
            detail: "输出不是 UTF-8".into(),
        })
}

#[cfg(unix)]
fn stderr_detail(output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        format!("退出状态 {}", output.status)
    } else {
        detail
    }
}

#[cfg(unix)]
fn path_errno(path: &str, error: Errno) -> WorktreeCommitError {
    WorktreeCommitError::PathUnavailable {
        path: PathBuf::from(path),
        source: io::Error::from(error),
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct JournalRoot {
    path: PathBuf,
    directory: OwnedFd,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl JournalRoot {
    fn open_or_create(git: &GitDirectory) -> Result<Self, WorktreeCommitError> {
        git.verify_binding()?;
        match mkdirat(
            &git.directory,
            JOURNAL_ROOT_NAME,
            Mode::from_raw_mode(0o700),
        ) {
            Ok(()) => git.sync()?,
            Err(Errno::EXIST) => {}
            Err(error) => return Err(path_errno(JOURNAL_ROOT_NAME, error)),
        }
        let directory = openat(
            &git.directory,
            JOURNAL_ROOT_NAME,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))?;
        let stat = fstat(&directory).map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))?;
        let git_stat =
            fstat(&git.directory).map_err(|error| path_errno("<git-directory>", error))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
            return Err(unsafe_path(JOURNAL_ROOT_NAME, "提交恢复目录不是普通目录"));
        }
        if stat.st_uid != git_stat.st_uid || stat.st_mode & 0o077 != 0 {
            return Err(unsafe_path(
                JOURNAL_ROOT_NAME,
                "提交恢复目录的所有者或权限不安全",
            ));
        }
        let result = Self {
            path: git.path.join(JOURNAL_ROOT_NAME),
            directory,
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        };
        result.verify_binding(git)?;
        Ok(result)
    }

    fn open_existing(git: &GitDirectory) -> Result<Option<Self>, WorktreeCommitError> {
        git.verify_binding()?;
        let directory = match openat(
            &git.directory,
            JOURNAL_ROOT_NAME,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(directory) => directory,
            Err(Errno::NOENT) => return Ok(None),
            Err(error) => return Err(path_errno(JOURNAL_ROOT_NAME, error)),
        };
        let stat = fstat(&directory).map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))?;
        let git_stat =
            fstat(&git.directory).map_err(|error| path_errno("<git-directory>", error))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory
            || stat.st_uid != git_stat.st_uid
            || stat.st_mode & 0o077 != 0
        {
            return Err(unsafe_path(
                JOURNAL_ROOT_NAME,
                "提交恢复目录的类型、所有者或权限不安全",
            ));
        }
        let result = Self {
            path: git.path.join(JOURNAL_ROOT_NAME),
            directory,
            device: stat.st_dev as u64,
            inode: stat.st_ino,
        };
        result.verify_binding(git)?;
        Ok(Some(result))
    }

    fn verify_binding(&self, git: &GitDirectory) -> Result<(), WorktreeCommitError> {
        git.verify_binding()?;
        let current = openat(
            &git.directory,
            JOURNAL_ROOT_NAME,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))?;
        let stat = fstat(&current).map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))?;
        if stat.st_dev as u64 != self.device || stat.st_ino as u64 != self.inode {
            return Err(unsafe_path(
                JOURNAL_ROOT_NAME,
                "提交恢复目录在事务期间发生替换",
            ));
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), WorktreeCommitError> {
        fsync(&self.directory).map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))
    }

    fn journal_ids(&self, git: &GitDirectory) -> Result<Vec<String>, WorktreeCommitError> {
        self.verify_binding(git)?;
        let mut ids = Vec::new();
        let entries =
            fs::read_dir(&self.path).map_err(|source| WorktreeCommitError::PathUnavailable {
                path: self.path.clone(),
                source,
            })?;
        for entry in entries {
            let entry = entry.map_err(|source| WorktreeCommitError::PathUnavailable {
                path: self.path.clone(),
                source,
            })?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(unsafe_path(
                    self.path.to_string_lossy().as_ref(),
                    "提交恢复目录包含非 UTF-8 项",
                ));
            };
            validate_journal_id(name)?;
            ids.push(name.to_string());
            if ids.len() > MAX_PENDING_JOURNALS {
                return Err(WorktreeCommitError::ResourceLimit {
                    resource: "待恢复提交 journal 数量",
                    max: MAX_PENDING_JOURNALS,
                });
            }
        }
        ids.sort();
        self.verify_binding(git)?;
        Ok(ids)
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct CommitTransaction {
    journal_id: String,
    lock_token: String,
    root: JournalRoot,
    directory: OwnedFd,
    directory_device: u64,
    directory_inode: u64,
    directory_path: PathBuf,
    head_lock_owned: bool,
    index_lock_owned: bool,
    preserve_for_recovery: bool,
    git_directory: OwnedFd,
    git_directory_path: PathBuf,
}

#[cfg(unix)]
impl CommitTransaction {
    fn begin(
        capability: &RepositoryCapability,
        git: &GitDirectory,
        baseline: &TaskBaseline,
    ) -> Result<Self, WorktreeCommitError> {
        let root = JournalRoot::open_or_create(git)?;
        let existing = root.journal_ids(git)?;
        if existing.len() >= MAX_PENDING_JOURNALS {
            return Err(WorktreeCommitError::ResourceLimit {
                resource: "待恢复提交 journal 数量",
                max: MAX_PENDING_JOURNALS,
            });
        }
        let (journal_id, directory) = create_transaction_directory(&root)?;
        let stat = fstat(&directory)
            .map_err(|error| path_errno("<commit-transaction-directory>", error))?;
        let lock_token = random_hex(32)?;
        let intent = CommitIntent {
            version: JOURNAL_VERSION,
            journal_id: journal_id.clone(),
            lock_token: lock_token.clone(),
            repository_root: capability.canonical_path.clone(),
            baseline_revision: baseline.revision.clone(),
        };
        let mut transaction = Self {
            directory_path: root.path.join(&journal_id),
            journal_id,
            lock_token,
            root,
            directory,
            directory_device: stat.st_dev as u64,
            directory_inode: stat.st_ino as u64,
            head_lock_owned: false,
            index_lock_owned: false,
            preserve_for_recovery: false,
            git_directory: dup(&git.directory)
                .map_err(|error| path_errno("<git-directory>", error))?,
            git_directory_path: git.path.clone(),
        };
        transaction.write_json(INTENT_FILE_NAME, &intent)?;
        transaction.root.sync()?;
        transaction.acquire_locks(git)?;
        Ok(transaction)
    }

    fn open_existing(
        git: &GitDirectory,
        root: JournalRoot,
        journal_id: &str,
    ) -> Result<(Self, CommitIntent), WorktreeCommitError> {
        validate_journal_id(journal_id)?;
        root.verify_binding(git)?;
        let directory = openat(
            &root.directory,
            journal_id,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno(journal_id, error))?;
        let stat = fstat(&directory).map_err(|error| path_errno(journal_id, error))?;
        let root_stat =
            fstat(&root.directory).map_err(|error| path_errno(JOURNAL_ROOT_NAME, error))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::Directory
            || stat.st_uid != root_stat.st_uid
            || stat.st_mode & 0o077 != 0
        {
            return Err(unsafe_path(
                journal_id,
                "提交事务目录的类型、所有者或权限不安全",
            ));
        }
        let intent_bytes = read_file_at_limited(&directory, INTENT_FILE_NAME, MAX_JOURNAL_BYTES)
            .map_err(|error| WorktreeCommitError::DamagedJournal {
                journal_id: journal_id.to_string(),
                detail: error.to_string(),
            })?;
        let intent: CommitIntent = serde_json::from_slice(&intent_bytes).map_err(|error| {
            WorktreeCommitError::DamagedJournal {
                journal_id: journal_id.to_string(),
                detail: format!("intent 无法解析：{error}"),
            }
        })?;
        validate_intent(&intent, journal_id)?;
        let index_marker = lock_marker(journal_id, &intent.lock_token, "index");
        let head_marker = lock_marker(journal_id, &intent.lock_token, "head");
        let index_lock_owned = lock_file_equals(&git.directory, INDEX_LOCK_NAME, &index_marker)?;
        let head_lock_owned = lock_file_equals(&git.directory, HEAD_LOCK_NAME, &head_marker)?;
        let transaction = Self {
            journal_id: journal_id.to_string(),
            lock_token: intent.lock_token.clone(),
            directory_path: root.path.join(journal_id),
            root,
            directory,
            directory_device: stat.st_dev as u64,
            directory_inode: stat.st_ino as u64,
            head_lock_owned,
            index_lock_owned,
            preserve_for_recovery: true,
            git_directory: dup(&git.directory)
                .map_err(|error| path_errno("<git-directory>", error))?,
            git_directory_path: git.path.clone(),
        };
        transaction.verify_binding()?;
        Ok((transaction, intent))
    }

    fn verify_binding(&self) -> Result<(), WorktreeCommitError> {
        let current = openat(
            &self.root.directory,
            self.journal_id.as_str(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno("<commit-transaction-directory>", error))?;
        let stat =
            fstat(&current).map_err(|error| path_errno("<commit-transaction-directory>", error))?;
        if stat.st_dev as u64 != self.directory_device || stat.st_ino as u64 != self.directory_inode
        {
            return Err(unsafe_path(
                self.directory_path.to_string_lossy().as_ref(),
                "提交事务目录在操作期间发生替换",
            ));
        }
        Ok(())
    }

    fn write_json<T: Serialize>(
        &mut self,
        name: &'static str,
        value: &T,
    ) -> Result<(), WorktreeCommitError> {
        self.verify_binding()?;
        let bytes =
            serde_json::to_vec(value).map_err(|error| WorktreeCommitError::InvalidGitOutput {
                operation: "编码提交恢复 journal",
                detail: error.to_string(),
            })?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(WorktreeCommitError::ResourceLimit {
                resource: "提交恢复 journal 字节数",
                max: MAX_JOURNAL_BYTES as usize,
            });
        }
        let temporary = match name {
            INTENT_FILE_NAME => ".intent.tmp",
            JOURNAL_FILE_NAME => ".journal.tmp",
            _ => {
                return Err(WorktreeCommitError::InvalidGitOutput {
                    operation: "写入提交恢复 journal",
                    detail: "未知 journal 文件名".into(),
                })
            }
        };
        write_new_file_at(
            &self.directory,
            temporary,
            &bytes,
            Mode::from_raw_mode(0o600),
        )?;
        renameat(&self.directory, temporary, &self.directory, name)
            .map_err(|error| path_errno(name, error))?;
        fsync(&self.directory)
            .map_err(|error| path_errno("<commit-transaction-directory>", error))?;
        Ok(())
    }

    fn acquire_locks(&mut self, git: &GitDirectory) -> Result<(), WorktreeCommitError> {
        self.verify_binding()?;
        let index_marker = lock_marker(&self.journal_id, &self.lock_token, "index");
        write_new_file_at(
            &self.directory,
            INDEX_MARKER_FILE_NAME,
            &index_marker,
            Mode::from_raw_mode(0o600),
        )?;
        match renameat_with(
            &self.directory,
            INDEX_MARKER_FILE_NAME,
            &git.directory,
            INDEX_LOCK_NAME,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => self.index_lock_owned = true,
            Err(Errno::EXIST) => {
                return Err(WorktreeCommitError::RepositoryBusy {
                    lock: INDEX_LOCK_NAME,
                })
            }
            Err(error) => return Err(path_errno(INDEX_LOCK_NAME, error)),
        }
        git.sync()?;
        Ok(())
    }

    fn commit_index_path(&self) -> PathBuf {
        self.directory_path.join(COMMIT_INDEX_FILE_NAME)
    }

    fn real_index_temporary_name(&self) -> String {
        format!(".joydsh-real-index-{}", self.journal_id)
    }

    fn real_index_temporary_path(&self) -> PathBuf {
        self.git_directory_path
            .join(self.real_index_temporary_name())
    }

    fn real_index_lock_name(&self) -> String {
        format!("{}.lock", self.real_index_temporary_name())
    }

    fn install_index_temporary_name(&self) -> String {
        format!(".joydsh-install-index-{}", self.journal_id)
    }

    fn mark_for_recovery(&mut self) {
        self.preserve_for_recovery = true;
    }

    fn release_head_lock(&mut self) -> Result<(), WorktreeCommitError> {
        if !self.head_lock_owned {
            return Ok(());
        }
        let expected = lock_marker(&self.journal_id, &self.lock_token, "head");
        remove_lock_if_exact(&self.git_directory, HEAD_LOCK_NAME, &expected)?;
        fsync(&self.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        self.head_lock_owned = false;
        Ok(())
    }

    fn ensure_recovery_index_marker(&mut self) -> Result<(), WorktreeCommitError> {
        if self.index_lock_owned {
            return Ok(());
        }
        if read_optional_file_at_limited(&self.git_directory, INDEX_LOCK_NAME, MAX_INDEX_BYTES)?
            .is_some()
        {
            return Err(WorktreeCommitError::RepositoryBusy {
                lock: INDEX_LOCK_NAME,
            });
        }
        let expected = lock_marker(&self.journal_id, &self.lock_token, "index");
        remove_if_exists(&self.directory, INDEX_MARKER_FILE_NAME)?;
        write_new_file_at(
            &self.directory,
            INDEX_MARKER_FILE_NAME,
            &expected,
            Mode::from_raw_mode(0o600),
        )?;
        renameat_with(
            &self.directory,
            INDEX_MARKER_FILE_NAME,
            &self.git_directory,
            INDEX_LOCK_NAME,
            RenameFlags::NOREPLACE,
        )
        .map_err(|error| match error {
            Errno::EXIST => WorktreeCommitError::RepositoryBusy {
                lock: INDEX_LOCK_NAME,
            },
            error => path_errno(INDEX_LOCK_NAME, error),
        })?;
        fsync(&self.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        self.index_lock_owned = true;
        Ok(())
    }

    fn publish_existing_index_lock(
        &mut self,
        prepared_digest: &[u8; 32],
    ) -> Result<(), WorktreeCommitError> {
        if digest_file_at(&self.git_directory, INDEX_LOCK_NAME)? != *prepared_digest {
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: self.journal_id.clone(),
                detail: "遗留 index.lock 不是准备完成的索引".into(),
            });
        }
        renameat(
            &self.git_directory,
            INDEX_LOCK_NAME,
            &self.git_directory,
            INDEX_NAME,
        )
        .map_err(|error| path_errno(INDEX_NAME, error))?;
        fsync(&self.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        self.index_lock_owned = false;
        Ok(())
    }

    fn install_prepared_index(
        &mut self,
        prepared_digest: &[u8; 32],
        index_mode: Mode,
    ) -> Result<(), WorktreeCommitError> {
        self.verify_binding()?;
        let expected_marker = lock_marker(&self.journal_id, &self.lock_token, "index");
        let lock_bytes =
            read_file_at_limited(&self.git_directory, INDEX_LOCK_NAME, MAX_JOURNAL_BYTES)?;
        if lock_bytes != expected_marker {
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: self.journal_id.clone(),
                detail: "index.lock 不再属于当前提交事务".into(),
            });
        }
        let install_name = self.install_index_temporary_name();
        copy_file_between(
            &self.directory,
            PREPARED_INDEX_FILE_NAME,
            &self.git_directory,
            &install_name,
            index_mode,
        )?;
        let copied_digest = digest_file_at(&self.git_directory, &install_name)?;
        if &copied_digest != prepared_digest {
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: self.journal_id.clone(),
                detail: "准备安装的 Git 索引摘要不一致".into(),
            });
        }
        renameat(
            &self.git_directory,
            &install_name,
            &self.git_directory,
            INDEX_LOCK_NAME,
        )
        .map_err(|error| path_errno(INDEX_LOCK_NAME, error))?;
        fsync(&self.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        renameat(
            &self.git_directory,
            INDEX_LOCK_NAME,
            &self.git_directory,
            INDEX_NAME,
        )
        .map_err(|error| path_errno(INDEX_NAME, error))?;
        fsync(&self.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        self.index_lock_owned = false;
        if digest_file_at(&self.git_directory, INDEX_NAME)? != *prepared_digest {
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: self.journal_id.clone(),
                detail: "真实 Git 索引安装后摘要不一致".into(),
            });
        }
        Ok(())
    }

    fn cleanup_inner(&mut self) -> Result<(), WorktreeCommitError> {
        if self.head_lock_owned {
            let expected = lock_marker(&self.journal_id, &self.lock_token, "head");
            remove_lock_if_exact(&self.git_directory, HEAD_LOCK_NAME, &expected)?;
            self.head_lock_owned = false;
        }
        if self.index_lock_owned {
            let expected = lock_marker(&self.journal_id, &self.lock_token, "index");
            remove_lock_if_exact(&self.git_directory, INDEX_LOCK_NAME, &expected)?;
            self.index_lock_owned = false;
        }
        remove_if_exists(&self.git_directory, &self.real_index_temporary_name())?;
        remove_if_exists(&self.git_directory, &self.real_index_lock_name())?;
        remove_if_exists(&self.git_directory, &self.install_index_temporary_name())?;
        fsync(&self.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        cleanup_transaction_directory(&self.root, &self.journal_id, &self.directory)?;
        self.root.sync()?;
        self.preserve_for_recovery = true;
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for CommitTransaction {
    fn drop(&mut self) {
        if !self.preserve_for_recovery {
            let _ = self.cleanup_inner();
        }
    }
}

#[cfg(unix)]
fn create_transaction_directory(
    root: &JournalRoot,
) -> Result<(String, OwnedFd), WorktreeCommitError> {
    for _ in 0..32 {
        let journal_id = random_hex(16)?;
        match mkdirat(
            &root.directory,
            journal_id.as_str(),
            Mode::from_raw_mode(0o700),
        ) {
            Ok(()) => {
                let directory = openat(
                    &root.directory,
                    journal_id.as_str(),
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| path_errno("<commit-transaction-directory>", error))?;
                root.sync()?;
                return Ok((journal_id, directory));
            }
            Err(Errno::EXIST) => continue,
            Err(error) => return Err(path_errno("<commit-transaction-directory>", error)),
        }
    }
    Err(unsafe_path(
        "<commit-transaction-directory>",
        "无法分配唯一的提交事务目录",
    ))
}

#[cfg(unix)]
fn random_hex(byte_count: usize) -> Result<String, WorktreeCommitError> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(|error| WorktreeCommitError::InvalidGitOutput {
        operation: "生成提交事务随机数",
        detail: error.to_string(),
    })?;
    let mut output = String::with_capacity(byte_count * 2);
    for byte in bytes {
        use fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(output)
}

#[cfg(unix)]
fn lock_marker(journal_id: &str, token: &str, kind: &str) -> Vec<u8> {
    format!("JOYDSH-COMMIT-LOCK-v1\n{journal_id}\n{token}\n{kind}\n").into_bytes()
}

#[cfg(unix)]
fn validate_intent(intent: &CommitIntent, journal_id: &str) -> Result<(), WorktreeCommitError> {
    if intent.version != JOURNAL_VERSION
        || intent.journal_id != journal_id
        || intent.lock_token.len() != 64
        || !intent
            .lock_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !matches!(intent.baseline_revision.len(), 40 | 64)
        || !intent
            .baseline_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !intent.repository_root.is_absolute()
    {
        return Err(WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: "intent 字段无效".into(),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn lock_file_equals(
    git_directory: &OwnedFd,
    name: &str,
    expected: &[u8],
) -> Result<bool, WorktreeCommitError> {
    Ok(
        read_optional_file_at_limited(git_directory, name, MAX_INDEX_BYTES)?
            .is_some_and(|actual| actual == expected),
    )
}

#[cfg(unix)]
fn write_new_file_at(
    directory: &OwnedFd,
    name: &str,
    bytes: &[u8],
    mode: Mode,
) -> Result<(), WorktreeCommitError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode,
    )
    .map_err(|error| path_errno(name, error))?;
    let mut file: fs::File = descriptor.into();
    fchmod(&file, mode).map_err(|error| path_errno(name, error))?;
    file.write_all(bytes)
        .map_err(|source| WorktreeCommitError::PathUnavailable {
            path: PathBuf::from(name),
            source,
        })?;
    file.sync_all()
        .map_err(|source| WorktreeCommitError::PathUnavailable {
            path: PathBuf::from(name),
            source,
        })
}

#[cfg(unix)]
fn read_file_at_limited(
    directory: &OwnedFd,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, WorktreeCommitError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| path_errno(name, error))?;
    let stat = fstat(&descriptor).map_err(|error| path_errno(name, error))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(unsafe_path(name, "文件不是普通文件"));
    }
    if stat.st_size < 0 || stat.st_size as u64 > max_bytes {
        return Err(WorktreeCommitError::ResourceLimit {
            resource: "提交恢复文件字节数",
            max: max_bytes as usize,
        });
    }
    let file: fs::File = descriptor.into();
    let mut bytes = Vec::with_capacity(stat.st_size as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| WorktreeCommitError::PathUnavailable {
            path: PathBuf::from(name),
            source,
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(WorktreeCommitError::ResourceLimit {
            resource: "提交恢复文件字节数",
            max: max_bytes as usize,
        });
    }
    Ok(bytes)
}

#[cfg(unix)]
fn read_optional_file_at_limited(
    directory: &OwnedFd,
    name: &str,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, WorktreeCommitError> {
    match openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(descriptor) => {
            let stat = fstat(&descriptor).map_err(|error| path_errno(name, error))?;
            if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
                return Err(unsafe_path(name, "文件不是普通文件"));
            }
            if stat.st_size < 0 || stat.st_size as u64 > max_bytes {
                return Err(WorktreeCommitError::ResourceLimit {
                    resource: "提交恢复文件字节数",
                    max: max_bytes as usize,
                });
            }
            let file: fs::File = descriptor.into();
            let mut bytes = Vec::with_capacity(stat.st_size as usize);
            file.take(max_bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|source| WorktreeCommitError::PathUnavailable {
                    path: PathBuf::from(name),
                    source,
                })?;
            if bytes.len() as u64 > max_bytes {
                return Err(WorktreeCommitError::ResourceLimit {
                    resource: "提交恢复文件字节数",
                    max: max_bytes as usize,
                });
            }
            Ok(Some(bytes))
        }
        Err(Errno::NOENT) => Ok(None),
        Err(error) => Err(path_errno(name, error)),
    }
}

#[cfg(unix)]
fn remove_lock_if_exact(
    git_directory: &OwnedFd,
    name: &'static str,
    expected: &[u8],
) -> Result<(), WorktreeCommitError> {
    let actual = match read_optional_file_at_limited(git_directory, name, MAX_JOURNAL_BYTES)? {
        Some(actual) => actual,
        None => return Ok(()),
    };
    if actual != expected {
        return Err(WorktreeCommitError::RepositoryBusy { lock: name });
    }
    match unlinkat(git_directory, name, AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(error) => Err(path_errno(name, error)),
    }
}

#[cfg(unix)]
fn remove_if_exists(directory: &OwnedFd, name: &str) -> Result<(), WorktreeCommitError> {
    match unlinkat(directory, name, AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(error) => Err(path_errno(name, error)),
    }
}

#[cfg(unix)]
fn cleanup_transaction_directory(
    root: &JournalRoot,
    journal_id: &str,
    directory: &OwnedFd,
) -> Result<(), WorktreeCommitError> {
    for name in [
        INTENT_FILE_NAME,
        JOURNAL_FILE_NAME,
        PREPARED_INDEX_FILE_NAME,
        COMMIT_INDEX_FILE_NAME,
        HEAD_MARKER_FILE_NAME,
        INDEX_MARKER_FILE_NAME,
        ".intent.tmp",
        ".journal.tmp",
        "commit.index.lock",
        "prepared.index.lock",
    ] {
        remove_if_exists(directory, name)?;
    }
    match unlinkat(&root.directory, journal_id, AtFlags::REMOVEDIR) {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(Errno::NOTEMPTY) => Err(unsafe_path(
            journal_id,
            "提交事务目录包含未知文件，拒绝递归删除",
        )),
        Err(error) => Err(path_errno(journal_id, error)),
    }
}

#[cfg(unix)]
fn copy_file_between(
    source_directory: &OwnedFd,
    source_name: &str,
    target_directory: &OwnedFd,
    target_name: &str,
    mode: Mode,
) -> Result<(), WorktreeCommitError> {
    let source_descriptor = openat(
        source_directory,
        source_name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| path_errno(source_name, error))?;
    let source_stat = fstat(&source_descriptor).map_err(|error| path_errno(source_name, error))?;
    if FileType::from_raw_mode(source_stat.st_mode) != FileType::RegularFile {
        return Err(unsafe_path(source_name, "源文件不是普通文件"));
    }
    let target_descriptor = openat(
        target_directory,
        target_name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        mode,
    )
    .map_err(|error| path_errno(target_name, error))?;
    let mut source: fs::File = source_descriptor.into();
    let mut target: fs::File = target_descriptor.into();
    fchmod(&target, mode).map_err(|error| path_errno(target_name, error))?;
    io::copy(&mut source, &mut target).map_err(|source| WorktreeCommitError::PathUnavailable {
        path: PathBuf::from(target_name),
        source,
    })?;
    target
        .sync_all()
        .map_err(|source| WorktreeCommitError::PathUnavailable {
            path: PathBuf::from(target_name),
            source,
        })
}

#[cfg(unix)]
fn digest_file_at(directory: &OwnedFd, name: &str) -> Result<[u8; 32], WorktreeCommitError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| path_errno(name, error))?;
    let stat = fstat(&descriptor).map_err(|error| path_errno(name, error))?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(unsafe_path(name, "Git 索引不是普通文件"));
    }
    let mut file: fs::File = descriptor.into();
    digest_reader(&mut file).map_err(|source| WorktreeCommitError::PathUnavailable {
        path: PathBuf::from(name),
        source,
    })
}

#[cfg(unix)]
fn digest_reader(reader: &mut impl Read) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(unix)]
fn encode_digest(digest: &[u8; 32]) -> String {
    let mut output = String::with_capacity(64);
    for byte in digest {
        use fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

#[cfg(unix)]
fn decode_digest(value: &str, journal_id: &str) -> Result<[u8; 32], WorktreeCommitError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: "索引摘要格式无效".into(),
        });
    }
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).map_err(|_| {
            WorktreeCommitError::DamagedJournal {
                journal_id: journal_id.to_string(),
                detail: "索引摘要格式无效".into(),
            }
        })?;
    }
    Ok(digest)
}

#[cfg(unix)]
fn validate_object_id(value: &str, operation: &'static str) -> Result<String, WorktreeCommitError> {
    if matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(WorktreeCommitError::InvalidGitOutput {
            operation,
            detail: format!("对象 ID 格式无效：{value:?}"),
        })
    }
}

#[cfg(unix)]
fn resolve_revision(
    capability: &RepositoryCapability,
    revision: &str,
    operation: &'static str,
) -> Result<String, WorktreeCommitError> {
    if !matches!(revision.len(), 40 | 64) || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(WorktreeCommitError::InvalidGitOutput {
            operation,
            detail: "任务基线 revision 格式无效".into(),
        });
    }
    let expression = format!("{revision}^{{commit}}");
    let output = run_git(
        capability,
        operation,
        ["rev-parse", "--verify", &expression],
    )?;
    validate_object_id(trimmed_utf8(&output.stdout, operation)?, operation)
}

#[cfg(unix)]
fn current_head(capability: &RepositoryCapability) -> Result<Option<String>, WorktreeCommitError> {
    let output = run_git_raw(capability, ["rev-parse", "--verify", "HEAD^{commit}"])?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(Some(validate_object_id(
        trimmed_utf8(&output.stdout, "读取 HEAD")?,
        "读取 HEAD",
    )?))
}

#[cfg(unix)]
fn current_branch_ref(capability: &RepositoryCapability) -> Result<String, WorktreeCommitError> {
    let output = run_git_raw(capability, ["symbolic-ref", "-q", "HEAD"])?;
    if !output.status.success() {
        return Err(WorktreeCommitError::DetachedHead);
    }
    let branch = trimmed_utf8(&output.stdout, "读取当前分支")?;
    if !branch.starts_with("refs/heads/")
        || branch.len() <= "refs/heads/".len()
        || branch.as_bytes().contains(&0)
        || branch.contains("..")
        || branch.contains("@{")
    {
        return Err(WorktreeCommitError::InvalidGitOutput {
            operation: "读取当前分支",
            detail: format!("HEAD 指向的分支引用无效：{branch:?}"),
        });
    }
    Ok(branch.to_string())
}

#[cfg(unix)]
fn ensure_baseline_head(
    capability: &RepositoryCapability,
    baseline: &TaskBaseline,
) -> Result<String, WorktreeCommitError> {
    let baseline_revision = resolve_revision(capability, &baseline.revision, "验证任务基线")?;
    let actual = current_head(capability)?;
    if actual.as_deref() != Some(baseline_revision.as_str()) {
        return Err(WorktreeCommitError::HeadChanged {
            expected: baseline_revision,
            actual,
        });
    }
    Ok(baseline_revision)
}

#[cfg(unix)]
fn ensure_no_operation_in_progress(git: &GitDirectory) -> Result<(), WorktreeCommitError> {
    for (name, operation) in [
        ("MERGE_HEAD", "合并"),
        ("CHERRY_PICK_HEAD", "拣选"),
        ("REVERT_HEAD", "回退提交"),
        ("rebase-apply", "变基"),
        ("rebase-merge", "变基"),
        ("sequencer", "序列操作"),
        ("BISECT_LOG", "二分定位"),
    ] {
        match statat(&git.directory, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => return Err(WorktreeCommitError::OperationInProgress { operation }),
            Err(Errno::NOENT) => {}
            Err(error) => return Err(path_errno(name, error)),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_no_unmerged_paths(capability: &RepositoryCapability) -> Result<(), WorktreeCommitError> {
    let output = run_git(
        capability,
        "读取未解决冲突",
        ["ls-files", "--unmerged", "-z", "--"],
    )?;
    let mut paths = BTreeSet::new();
    for record in output.stdout.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation: "读取未解决冲突",
                detail: "索引冲突记录缺少路径".into(),
            });
        };
        let path = std::str::from_utf8(&record[tab + 1..]).map_err(|_| {
            WorktreeCommitError::InvalidGitOutput {
                operation: "读取未解决冲突",
                detail: "冲突路径不是 UTF-8".into(),
            }
        })?;
        paths.insert(path.to_string());
    }
    if paths.is_empty() {
        Ok(())
    } else {
        Err(WorktreeCommitError::UnmergedChanges {
            paths: paths.into_iter().collect(),
        })
    }
}

#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct PathStat {
    device: u64,
    inode: u64,
    mode: u32,
    size: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    changed_seconds: i64,
    changed_nanos: i64,
}

#[cfg(unix)]
impl PathStat {
    fn from_stat(stat: &rustix::fs::Stat) -> Self {
        Self {
            device: stat.st_dev as u64,
            inode: stat.st_ino,
            mode: stat.st_mode as u32,
            size: stat.st_size.max(0) as u64,
            modified_seconds: stat.st_mtime as _,
            modified_nanos: stat.st_mtime_nsec as _,
            changed_seconds: stat.st_ctime as _,
            changed_nanos: stat.st_ctime_nsec as _,
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
enum WorktreePathFingerprint {
    Missing,
    Regular { stat: PathStat, digest: [u8; 32] },
    SymbolicLink { stat: PathStat, target: Vec<u8> },
}

#[cfg(unix)]
#[derive(Debug)]
enum WorktreeMaterial {
    Missing {
        fingerprint: WorktreePathFingerprint,
    },
    Present {
        mode: &'static str,
        object_id: String,
        fingerprint: WorktreePathFingerprint,
    },
}

#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct GitIndexEntry {
    mode: String,
    object_id: String,
}

#[cfg(unix)]
enum ParentLookup {
    Present { parent: OwnedFd, leaf: OsString },
    Missing,
}

#[cfg(unix)]
fn open_worktree_parent(
    capability: &RepositoryCapability,
    path: &str,
) -> Result<ParentLookup, WorktreeCommitError> {
    validate_relative_path(path)?;
    capability.verify_binding()?;
    let components = Path::new(path)
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err(unsafe_path(path, "路径组件无效")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (leaf, parents) = components
        .split_last()
        .ok_or_else(|| unsafe_path(path, "路径没有文件名"))?;
    let mut parent = dup(&capability.root).map_err(|error| path_errno(path, error))?;
    for component in parents {
        match openat(
            &parent,
            component,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(next) => parent = next,
            Err(Errno::NOENT) => return Ok(ParentLookup::Missing),
            Err(Errno::LOOP | Errno::NOTDIR) => {
                return Err(unsafe_path(path, "父目录包含符号链接或非目录组件"))
            }
            Err(error) => return Err(path_errno(path, error)),
        }
    }
    Ok(ParentLookup::Present {
        parent,
        leaf: leaf.clone(),
    })
}

#[cfg(unix)]
fn capture_worktree_material(
    capability: &RepositoryCapability,
    path: &str,
) -> Result<WorktreeMaterial, WorktreeCommitError> {
    let ParentLookup::Present { parent, leaf } = open_worktree_parent(capability, path)? else {
        return Ok(WorktreeMaterial::Missing {
            fingerprint: WorktreePathFingerprint::Missing,
        });
    };
    let stat = match statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => stat,
        Err(Errno::NOENT) => {
            return Ok(WorktreeMaterial::Missing {
                fingerprint: WorktreePathFingerprint::Missing,
            })
        }
        Err(error) => return Err(path_errno(path, error)),
    };
    match FileType::from_raw_mode(stat.st_mode) {
        FileType::RegularFile => {
            let descriptor = openat(
                &parent,
                &leaf,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| path_errno(path, error))?;
            let before = fstat(&descriptor).map_err(|error| path_errno(path, error))?;
            if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile {
                return Err(WorktreeCommitError::UnsupportedFileType {
                    path: path.to_string(),
                });
            }
            let mut file: fs::File = descriptor.into();
            let digest = digest_reader(&mut file).map_err(|source| {
                WorktreeCommitError::PathUnavailable {
                    path: PathBuf::from(path),
                    source,
                }
            })?;
            file.seek(SeekFrom::Start(0)).map_err(|source| {
                WorktreeCommitError::PathUnavailable {
                    path: PathBuf::from(path),
                    source,
                }
            })?;
            let output = run_git_with_stdin(
                capability,
                "写入成果 blob",
                ["hash-object", "-w", "--stdin"],
                &mut file,
            )?;
            let after = fstat(&file).map_err(|error| path_errno(path, error))?;
            let before = PathStat::from_stat(&before);
            let after = PathStat::from_stat(&after);
            if before != after {
                return Err(WorktreeCommitError::IndexChanged);
            }
            let object_id = validate_object_id(
                trimmed_utf8(&output.stdout, "写入成果 blob")?,
                "写入成果 blob",
            )?;
            let mode = if before.mode & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            };
            Ok(WorktreeMaterial::Present {
                mode,
                object_id,
                fingerprint: WorktreePathFingerprint::Regular {
                    stat: before,
                    digest,
                },
            })
        }
        FileType::Symlink => {
            let before = PathStat::from_stat(&stat);
            let target = readlinkat(&parent, &leaf, Vec::new())
                .map_err(|error| path_errno(path, error))?
                .as_bytes()
                .to_vec();
            let output = run_git_with_stdin(
                capability,
                "写入符号链接 blob",
                ["hash-object", "-w", "--stdin"],
                io::Cursor::new(&target),
            )?;
            let after = statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|error| path_errno(path, error))?;
            let target_after = readlinkat(&parent, &leaf, Vec::new())
                .map_err(|error| path_errno(path, error))?
                .as_bytes()
                .to_vec();
            let fingerprint = WorktreePathFingerprint::SymbolicLink {
                stat: before,
                target,
            };
            if fingerprint
                != (WorktreePathFingerprint::SymbolicLink {
                    stat: PathStat::from_stat(&after),
                    target: target_after,
                })
            {
                return Err(WorktreeCommitError::IndexChanged);
            }
            Ok(WorktreeMaterial::Present {
                mode: "120000",
                object_id: validate_object_id(
                    trimmed_utf8(&output.stdout, "写入符号链接 blob")?,
                    "写入符号链接 blob",
                )?,
                fingerprint,
            })
        }
        _ => Err(WorktreeCommitError::UnsupportedFileType {
            path: path.to_string(),
        }),
    }
}

#[cfg(unix)]
fn fingerprint_worktree_path(
    capability: &RepositoryCapability,
    path: &str,
) -> Result<WorktreePathFingerprint, WorktreeCommitError> {
    match capture_worktree_material(capability, path)? {
        WorktreeMaterial::Missing { fingerprint }
        | WorktreeMaterial::Present { fingerprint, .. } => Ok(fingerprint),
    }
}

#[cfg(unix)]
struct BuiltCommitTree {
    tree: String,
    fingerprints: BTreeMap<String, WorktreePathFingerprint>,
}

#[cfg(unix)]
fn build_commit_tree(
    capability: &RepositoryCapability,
    transaction: &CommitTransaction,
    baseline_revision: &str,
    accepted_paths: &[AcceptedCommitPath],
) -> Result<BuiltCommitTree, WorktreeCommitError> {
    let index_path = transaction.commit_index_path();
    run_git_with_index(
        capability,
        &index_path,
        "载入任务基线树",
        ["read-tree", baseline_revision],
    )?;
    let mut fingerprints = BTreeMap::new();
    for accepted in accepted_paths {
        let material = capture_worktree_material(capability, &accepted.path)?;
        let fingerprint = material_fingerprint(&material).clone();
        let baseline_entry = baseline_tree_entry(capability, baseline_revision, &accepted.path)?;
        let worktree_changed = match (&material, baseline_entry.as_ref()) {
            (WorktreeMaterial::Missing { .. }, Some(_))
            | (WorktreeMaterial::Present { .. }, None) => true,
            (WorktreeMaterial::Missing { .. }, None) => false,
            (WorktreeMaterial::Present { .. }, Some(_)) => {
                worktree_path_differs_from_baseline(capability, baseline_revision, &accepted.path)?
            }
        };
        if worktree_changed {
            apply_worktree_material_to_index(capability, &index_path, &accepted.path, &material)?;
        } else {
            let live_entry = live_index_stage_zero_entry(capability, &accepted.path)?;
            apply_git_entry_to_index(capability, &index_path, &accepted.path, live_entry.as_ref())?;
        }
        fingerprints.insert(accepted.path.clone(), fingerprint);

        if let Some(previous) = accepted.previous_path.as_deref() {
            let previous_material = capture_worktree_material(capability, previous)?;
            let previous_fingerprint = material_fingerprint(&previous_material).clone();
            if previous_fingerprint == WorktreePathFingerprint::Missing {
                apply_git_entry_to_index(capability, &index_path, previous, None)?;
            } else if !worktree_path_differs_from_baseline(capability, baseline_revision, previous)?
            {
                let live_entry = live_index_stage_zero_entry(capability, previous)?;
                let baseline_entry = baseline_tree_entry(capability, baseline_revision, previous)?;
                if live_entry != baseline_entry {
                    apply_git_entry_to_index(
                        capability,
                        &index_path,
                        previous,
                        live_entry.as_ref(),
                    )?;
                }
            } else {
                // A rename source may be re-created or independently modified. That content is not
                // accepted by selecting the destination, so the baseline entry remains in the tree.
                let baseline_entry = baseline_tree_entry(capability, baseline_revision, previous)?;
                apply_git_entry_to_index(
                    capability,
                    &index_path,
                    previous,
                    baseline_entry.as_ref(),
                )?;
            }
            fingerprints.insert(previous.to_string(), previous_fingerprint);
        }
    }
    let tree_output = run_git_with_index(capability, &index_path, "生成成果树", ["write-tree"])?;
    let tree = validate_object_id(
        trimmed_utf8(&tree_output.stdout, "生成成果树")?,
        "生成成果树",
    )?;
    verify_worktree_fingerprints(capability, &fingerprints)?;
    ensure_tree_only_changes_accepted(capability, baseline_revision, &tree, accepted_paths)?;
    Ok(BuiltCommitTree { tree, fingerprints })
}

#[cfg(unix)]
fn material_fingerprint(material: &WorktreeMaterial) -> &WorktreePathFingerprint {
    match material {
        WorktreeMaterial::Missing { fingerprint }
        | WorktreeMaterial::Present { fingerprint, .. } => fingerprint,
    }
}

#[cfg(unix)]
fn apply_worktree_material_to_index(
    capability: &RepositoryCapability,
    index_path: &Path,
    path: &str,
    material: &WorktreeMaterial,
) -> Result<(), WorktreeCommitError> {
    match material {
        WorktreeMaterial::Missing { .. } => {
            apply_git_entry_to_index(capability, index_path, path, None)
        }
        WorktreeMaterial::Present {
            mode, object_id, ..
        } => apply_git_entry_to_index(
            capability,
            index_path,
            path,
            Some(&GitIndexEntry {
                mode: (*mode).to_string(),
                object_id: object_id.clone(),
            }),
        ),
    }
}

#[cfg(unix)]
fn apply_git_entry_to_index(
    capability: &RepositoryCapability,
    index_path: &Path,
    path: &str,
    entry: Option<&GitIndexEntry>,
) -> Result<(), WorktreeCommitError> {
    if let Some(entry) = entry {
        run_git_with_index(
            capability,
            index_path,
            "写入成果索引项",
            [
                "update-index",
                "--add",
                "--cacheinfo",
                entry.mode.as_str(),
                entry.object_id.as_str(),
                path,
            ],
        )?;
    } else {
        run_git_with_index(
            capability,
            index_path,
            "从提交树删除成果路径",
            ["update-index", "--force-remove", "--", path],
        )?;
    }
    Ok(())
}

#[cfg(unix)]
fn worktree_path_differs_from_baseline(
    capability: &RepositoryCapability,
    baseline_revision: &str,
    path: &str,
) -> Result<bool, WorktreeCommitError> {
    let output = run_git_raw(
        capability,
        [
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            baseline_revision,
            "--",
            path,
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => Err(WorktreeCommitError::GitCommand {
            operation: "比较工作树与任务基线",
            detail: stderr_detail(&output),
        }),
    }
}

#[cfg(unix)]
fn live_index_stage_zero_entry(
    capability: &RepositoryCapability,
    path: &str,
) -> Result<Option<GitIndexEntry>, WorktreeCommitError> {
    let output = run_git(
        capability,
        "读取真实索引项",
        ["ls-files", "--stage", "-z", "--", path],
    )?;
    parse_single_stage_zero_entry(&output.stdout, path, "读取真实索引项")
}

#[cfg(unix)]
fn baseline_tree_entry(
    capability: &RepositoryCapability,
    baseline_revision: &str,
    path: &str,
) -> Result<Option<GitIndexEntry>, WorktreeCommitError> {
    let output = run_git(
        capability,
        "读取任务基线树项",
        ["ls-tree", "-z", baseline_revision, "--", path],
    )?;
    let records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    if records.is_empty() {
        return Ok(None);
    }
    if records.len() != 1 {
        return Err(WorktreeCommitError::InvalidGitOutput {
            operation: "读取任务基线树项",
            detail: "单一路径返回了多个树项".into(),
        });
    }
    let record = records[0];
    let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
        return Err(WorktreeCommitError::InvalidGitOutput {
            operation: "读取任务基线树项",
            detail: "树项缺少路径".into(),
        });
    };
    let header =
        std::str::from_utf8(&record[..tab]).map_err(|_| WorktreeCommitError::InvalidGitOutput {
            operation: "读取任务基线树项",
            detail: "树项头不是 UTF-8".into(),
        })?;
    let record_path = std::str::from_utf8(&record[tab + 1..]).map_err(|_| {
        WorktreeCommitError::InvalidGitOutput {
            operation: "读取任务基线树项",
            detail: "树项路径不是 UTF-8".into(),
        }
    })?;
    if record_path != path {
        return Err(WorktreeCommitError::InvalidGitOutput {
            operation: "读取任务基线树项",
            detail: "Git 返回了意外路径".into(),
        });
    }
    let fields = header.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 3 || fields[1] != "blob" {
        return Err(WorktreeCommitError::UnsupportedFileType {
            path: path.to_string(),
        });
    }
    Ok(Some(GitIndexEntry {
        mode: validate_git_mode(fields[0], "读取任务基线树项")?,
        object_id: validate_object_id(fields[2], "读取任务基线树项")?,
    }))
}

#[cfg(unix)]
fn parse_single_stage_zero_entry(
    bytes: &[u8],
    path: &str,
    operation: &'static str,
) -> Result<Option<GitIndexEntry>, WorktreeCommitError> {
    let records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    if records.is_empty() {
        return Ok(None);
    }
    let mut stage_zero = None;
    for record in records {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation,
                detail: "索引项缺少路径".into(),
            });
        };
        let header = std::str::from_utf8(&record[..tab]).map_err(|_| {
            WorktreeCommitError::InvalidGitOutput {
                operation,
                detail: "索引项头不是 UTF-8".into(),
            }
        })?;
        let record_path = std::str::from_utf8(&record[tab + 1..]).map_err(|_| {
            WorktreeCommitError::InvalidGitOutput {
                operation,
                detail: "索引项路径不是 UTF-8".into(),
            }
        })?;
        if record_path != path {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation,
                detail: "Git 返回了意外路径".into(),
            });
        }
        let fields = header.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3 {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation,
                detail: "索引项字段数无效".into(),
            });
        }
        if fields[2] == "0" {
            if stage_zero.is_some() {
                return Err(WorktreeCommitError::InvalidGitOutput {
                    operation,
                    detail: "单一路径存在多个 stage-0 索引项".into(),
                });
            }
            stage_zero = Some(GitIndexEntry {
                mode: validate_git_mode(fields[0], operation)?,
                object_id: validate_object_id(fields[1], operation)?,
            });
        }
    }
    Ok(stage_zero)
}

#[cfg(unix)]
fn validate_git_mode(mode: &str, operation: &'static str) -> Result<String, WorktreeCommitError> {
    if matches!(mode, "100644" | "100755" | "120000") {
        Ok(mode.to_string())
    } else {
        Err(WorktreeCommitError::InvalidGitOutput {
            operation,
            detail: format!("不支持的 Git 文件模式：{mode}"),
        })
    }
}

#[cfg(unix)]
fn verify_worktree_fingerprints(
    capability: &RepositoryCapability,
    fingerprints: &BTreeMap<String, WorktreePathFingerprint>,
) -> Result<(), WorktreeCommitError> {
    for (path, before) in fingerprints {
        let after = fingerprint_worktree_path(capability, path)?;
        if before != &after {
            return Err(WorktreeCommitError::IndexChanged);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_tree_only_changes_accepted(
    capability: &RepositoryCapability,
    baseline_revision: &str,
    tree: &str,
    accepted_paths: &[AcceptedCommitPath],
) -> Result<(), WorktreeCommitError> {
    let baseline_tree_output = run_git(
        capability,
        "读取任务基线树",
        ["rev-parse", &format!("{baseline_revision}^{{tree}}")],
    )?;
    let baseline_tree = validate_object_id(
        trimmed_utf8(&baseline_tree_output.stdout, "读取任务基线树")?,
        "读取任务基线树",
    )?;
    if baseline_tree == tree {
        return Err(WorktreeCommitError::NothingToCommit);
    }
    let output = run_git(
        capability,
        "验证成果树边界",
        [
            "diff-tree",
            "-r",
            "--name-only",
            "-z",
            &baseline_tree,
            tree,
            "--",
        ],
    )?;
    let allowed = accepted_paths
        .iter()
        .flat_map(|accepted| {
            std::iter::once(accepted.path.as_str()).chain(accepted.previous_path.as_deref())
        })
        .collect::<BTreeSet<_>>();
    for raw_path in output.stdout.split(|byte| *byte == 0) {
        if raw_path.is_empty() {
            continue;
        }
        let path =
            std::str::from_utf8(raw_path).map_err(|_| WorktreeCommitError::InvalidGitOutput {
                operation: "验证成果树边界",
                detail: "变更路径不是 UTF-8".into(),
            })?;
        if !allowed.contains(path) {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation: "验证成果树边界",
                detail: format!("成果树包含未接受路径：{path}"),
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_commit_object(
    capability: &RepositoryCapability,
    tree: &str,
    baseline_revision: &str,
    message: &str,
) -> Result<String, WorktreeCommitError> {
    let output = run_git_with_stdin(
        capability,
        "创建成果提交对象",
        ["commit-tree", tree, "-p", baseline_revision],
        io::Cursor::new(message.as_bytes()),
    )?;
    validate_object_id(
        trimmed_utf8(&output.stdout, "创建成果提交对象")?,
        "创建成果提交对象",
    )
}

#[cfg(unix)]
#[derive(Debug)]
struct PreparedRealIndex {
    original_digest: [u8; 32],
    prepared_digest: [u8; 32],
    original_mode: Mode,
}

#[cfg(unix)]
fn prepare_real_index(
    capability: &RepositoryCapability,
    transaction: &CommitTransaction,
    new_revision: &str,
    accepted_paths: &[AcceptedCommitPath],
) -> Result<PreparedRealIndex, WorktreeCommitError> {
    let index_stat = statat(
        &transaction.git_directory,
        INDEX_NAME,
        AtFlags::SYMLINK_NOFOLLOW,
    )
    .map_err(|error| path_errno(INDEX_NAME, error))?;
    if FileType::from_raw_mode(index_stat.st_mode) != FileType::RegularFile {
        return Err(unsafe_path(INDEX_NAME, "Git 索引不是普通文件"));
    }
    let original_mode = Mode::from_raw_mode(index_stat.st_mode) & Mode::from_raw_mode(0o777);
    let original_digest = digest_file_at(&transaction.git_directory, INDEX_NAME)?;
    let temporary_name = transaction.real_index_temporary_name();
    copy_file_between(
        &transaction.git_directory,
        INDEX_NAME,
        &transaction.git_directory,
        &temporary_name,
        original_mode,
    )?;
    fsync(&transaction.git_directory).map_err(|error| path_errno("<git-directory>", error))?;

    let temporary_path = transaction.real_index_temporary_path();
    run_git_with_index(
        capability,
        &temporary_path,
        "展开真实 Git 索引",
        ["update-index", "--no-split-index"],
    )?;
    let object_hash_bytes = repository_object_hash_bytes(capability)?;
    let normalized_original =
        read_file_at_limited(&transaction.git_directory, &temporary_name, MAX_INDEX_BYTES)?;
    let original_entries = parse_index_entries(&normalized_original, object_hash_bytes)?;

    let affected_paths = accepted_paths
        .iter()
        .flat_map(|accepted| {
            std::iter::once(accepted.path.clone()).chain(accepted.previous_path.clone())
        })
        .collect::<Vec<_>>();
    for path in &affected_paths {
        let entry = baseline_tree_entry(capability, new_revision, path)?;
        apply_git_entry_to_index(capability, &temporary_path, path, entry.as_ref())?;
    }
    let prepared_bytes =
        read_file_at_limited(&transaction.git_directory, &temporary_name, MAX_INDEX_BYTES)?;
    let prepared_entries = parse_index_entries(&prepared_bytes, object_hash_bytes)?;
    ensure_unaccepted_index_entries_preserved(
        &original_entries,
        &prepared_entries,
        &affected_paths,
    )?;

    write_new_file_at(
        &transaction.directory,
        PREPARED_INDEX_FILE_NAME,
        &prepared_bytes,
        Mode::from_raw_mode(0o600),
    )?;
    fsync(&transaction.directory)
        .map_err(|error| path_errno("<commit-transaction-directory>", error))?;
    let prepared_digest = digest_file_at(&transaction.directory, PREPARED_INDEX_FILE_NAME)?;
    remove_if_exists(&transaction.git_directory, &temporary_name)?;
    remove_if_exists(
        &transaction.git_directory,
        &transaction.real_index_lock_name(),
    )?;
    fsync(&transaction.git_directory).map_err(|error| path_errno("<git-directory>", error))?;
    if digest_file_at(&transaction.git_directory, INDEX_NAME)? != original_digest {
        return Err(WorktreeCommitError::IndexChanged);
    }
    Ok(PreparedRealIndex {
        original_digest,
        prepared_digest,
        original_mode,
    })
}

#[cfg(unix)]
fn repository_object_hash_bytes(
    capability: &RepositoryCapability,
) -> Result<usize, WorktreeCommitError> {
    let output = run_git(
        capability,
        "读取 Git 对象格式",
        ["rev-parse", "--show-object-format"],
    )?;
    match trimmed_utf8(&output.stdout, "读取 Git 对象格式")? {
        "sha1" => Ok(20),
        "sha256" => Ok(32),
        format => Err(WorktreeCommitError::InvalidGitOutput {
            operation: "读取 Git 对象格式",
            detail: format!("不支持的对象格式：{format}"),
        }),
    }
}

#[cfg(unix)]
#[derive(Clone, Debug, Eq, PartialEq)]
struct IndexEntryState {
    fixed_fields: Vec<u8>,
}

#[cfg(unix)]
type IndexEntryMap = BTreeMap<Vec<u8>, Vec<IndexEntryState>>;

#[cfg(unix)]
fn parse_index_entries(
    bytes: &[u8],
    object_hash_bytes: usize,
) -> Result<IndexEntryMap, WorktreeCommitError> {
    if bytes.len() < 12 + object_hash_bytes || &bytes[..4] != b"DIRC" {
        return Err(WorktreeCommitError::InvalidIndex(
            "索引头或校验和缺失".into(),
        ));
    }
    let version = u32::from_be_bytes(bytes[4..8].try_into().expect("four-byte index version"));
    if !(2..=4).contains(&version) {
        return Err(WorktreeCommitError::InvalidIndex(format!(
            "不支持索引版本 {version}"
        )));
    }
    let count = u32::from_be_bytes(bytes[8..12].try_into().expect("four-byte index count"));
    if count as usize > 10_000_000 {
        return Err(WorktreeCommitError::InvalidIndex(
            "索引项数量超出安全上限".into(),
        ));
    }
    let payload_end = bytes.len() - object_hash_bytes;
    let mut offset = 12_usize;
    let mut previous_path = Vec::new();
    let mut entries = BTreeMap::<Vec<u8>, Vec<IndexEntryState>>::new();
    for _ in 0..count {
        let entry_start = offset;
        let flags_offset = entry_start
            .checked_add(40 + object_hash_bytes)
            .ok_or_else(|| WorktreeCommitError::InvalidIndex("索引项偏移溢出".into()))?;
        if flags_offset + 2 > payload_end {
            return Err(WorktreeCommitError::InvalidIndex(
                "索引项固定字段被截断".into(),
            ));
        }
        let flags = u16::from_be_bytes(
            bytes[flags_offset..flags_offset + 2]
                .try_into()
                .expect("two-byte index flags"),
        );
        let extended_bytes = if flags & 0x4000 != 0 { 2 } else { 0 };
        let fixed_end = flags_offset + 2 + extended_bytes;
        if fixed_end > payload_end {
            return Err(WorktreeCommitError::InvalidIndex(
                "索引项扩展 flags 被截断".into(),
            ));
        }
        let (path, next_offset) = if version == 4 {
            let (strip, suffix_start) = decode_index_v4_varint(bytes, fixed_end, payload_end)?;
            if strip > previous_path.len() {
                return Err(WorktreeCommitError::InvalidIndex(
                    "v4 索引路径前缀长度无效".into(),
                ));
            }
            let suffix_end = bytes[suffix_start..payload_end]
                .iter()
                .position(|byte| *byte == 0)
                .map(|relative| suffix_start + relative)
                .ok_or_else(|| WorktreeCommitError::InvalidIndex("v4 索引路径未终止".into()))?;
            let mut path = previous_path[..previous_path.len() - strip].to_vec();
            path.extend_from_slice(&bytes[suffix_start..suffix_end]);
            (path, suffix_end + 1)
        } else {
            let path_end = bytes[fixed_end..payload_end]
                .iter()
                .position(|byte| *byte == 0)
                .map(|relative| fixed_end + relative)
                .ok_or_else(|| WorktreeCommitError::InvalidIndex("索引路径未终止".into()))?;
            let path = bytes[fixed_end..path_end].to_vec();
            let raw_length = path_end + 1 - entry_start;
            let padding = (8 - raw_length % 8) % 8;
            let next = path_end
                .checked_add(1 + padding)
                .ok_or_else(|| WorktreeCommitError::InvalidIndex("索引项长度溢出".into()))?;
            if next > payload_end {
                return Err(WorktreeCommitError::InvalidIndex(
                    "索引项对齐字节被截断".into(),
                ));
            }
            (path, next)
        };
        if path.is_empty() || path.contains(&0) {
            return Err(WorktreeCommitError::InvalidIndex("索引项路径无效".into()));
        }
        entries
            .entry(path.clone())
            .or_default()
            .push(IndexEntryState {
                fixed_fields: bytes[entry_start..fixed_end].to_vec(),
            });
        previous_path = path;
        offset = next_offset;
    }
    if offset > payload_end {
        return Err(WorktreeCommitError::InvalidIndex(
            "索引项越过扩展区域".into(),
        ));
    }
    Ok(entries)
}

#[cfg(unix)]
fn decode_index_v4_varint(
    bytes: &[u8],
    mut offset: usize,
    end: usize,
) -> Result<(usize, usize), WorktreeCommitError> {
    if offset >= end {
        return Err(WorktreeCommitError::InvalidIndex(
            "v4 索引路径前缀缺失".into(),
        ));
    }
    let mut byte = bytes[offset];
    offset += 1;
    let mut value = usize::from(byte & 0x7f);
    while byte & 0x80 != 0 {
        if offset >= end {
            return Err(WorktreeCommitError::InvalidIndex(
                "v4 索引路径前缀被截断".into(),
            ));
        }
        byte = bytes[offset];
        offset += 1;
        value = value
            .checked_add(1)
            .and_then(|value| value.checked_shl(7))
            .and_then(|value| value.checked_add(usize::from(byte & 0x7f)))
            .ok_or_else(|| WorktreeCommitError::InvalidIndex("v4 路径长度溢出".into()))?;
    }
    Ok((value, offset))
}

#[cfg(unix)]
fn ensure_unaccepted_index_entries_preserved(
    original: &IndexEntryMap,
    prepared: &IndexEntryMap,
    affected_paths: &[String],
) -> Result<(), WorktreeCommitError> {
    let affected = affected_paths
        .iter()
        .map(|path| path.as_bytes().to_vec())
        .collect::<BTreeSet<_>>();
    let original_unaccepted = original
        .iter()
        .filter(|(path, _)| !affected.contains(*path))
        .collect::<BTreeMap<_, _>>();
    let prepared_unaccepted = prepared
        .iter()
        .filter(|(path, _)| !affected.contains(*path))
        .collect::<BTreeMap<_, _>>();
    if original_unaccepted == prepared_unaccepted {
        Ok(())
    } else {
        Err(WorktreeCommitError::InvalidIndex(
            "准备后的索引未逐字保留所有未接受 entry/stage/flags".into(),
        ))
    }
}

#[cfg(unix)]
fn snapshot_error(error: WorktreeMutationError) -> WorktreeCommitError {
    match error {
        WorktreeMutationError::Inspection(error) => WorktreeCommitError::Workspace(error),
        WorktreeMutationError::HeadChanged { expected, actual } => {
            WorktreeCommitError::HeadChanged { expected, actual }
        }
        WorktreeMutationError::UnmergedChanges { paths } => {
            WorktreeCommitError::UnmergedChanges { paths }
        }
        WorktreeMutationError::OperationInProgress { operation } => {
            WorktreeCommitError::OperationInProgress { operation }
        }
        WorktreeMutationError::ExpectedChangeMissing { path }
        | WorktreeMutationError::ExpectedChangeChanged { path }
        | WorktreeMutationError::RepositoryChangedDuringSnapshot { path }
        | WorktreeMutationError::UnexpectedOccupant { path }
        | WorktreeMutationError::OverlappingRename { path, .. } => {
            WorktreeCommitError::ExpectedChangeChanged { path }
        }
        WorktreeMutationError::UnsupportedSafeMutation { platform } => {
            WorktreeCommitError::UnsupportedPlatform { platform }
        }
        WorktreeMutationError::UnsafePath { path, detail } => {
            WorktreeCommitError::UnsafePath { path, detail }
        }
        WorktreeMutationError::PathUnavailable { path, source } => {
            WorktreeCommitError::PathUnavailable { path, source }
        }
        WorktreeMutationError::GitUnavailable(error) => WorktreeCommitError::GitUnavailable(error),
        WorktreeMutationError::GitCommand { operation, detail } => {
            WorktreeCommitError::GitCommand { operation, detail }
        }
        WorktreeMutationError::InvalidGitOutput { operation, detail } => {
            WorktreeCommitError::InvalidGitOutput { operation, detail }
        }
        other => WorktreeCommitError::InvalidGitOutput {
            operation: "复核已接受成果快照",
            detail: other.to_string(),
        },
    }
}

#[cfg(unix)]
fn verify_expected_snapshots(
    capability: &RepositoryCapability,
    baseline: &TaskBaseline,
    accepted_paths: &[AcceptedCommitPath],
) -> Result<(), WorktreeCommitError> {
    capability.verify_binding()?;
    let snapshots = capture_task_change_snapshots(&capability.canonical_path, baseline)
        .map_err(snapshot_error)?;
    capability.verify_binding()?;
    let by_path = snapshots
        .iter()
        .map(|snapshot| (snapshot.change.path.as_str(), snapshot))
        .collect::<BTreeMap<_, _>>();
    for accepted in accepted_paths {
        let snapshot = by_path.get(accepted.path.as_str()).ok_or_else(|| {
            WorktreeCommitError::ExpectedChangeChanged {
                path: accepted.path.clone(),
            }
        })?;
        let actual_previous = if snapshot.change.status == FileStatus::Renamed {
            snapshot.change.previous_path.as_deref()
        } else {
            None
        };
        if snapshot.snapshot_token != accepted.expected_snapshot_token
            || actual_previous != accepted.previous_path.as_deref()
        {
            return Err(WorktreeCommitError::ExpectedChangeChanged {
                path: accepted.path.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn commit_accepted_changes_unix(
    workspace_path: &Path,
    baseline: &TaskBaseline,
    accepted_paths: &[AcceptedCommitPath],
    message: &str,
    faults: CommitFaults,
) -> Result<WorktreeCommit, WorktreeCommitError> {
    let capability = open_workspace_capability(workspace_path, Some(baseline))?;
    let git = GitDirectory::open(&capability)?;
    let owner = RepositoryOwnerLock::acquire(&git)?;
    recover_all_locked(&capability, &git, &owner)?;
    owner.verify_binding()?;
    ensure_no_operation_in_progress(&git)?;
    ensure_no_unmerged_paths(&capability)?;
    let baseline_revision = ensure_baseline_head(&capability, baseline)?;
    let branch_ref = current_branch_ref(&capability)?;
    verify_expected_snapshots(&capability, baseline, accepted_paths)?;

    let mut transaction = CommitTransaction::begin(&capability, &git, baseline)?;
    owner.verify_binding()?;
    git.verify_binding()?;
    if current_branch_ref(&capability)? != branch_ref {
        return Err(WorktreeCommitError::BranchChanged);
    }
    if current_head(&capability)?.as_deref() != Some(baseline_revision.as_str()) {
        return Err(WorktreeCommitError::HeadChanged {
            expected: baseline_revision,
            actual: current_head(&capability)?,
        });
    }

    let built = build_commit_tree(
        &capability,
        &transaction,
        &baseline_revision,
        accepted_paths,
    )?;
    let new_revision = create_commit_object(&capability, &built.tree, &baseline_revision, message)?;
    let prepared = prepare_real_index(&capability, &transaction, &new_revision, accepted_paths)?;
    verify_expected_snapshots(&capability, baseline, accepted_paths)?;
    verify_worktree_fingerprints(&capability, &built.fingerprints)?;
    if current_branch_ref(&capability)? != branch_ref {
        return Err(WorktreeCommitError::BranchChanged);
    }
    if current_head(&capability)?.as_deref() != Some(baseline_revision.as_str()) {
        return Err(WorktreeCommitError::HeadChanged {
            expected: baseline_revision,
            actual: current_head(&capability)?,
        });
    }
    if digest_file_at(&git.directory, INDEX_NAME)? != prepared.original_digest {
        return Err(WorktreeCommitError::IndexChanged);
    }

    let journal = CommitJournal {
        version: JOURNAL_VERSION,
        journal_id: transaction.journal_id.clone(),
        lock_token: transaction.lock_token.clone(),
        repository_root: capability.canonical_path.clone(),
        branch_ref: branch_ref.clone(),
        baseline_revision: baseline_revision.clone(),
        new_revision: new_revision.clone(),
        original_index_sha256: encode_digest(&prepared.original_digest),
        prepared_index_sha256: encode_digest(&prepared.prepared_digest),
        original_index_mode: prepared.original_mode.as_raw_mode(),
        accepted_paths: accepted_paths.to_vec(),
    };
    transaction.write_json(JOURNAL_FILE_NAME, &journal)?;
    if faults.stop_after_journal {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: "测试故障：journal 持久化后停止".into(),
        });
    }
    if let Err(error) = owner.verify_binding() {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: format!("journal 持久化后的 owner lock 校验失败：{error}"),
        });
    }
    verify_expected_snapshots(&capability, baseline, accepted_paths)?;
    verify_worktree_fingerprints(&capability, &built.fingerprints)?;
    if current_branch_ref(&capability)? != branch_ref {
        return Err(WorktreeCommitError::BranchChanged);
    }
    if current_head(&capability)?.as_deref() != Some(baseline_revision.as_str()) {
        return Err(WorktreeCommitError::HeadChanged {
            expected: baseline_revision,
            actual: current_head(&capability)?,
        });
    }
    if digest_file_at(&git.directory, INDEX_NAME)? != prepared.original_digest {
        return Err(WorktreeCommitError::IndexChanged);
    }

    if let Err(error) = update_branch_ref(
        &capability,
        &branch_ref,
        &new_revision,
        &baseline_revision,
        "提交已接受的任务成果",
    ) {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: format!("分支 CAS 结果不确定：{error}"),
        });
    }
    if let Err(error) = owner.verify_binding() {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: format!("分支更新后的 owner lock 校验失败：{error}"),
        });
    }
    let branch_after_update = current_branch_ref(&capability);
    let head_after_update = current_head(&capability);
    if !matches!(&branch_after_update, Ok(actual) if actual == &branch_ref)
        || !matches!(&head_after_update, Ok(Some(actual)) if actual == &new_revision)
    {
        match update_branch_ref(
            &capability,
            &branch_ref,
            &baseline_revision,
            &new_revision,
            "补偿提交期间的分支切换",
        ) {
            Ok(()) => return Err(WorktreeCommitError::BranchChanged),
            Err(rollback_error) => {
                transaction.mark_for_recovery();
                return Err(WorktreeCommitError::RecoveryRequired {
                    journal_id: transaction.journal_id.clone(),
                    detail: format!("分支 CAS 后 HEAD 后置条件不成立且补偿失败：{rollback_error}"),
                });
            }
        }
    }
    if faults.stop_after_ref_update {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: "测试故障：分支更新后停止".into(),
        });
    }

    let live_index_digest = match digest_file_at(&git.directory, INDEX_NAME) {
        Ok(digest) => digest,
        Err(error) => {
            transaction.mark_for_recovery();
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: transaction.journal_id.clone(),
                detail: format!("分支已更新但无法复核真实索引：{error}"),
            });
        }
    };
    if live_index_digest != prepared.original_digest {
        match update_branch_ref(
            &capability,
            &branch_ref,
            &baseline_revision,
            &new_revision,
            "补偿未安装索引的成果提交",
        ) {
            Ok(()) => return Err(WorktreeCommitError::IndexChanged),
            Err(rollback_error) => {
                transaction.mark_for_recovery();
                return Err(WorktreeCommitError::RecoveryRequired {
                    journal_id: transaction.journal_id.clone(),
                    detail: format!("索引发生变化且分支补偿失败：{rollback_error}"),
                });
            }
        }
    }
    if let Err(error) =
        transaction.install_prepared_index(&prepared.prepared_digest, prepared.original_mode)
    {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: format!("分支已更新但真实索引安装失败：{error}"),
        });
    }
    if faults.stop_after_index_publish {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: "测试故障：真实索引发布后停止".into(),
        });
    }

    let final_state = (|| {
        owner.verify_binding()?;
        capability.verify_binding()?;
        git.verify_binding()?;
        if resolve_ref_revision(&capability, &branch_ref)? != new_revision
            || current_branch_ref(&capability)? != branch_ref
            || current_head(&capability)?.as_deref() != Some(new_revision.as_str())
            || digest_file_at(&git.directory, INDEX_NAME)? != prepared.prepared_digest
        {
            return Err(WorktreeCommitError::InvalidGitOutput {
                operation: "验证已发布提交事务",
                detail: "分支、HEAD 或真实索引未达到同一 revision".into(),
            });
        }
        Ok(())
    })();
    if let Err(error) = final_state {
        transaction.mark_for_recovery();
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: transaction.journal_id.clone(),
            detail: format!("真实索引发布后的最终一致性检查失败：{error}"),
        });
    }

    let journal_id = transaction.journal_id.clone();
    let recovery_journal_id = if let Err(_error) = transaction.release_head_lock() {
        transaction.mark_for_recovery();
        Some(journal_id)
    } else if let Err(_error) = transaction.cleanup_inner() {
        transaction.mark_for_recovery();
        Some(journal_id)
    } else {
        None
    };
    Ok(WorktreeCommit {
        revision: new_revision,
        recovery_journal_id,
        warning: None,
    })
}

#[cfg(unix)]
fn update_branch_ref(
    capability: &RepositoryCapability,
    branch_ref: &str,
    new_revision: &str,
    expected_revision: &str,
    reason: &'static str,
) -> Result<(), WorktreeCommitError> {
    let command_result = run_git_raw(
        capability,
        [
            "update-ref",
            "--no-deref",
            "-m",
            reason,
            branch_ref,
            new_revision,
            expected_revision,
        ],
    );
    let actual = resolve_ref_revision(capability, branch_ref)?;
    if actual == new_revision {
        return Ok(());
    }
    let command_detail = match command_result {
        Ok(output) if output.status.success() => "Git 报告成功但引用后置条件不成立".into(),
        Ok(output) => stderr_detail(&output),
        Err(error) => error.to_string(),
    };
    Err(WorktreeCommitError::GitCommand {
        operation: "原子更新成果分支",
        detail: format!(
            "{command_detail}；引用实际为 {actual}，期望更新为 {new_revision}（CAS 基线 {expected_revision}）"
        ),
    })
}

#[cfg(unix)]
fn recover_all_locked(
    capability: &RepositoryCapability,
    git: &GitDirectory,
    owner: &RepositoryOwnerLock,
) -> Result<Vec<CommitRecovery>, WorktreeCommitError> {
    owner.verify_binding()?;
    let Some(root) = JournalRoot::open_existing(git)? else {
        return Ok(Vec::new());
    };
    let ids = root.journal_ids(git)?;
    drop(root);
    let mut recoveries = Vec::with_capacity(ids.len());
    for journal_id in ids {
        owner.verify_binding()?;
        recoveries.push(recover_one_locked(capability, git, owner, &journal_id)?);
    }
    owner.verify_binding()?;
    Ok(recoveries)
}

#[cfg(unix)]
fn recover_one_locked(
    capability: &RepositoryCapability,
    git: &GitDirectory,
    owner: &RepositoryOwnerLock,
    journal_id: &str,
) -> Result<CommitRecovery, WorktreeCommitError> {
    owner.verify_binding()?;
    let root =
        JournalRoot::open_existing(git)?.ok_or_else(|| WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: "提交恢复目录不存在".into(),
        })?;
    let (mut transaction, intent) = CommitTransaction::open_existing(git, root, journal_id)?;
    if intent.repository_root != capability.canonical_path {
        return Err(WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: "journal 属于其他 Git 工作区".into(),
        });
    }
    let journal_bytes = read_optional_file_at_limited(
        &transaction.directory,
        JOURNAL_FILE_NAME,
        MAX_JOURNAL_BYTES,
    )?;
    let Some(journal_bytes) = journal_bytes else {
        owner.verify_binding()?;
        transaction.preserve_for_recovery = false;
        transaction.cleanup_inner()?;
        return Ok(CommitRecovery {
            journal_id: journal_id.to_string(),
            revision: None,
            action: CommitRecoveryAction::DiscardedBeforeRefUpdate,
        });
    };
    let journal: CommitJournal = serde_json::from_slice(&journal_bytes).map_err(|error| {
        WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: format!("journal 无法解析：{error}"),
        }
    })?;
    validate_commit_journal(&journal, &intent, capability)?;
    let original_digest = decode_digest(&journal.original_index_sha256, journal_id)?;
    let prepared_digest = decode_digest(&journal.prepared_index_sha256, journal_id)?;
    if digest_file_at(&transaction.directory, PREPARED_INDEX_FILE_NAME)? != prepared_digest {
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal_id.to_string(),
            detail: "durable prepared index 摘要不一致".into(),
        });
    }
    let branch_revision = resolve_ref_revision(capability, &journal.branch_ref)?;
    let actual_index_digest = digest_file_at(&git.directory, INDEX_NAME)?;

    if branch_revision == journal.baseline_revision {
        if actual_index_digest != original_digest {
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: journal_id.to_string(),
                detail: "分支尚未更新，但真实索引已经变化".into(),
            });
        }
        let index_lock = classify_index_lock(&transaction, &prepared_digest)?;
        if index_lock == RecoveryIndexLock::Prepared {
            return Err(WorktreeCommitError::RecoveryRequired {
                journal_id: journal_id.to_string(),
                detail: "分支尚未更新，但 index.lock 已包含 prepared index".into(),
            });
        }
        owner.verify_binding()?;
        transaction.preserve_for_recovery = false;
        transaction.cleanup_inner()?;
        return Ok(CommitRecovery {
            journal_id: journal_id.to_string(),
            revision: None,
            action: CommitRecoveryAction::DiscardedBeforeRefUpdate,
        });
    }

    if branch_revision != journal.new_revision {
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal_id.to_string(),
            detail: format!(
                "成果分支已偏离 journal（实际 {branch_revision}，期望 {}）",
                journal.new_revision
            ),
        });
    }
    if current_branch_ref(capability)? != journal.branch_ref {
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal_id.to_string(),
            detail: "当前 worktree 已切换到其他分支，拒绝安装遗留索引".into(),
        });
    }
    if current_head(capability)?.as_deref() != Some(journal.new_revision.as_str()) {
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal_id.to_string(),
            detail: "HEAD 与 journal 新 revision 不一致".into(),
        });
    }

    if actual_index_digest == prepared_digest {
        verify_recovered_commit_state(capability, git, owner, &journal, &prepared_digest)?;
        transaction.release_head_lock()?;
        transaction.preserve_for_recovery = false;
        transaction.cleanup_inner()?;
        return Ok(CommitRecovery {
            journal_id: journal_id.to_string(),
            revision: Some(journal.new_revision),
            action: CommitRecoveryAction::CompletedAlready,
        });
    }
    if actual_index_digest != original_digest {
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal_id.to_string(),
            detail: "真实索引既不是事务原始版本，也不是 prepared 版本".into(),
        });
    }

    if current_branch_ref(capability)? != journal.branch_ref
        || current_head(capability)?.as_deref() != Some(journal.new_revision.as_str())
        || digest_file_at(&git.directory, INDEX_NAME)? != original_digest
    {
        return Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal_id.to_string(),
            detail: "恢复锁内复检失败".into(),
        });
    }
    match classify_index_lock(&transaction, &prepared_digest)? {
        RecoveryIndexLock::Prepared => {
            transaction.publish_existing_index_lock(&prepared_digest)?;
        }
        RecoveryIndexLock::OwnedMarker => {
            transaction
                .install_prepared_index(&prepared_digest, validated_index_mode(&journal)?)?;
        }
        RecoveryIndexLock::Missing => {
            transaction.ensure_recovery_index_marker()?;
            transaction
                .install_prepared_index(&prepared_digest, validated_index_mode(&journal)?)?;
        }
        RecoveryIndexLock::Other => {
            return Err(WorktreeCommitError::RepositoryBusy {
                lock: INDEX_LOCK_NAME,
            })
        }
    }
    verify_recovered_commit_state(capability, git, owner, &journal, &prepared_digest)?;
    transaction.release_head_lock()?;
    transaction.preserve_for_recovery = false;
    transaction.cleanup_inner()?;
    Ok(CommitRecovery {
        journal_id: journal_id.to_string(),
        revision: Some(journal.new_revision),
        action: CommitRecoveryAction::InstalledPreparedIndex,
    })
}

#[cfg(unix)]
fn verify_recovered_commit_state(
    capability: &RepositoryCapability,
    git: &GitDirectory,
    owner: &RepositoryOwnerLock,
    journal: &CommitJournal,
    prepared_digest: &[u8; 32],
) -> Result<(), WorktreeCommitError> {
    let state: Result<bool, WorktreeCommitError> = (|| {
        owner.verify_binding()?;
        capability.verify_binding()?;
        git.verify_binding()?;
        Ok(
            resolve_ref_revision(capability, &journal.branch_ref)? == journal.new_revision
                && current_branch_ref(capability)? == journal.branch_ref
                && current_head(capability)?.as_deref() == Some(journal.new_revision.as_str())
                && digest_file_at(&git.directory, INDEX_NAME)? == *prepared_digest,
        )
    })();
    match state {
        Ok(true) => Ok(()),
        Ok(false) => Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal.journal_id.clone(),
            detail: "恢复发布后分支、HEAD 或真实索引不一致".into(),
        }),
        Err(error) => Err(WorktreeCommitError::RecoveryRequired {
            journal_id: journal.journal_id.clone(),
            detail: format!("恢复发布后的最终一致性检查失败：{error}"),
        }),
    }
}

#[cfg(unix)]
fn validate_commit_journal(
    journal: &CommitJournal,
    intent: &CommitIntent,
    capability: &RepositoryCapability,
) -> Result<(), WorktreeCommitError> {
    let journal_id = journal.journal_id.as_str();
    if journal.version != JOURNAL_VERSION
        || journal.journal_id != intent.journal_id
        || journal.lock_token != intent.lock_token
        || journal.repository_root != intent.repository_root
        || journal.repository_root != capability.canonical_path
        || journal.baseline_revision != intent.baseline_revision.to_ascii_lowercase()
        || !journal.branch_ref.starts_with("refs/heads/")
    {
        return Err(WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: "journal 与 intent 或工作区不一致".into(),
        });
    }
    validate_object_id(&journal.baseline_revision, "验证提交恢复 journal")?;
    validate_object_id(&journal.new_revision, "验证提交恢复 journal")?;
    validate_accepted_paths(&journal.accepted_paths).map_err(|error| {
        WorktreeCommitError::DamagedJournal {
            journal_id: journal_id.to_string(),
            detail: error.to_string(),
        }
    })?;
    validated_index_mode(journal)?;
    Ok(())
}

#[cfg(unix)]
fn validated_index_mode(journal: &CommitJournal) -> Result<Mode, WorktreeCommitError> {
    if journal.original_index_mode & !0o777 != 0 || journal.original_index_mode == 0 {
        return Err(WorktreeCommitError::DamagedJournal {
            journal_id: journal.journal_id.clone(),
            detail: "真实索引权限模式无效".into(),
        });
    }
    Ok(Mode::from_raw_mode(journal.original_index_mode))
}

#[cfg(unix)]
fn resolve_ref_revision(
    capability: &RepositoryCapability,
    reference: &str,
) -> Result<String, WorktreeCommitError> {
    if !reference.starts_with("refs/heads/") {
        return Err(WorktreeCommitError::InvalidGitOutput {
            operation: "读取恢复分支",
            detail: "分支引用无效".into(),
        });
    }
    let expression = format!("{reference}^{{commit}}");
    let output = run_git(
        capability,
        "读取恢复分支",
        ["rev-parse", "--verify", &expression],
    )?;
    validate_object_id(
        trimmed_utf8(&output.stdout, "读取恢复分支")?,
        "读取恢复分支",
    )
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryIndexLock {
    Missing,
    OwnedMarker,
    Prepared,
    Other,
}

#[cfg(unix)]
fn classify_index_lock(
    transaction: &CommitTransaction,
    prepared_digest: &[u8; 32],
) -> Result<RecoveryIndexLock, WorktreeCommitError> {
    let Some(bytes) = read_optional_file_at_limited(
        &transaction.git_directory,
        INDEX_LOCK_NAME,
        MAX_INDEX_BYTES,
    )?
    else {
        return Ok(RecoveryIndexLock::Missing);
    };
    let marker = lock_marker(&transaction.journal_id, &transaction.lock_token, "index");
    if bytes == marker {
        return Ok(RecoveryIndexLock::OwnedMarker);
    }
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    if &digest == prepared_digest {
        Ok(RecoveryIndexLock::Prepared)
    } else {
        Ok(RecoveryIndexLock::Other)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::worktree::capture_task_baseline;
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        process::Command,
        thread,
        time::{Duration, Instant},
    };
    use tempfile::TempDir;

    struct TestRepository {
        directory: TempDir,
    }

    impl TestRepository {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("create temporary repository");
            let repository = Self { directory };
            repository.git(["init", "-q"]);
            repository.git(["config", "user.name", "JoyDSH Test"]);
            repository.git(["config", "user.email", "joydsh@example.test"]);
            repository.git(["config", "core.fileMode", "true"]);
            repository
        }

        fn path(&self) -> &Path {
            self.directory.path()
        }

        fn git<I, S>(&self, args: I) -> String
        where
            I: IntoIterator<Item = S>,
            S: AsRef<OsStr>,
        {
            let output = Command::new("git")
                .arg("-C")
                .arg(self.path())
                .args(args)
                .env("LC_ALL", "C")
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout)
                .expect("git output is UTF-8")
                .trim()
                .to_string()
        }

        fn commit_all(&self, message: &str) -> String {
            self.git(["add", "--all", "--"]);
            self.git(["commit", "-qm", message]);
            self.git(["rev-parse", "HEAD"])
        }

        fn baseline(&self) -> TaskBaseline {
            capture_task_baseline(self.path()).expect("capture baseline")
        }

        fn show(&self, revision: &str, path: &str) -> Vec<u8> {
            let output = Command::new("git")
                .arg("-C")
                .arg(self.path())
                .args(["show", &format!("{revision}:{path}")])
                .output()
                .expect("show committed path");
            assert!(
                output.status.success(),
                "git show failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        }

        fn index_entries(&self) -> IndexEntryMap {
            let bytes = fs::read(self.path().join(".git/index")).expect("read index");
            parse_index_entries(&bytes, 20).expect("parse index")
        }

        fn head(&self) -> String {
            self.git(["rev-parse", "HEAD"])
        }
    }

    fn expected(
        repository: &TestRepository,
        baseline: &TaskBaseline,
        mut selection: AcceptedCommitPath,
    ) -> AcceptedCommitPath {
        let snapshots = capture_task_change_snapshots(repository.path(), baseline)
            .expect("capture expected commit snapshots");
        selection.expected_snapshot_token = snapshots
            .into_iter()
            .find(|snapshot| snapshot.change.path == selection.path)
            .expect("selected change exists")
            .snapshot_token;
        selection
    }

    fn accepted(
        repository: &TestRepository,
        baseline: &TaskBaseline,
        path: &str,
    ) -> AcceptedCommitPath {
        expected(
            repository,
            baseline,
            AcceptedCommitPath {
                path: path.to_string(),
                previous_path: None,
                expected_snapshot_token: String::new(),
            },
        )
    }

    fn renamed(
        repository: &TestRepository,
        baseline: &TaskBaseline,
        previous: &str,
        current: &str,
    ) -> AcceptedCommitPath {
        expected(
            repository,
            baseline,
            AcceptedCommitPath {
                path: current.to_string(),
                previous_path: Some(previous.to_string()),
                expected_snapshot_token: String::new(),
            },
        )
    }

    fn recover_journal(repository: &TestRepository, journal_id: &str) -> CommitRecovery {
        recover_pending_worktree_commits(repository.path())
            .unwrap()
            .into_iter()
            .find(|recovery| recovery.journal_id == journal_id)
            .expect("recover requested journal")
    }

    #[test]
    fn owner_lock_child_process() {
        let Some(repository_path) = std::env::var_os("JOYDSH_OWNER_LOCK_CHILD_REPOSITORY") else {
            return;
        };
        let ready_path = PathBuf::from(
            std::env::var_os("JOYDSH_OWNER_LOCK_CHILD_READY").expect("child ready path"),
        );
        let release_path = PathBuf::from(
            std::env::var_os("JOYDSH_OWNER_LOCK_CHILD_RELEASE").expect("child release path"),
        );
        let baseline = capture_task_baseline(Path::new(&repository_path)).expect("child baseline");
        let capability =
            open_workspace_capability(Path::new(&repository_path), Some(&baseline)).unwrap();
        let git = GitDirectory::open(&capability).unwrap();
        let _owner = RepositoryOwnerLock::acquire(&git).unwrap();
        let _transaction = CommitTransaction::begin(&capability, &git, &baseline).unwrap();
        fs::write(&ready_path, b"ready\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while !release_path.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn recovery_cannot_disassemble_another_process_active_transaction() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let ready_path = repository.path().join("owner-child-ready");
        let release_path = repository.path().join("owner-child-release");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "worktree_commits::tests::owner_lock_child_process",
                "--nocapture",
            ])
            .env("JOYDSH_OWNER_LOCK_CHILD_REPOSITORY", repository.path())
            .env("JOYDSH_OWNER_LOCK_CHILD_READY", &ready_path)
            .env("JOYDSH_OWNER_LOCK_CHILD_RELEASE", &release_path)
            .spawn()
            .expect("spawn owner lock child");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready_path.exists() && Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let ready = ready_path.exists();
        let journal_root = repository.path().join(".git").join(JOURNAL_ROOT_NAME);
        let journals_before = fs::read_dir(&journal_root)
            .map(|entries| entries.count())
            .unwrap_or_default();
        let index_lock_before = fs::read(repository.path().join(".git/index.lock")).ok();
        let recovery = recover_pending_worktree_commits(repository.path());
        let journals_after = fs::read_dir(&journal_root)
            .map(|entries| entries.count())
            .unwrap_or_default();
        let index_lock_after = fs::read(repository.path().join(".git/index.lock")).ok();
        fs::write(&release_path, b"release\n").unwrap();
        let child_status = child.wait().unwrap();

        assert!(ready, "owner lock child did not become ready");
        assert!(child_status.success());
        assert!(matches!(
            recovery,
            Err(WorktreeCommitError::RepositoryBusy {
                lock: OWNER_LOCK_NAME
            })
        ));
        assert_eq!(journals_before, 1);
        assert_eq!(journals_after, journals_before);
        assert!(index_lock_before.is_some());
        assert_eq!(index_lock_after, index_lock_before);
    }

    #[test]
    fn commits_only_accepted_final_content_and_preserves_unaccepted_index_entries() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("index-only.txt"), b"base index\n").unwrap();
        fs::write(repository.path().join("mixed.txt"), b"base mixed\n").unwrap();
        fs::write(repository.path().join("unaccepted.txt"), b"base rejected\n").unwrap();
        fs::write(repository.path().join("deleted.txt"), b"delete me\n").unwrap();
        fs::write(repository.path().join("old-name.txt"), b"rename body\n").unwrap();
        fs::write(repository.path().join("copy-source.txt"), b"copy body\n").unwrap();
        fs::write(repository.path().join("tool.sh"), b"#!/bin/sh\nexit 0\n").unwrap();
        symlink("first-target", repository.path().join("current-link")).unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();

        fs::write(repository.path().join("index-only.txt"), b"staged only\n").unwrap();
        repository.git(["add", "--", "index-only.txt"]);
        fs::write(repository.path().join("index-only.txt"), b"base index\n").unwrap();

        fs::write(
            repository.path().join("mixed.txt"),
            b"intermediate staged\n",
        )
        .unwrap();
        repository.git(["add", "--", "mixed.txt"]);
        fs::write(repository.path().join("mixed.txt"), b"final worktree\n").unwrap();

        fs::write(
            repository.path().join("unaccepted.txt"),
            b"rejected staged\n",
        )
        .unwrap();
        repository.git(["add", "--", "unaccepted.txt"]);
        repository.git(["update-index", "--assume-unchanged", "--", "unaccepted.txt"]);
        fs::write(
            repository.path().join("unaccepted.txt"),
            b"rejected worktree\n",
        )
        .unwrap();

        fs::remove_file(repository.path().join("deleted.txt")).unwrap();
        fs::rename(
            repository.path().join("old-name.txt"),
            repository.path().join("new-name.txt"),
        )
        .unwrap();
        repository.git(["add", "--", "old-name.txt", "new-name.txt"]);
        fs::copy(
            repository.path().join("copy-source.txt"),
            repository.path().join("copy-target.txt"),
        )
        .unwrap();
        fs::write(
            repository.path().join("copy-source.txt"),
            b"copy source staged but unaccepted\n",
        )
        .unwrap();
        repository.git(["add", "--", "copy-source.txt"]);
        repository.git([
            "update-index",
            "--assume-unchanged",
            "--",
            "copy-source.txt",
        ]);
        fs::write(repository.path().join("binary.dat"), [0, 1, 2, 255]).unwrap();
        let mut tool_permissions = fs::metadata(repository.path().join("tool.sh"))
            .unwrap()
            .permissions();
        tool_permissions.set_mode(0o755);
        fs::set_permissions(repository.path().join("tool.sh"), tool_permissions).unwrap();
        fs::remove_file(repository.path().join("current-link")).unwrap();
        symlink("second-target", repository.path().join("current-link")).unwrap();

        let index_before = repository.index_entries();
        let result = commit_accepted_changes(
            repository.path(),
            &baseline,
            &[
                accepted(&repository, &baseline, "index-only.txt"),
                accepted(&repository, &baseline, "mixed.txt"),
                accepted(&repository, &baseline, "deleted.txt"),
                renamed(&repository, &baseline, "old-name.txt", "new-name.txt"),
                accepted(&repository, &baseline, "copy-target.txt"),
                accepted(&repository, &baseline, "binary.dat"),
                accepted(&repository, &baseline, "tool.sh"),
                accepted(&repository, &baseline, "current-link"),
            ],
            "Commit accepted task artifacts\n",
        )
        .unwrap();

        assert_eq!(result.recovery_journal_id, None);
        assert_eq!(repository.head(), result.revision);
        assert_eq!(
            repository.show(&result.revision, "index-only.txt"),
            b"staged only\n"
        );
        assert_eq!(
            repository.show(&result.revision, "mixed.txt"),
            b"final worktree\n"
        );
        assert_eq!(
            repository.show(&result.revision, "unaccepted.txt"),
            b"base rejected\n"
        );
        assert_eq!(
            repository.show(&result.revision, "new-name.txt"),
            b"rename body\n"
        );
        assert_eq!(
            repository.show(&result.revision, "copy-source.txt"),
            b"copy body\n"
        );
        assert_eq!(
            repository.show(&result.revision, "copy-target.txt"),
            b"copy body\n"
        );
        assert_eq!(
            repository.git(["show", ":copy-source.txt"]),
            "copy source staged but unaccepted"
        );
        assert_eq!(
            repository.show(&result.revision, "binary.dat"),
            [0, 1, 2, 255]
        );
        assert_eq!(
            repository.show(&result.revision, "current-link"),
            b"second-target"
        );
        assert!(repository
            .git(["ls-tree", &result.revision, "--", "deleted.txt"])
            .is_empty());
        assert_eq!(
            repository.git(["ls-tree", &result.revision, "--", "tool.sh"])[..6].to_string(),
            "100755"
        );

        let index_after = repository.index_entries();
        assert_eq!(
            index_before.get(b"unaccepted.txt".as_slice()),
            index_after.get(b"unaccepted.txt".as_slice())
        );
        assert_eq!(
            index_before.get(b"copy-source.txt".as_slice()),
            index_after.get(b"copy-source.txt".as_slice())
        );
        assert_eq!(
            repository.git(["show", ":unaccepted.txt"]),
            "rejected staged"
        );
        assert_eq!(
            fs::read(repository.path().join("unaccepted.txt")).unwrap(),
            b"rejected worktree\n"
        );
        assert!(!repository.path().join(".git/index.lock").exists());
        assert!(!repository.path().join(".git/HEAD.lock").exists());
    }

    #[test]
    fn staged_and_unstaged_on_the_same_path_commits_the_final_worktree() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("artifact.txt"), b"staged\n").unwrap();
        repository.git(["add", "--", "artifact.txt"]);
        fs::write(repository.path().join("artifact.txt"), b"final\n").unwrap();

        let result = commit_accepted_changes(
            repository.path(),
            &baseline,
            &[accepted(&repository, &baseline, "artifact.txt")],
            "Commit final worktree",
        )
        .unwrap();

        assert_eq!(
            repository.show(&result.revision, "artifact.txt"),
            b"final\n"
        );
        assert!(repository
            .git(["diff", "--cached", "--name-only", &result.revision, "--"])
            .is_empty());
    }

    #[test]
    fn changed_accepted_snapshot_is_rejected_without_publishing_ref_or_index() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("artifact.txt"), b"accepted A\n").unwrap();
        let selection = accepted(&repository, &baseline, "artifact.txt");
        let index_before = fs::read(repository.path().join(".git/index")).unwrap();

        fs::write(repository.path().join("artifact.txt"), b"changed B\n").unwrap();
        let error = commit_accepted_changes(
            repository.path(),
            &baseline,
            &[selection],
            "Reject stale accepted content",
        )
        .unwrap_err();

        assert!(matches!(
            error,
            WorktreeCommitError::ExpectedChangeChanged { ref path }
                if path == "artifact.txt"
        ));
        assert_eq!(repository.head(), baseline.revision);
        assert_eq!(
            fs::read(repository.path().join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(
            fs::read(repository.path().join("artifact.txt")).unwrap(),
            b"changed B\n"
        );
    }

    #[test]
    fn linked_worktree_uses_its_pinned_git_and_common_directories() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        let initial_revision = repository.commit_all("initial");
        let linked_parent = tempfile::tempdir().unwrap();
        let linked_path = linked_parent.path().join("linked");
        repository.git([
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("-q"),
            OsStr::new("-b"),
            OsStr::new("joydsh-linked-test"),
            linked_path.as_os_str(),
        ]);
        let baseline = capture_task_baseline(&linked_path).unwrap();
        fs::write(linked_path.join("artifact.txt"), b"linked task\n").unwrap();
        let snapshot = capture_task_change_snapshots(&linked_path, &baseline)
            .unwrap()
            .into_iter()
            .find(|snapshot| snapshot.change.path == "artifact.txt")
            .unwrap();
        let selection = AcceptedCommitPath {
            path: "artifact.txt".into(),
            previous_path: None,
            expected_snapshot_token: snapshot.snapshot_token,
        };

        let result = commit_accepted_changes(
            &linked_path,
            &baseline,
            &[selection],
            "Commit linked worktree task",
        )
        .unwrap();
        let linked_head = Command::new("git")
            .arg("-C")
            .arg(&linked_path)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap();

        assert!(linked_head.status.success());
        assert_eq!(
            String::from_utf8(linked_head.stdout).unwrap().trim(),
            result.revision
        );
        assert_eq!(repository.head(), initial_revision);
        assert_eq!(
            repository.show(&result.revision, "artifact.txt"),
            b"linked task\n"
        );
    }

    #[test]
    fn ref_updated_crash_is_recovered_by_installing_the_prepared_index() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("artifact.txt"), b"task\n").unwrap();

        let error = commit_accepted_changes_with_faults(
            repository.path(),
            &baseline,
            &[accepted(&repository, &baseline, "artifact.txt")],
            "Commit with recovery",
            CommitFaults {
                stop_after_ref_update: true,
                ..CommitFaults::default()
            },
        )
        .unwrap_err();
        let journal_id = match error {
            WorktreeCommitError::RecoveryRequired { journal_id, .. } => journal_id,
            other => panic!("unexpected error: {other}"),
        };
        let revision_after_ref = repository.head();
        assert_ne!(revision_after_ref, baseline.revision);
        assert!(repository.path().join(".git/index.lock").exists());
        assert!(!repository.path().join(".git/HEAD.lock").exists());

        let recovery = recover_journal(&repository, &journal_id);

        assert_eq!(
            recovery.action,
            CommitRecoveryAction::InstalledPreparedIndex
        );
        assert_eq!(
            recovery.revision.as_deref(),
            Some(revision_after_ref.as_str())
        );
        assert!(repository
            .git(["diff", "--cached", "--name-only", "HEAD", "--"])
            .is_empty());
        assert!(!repository.path().join(".git/index.lock").exists());
        assert!(!repository.path().join(".git/HEAD.lock").exists());
    }

    #[test]
    fn journal_before_ref_is_discarded_without_advancing_head() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("artifact.txt"), b"task\n").unwrap();

        let error = commit_accepted_changes_with_faults(
            repository.path(),
            &baseline,
            &[accepted(&repository, &baseline, "artifact.txt")],
            "Never publish ref",
            CommitFaults {
                stop_after_journal: true,
                ..CommitFaults::default()
            },
        )
        .unwrap_err();
        let journal_id = match error {
            WorktreeCommitError::RecoveryRequired { journal_id, .. } => journal_id,
            other => panic!("unexpected error: {other}"),
        };

        let recovery = recover_journal(&repository, &journal_id);

        assert_eq!(
            recovery.action,
            CommitRecoveryAction::DiscardedBeforeRefUpdate
        );
        assert_eq!(repository.head(), baseline.revision);
        assert_eq!(
            fs::read(repository.path().join("artifact.txt")).unwrap(),
            b"task\n"
        );
        assert!(!repository.path().join(".git/index.lock").exists());
        assert!(!repository.path().join(".git/HEAD.lock").exists());
    }

    #[test]
    fn published_index_crash_is_completed_without_rewriting_it() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("artifact.txt"), b"task\n").unwrap();

        let error = commit_accepted_changes_with_faults(
            repository.path(),
            &baseline,
            &[accepted(&repository, &baseline, "artifact.txt")],
            "Publish before crash",
            CommitFaults {
                stop_after_index_publish: true,
                ..CommitFaults::default()
            },
        )
        .unwrap_err();
        let journal_id = match error {
            WorktreeCommitError::RecoveryRequired { journal_id, .. } => journal_id,
            other => panic!("unexpected error: {other}"),
        };
        let index_before = fs::read(repository.path().join(".git/index")).unwrap();

        let recovery = recover_journal(&repository, &journal_id);

        assert_eq!(recovery.action, CommitRecoveryAction::CompletedAlready);
        assert_eq!(
            fs::read(repository.path().join(".git/index")).unwrap(),
            index_before
        );
        assert!(!repository.path().join(".git/HEAD.lock").exists());
    }

    #[test]
    fn detached_head_and_foreign_index_lock_are_rejected_without_mutation() {
        let detached = TestRepository::new();
        fs::write(detached.path().join("artifact.txt"), b"base\n").unwrap();
        detached.commit_all("initial");
        let baseline = detached.baseline();
        fs::write(detached.path().join("artifact.txt"), b"task\n").unwrap();
        detached.git(["checkout", "--detach", "-q"]);
        let error = commit_accepted_changes(
            detached.path(),
            &baseline,
            &[accepted(&detached, &baseline, "artifact.txt")],
            "Detached commit",
        )
        .unwrap_err();
        assert!(matches!(error, WorktreeCommitError::DetachedHead));
        assert_eq!(detached.head(), baseline.revision);

        let locked = TestRepository::new();
        fs::write(locked.path().join("artifact.txt"), b"base\n").unwrap();
        locked.commit_all("initial");
        let baseline = locked.baseline();
        fs::write(locked.path().join("artifact.txt"), b"task\n").unwrap();
        fs::write(locked.path().join(".git/index.lock"), b"foreign owner\n").unwrap();
        let error = commit_accepted_changes(
            locked.path(),
            &baseline,
            &[accepted(&locked, &baseline, "artifact.txt")],
            "Locked commit",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorktreeCommitError::RepositoryBusy {
                lock: INDEX_LOCK_NAME
            }
        ));
        assert_eq!(
            fs::read(locked.path().join(".git/index.lock")).unwrap(),
            b"foreign owner\n"
        );
        assert_eq!(locked.head(), baseline.revision);
    }

    #[test]
    fn commit_tree_does_not_run_hooks_or_signing_programs() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("artifact.txt"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("artifact.txt"), b"task\n").unwrap();
        let hooks = repository.path().join("hooks");
        fs::create_dir(&hooks).unwrap();
        let hook_marker = repository.path().join("hook-ran");
        let signer_marker = repository.path().join("signer-ran");
        let hook = hooks.join("commit-msg");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\nprintf hook > '{}'\nexit 1\n",
                hook_marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let signer = repository.path().join("fake-signer");
        fs::write(
            &signer,
            format!(
                "#!/bin/sh\nprintf signer > '{}'\nexit 1\n",
                signer_marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&signer, fs::Permissions::from_mode(0o755)).unwrap();
        repository.git(["config", "core.hooksPath", hooks.to_str().unwrap()]);
        repository.git(["config", "commit.gpgSign", "true"]);
        repository.git(["config", "gpg.program", signer.to_str().unwrap()]);

        commit_accepted_changes(
            repository.path(),
            &baseline,
            &[accepted(&repository, &baseline, "artifact.txt")],
            "Unsigned direct commit-tree",
        )
        .unwrap();

        assert!(!hook_marker.exists());
        assert!(!signer_marker.exists());
    }
}
