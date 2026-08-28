use crate::worktree::{
    inspect_changes_from_task_baseline, validate_git_workspace, FileChange, FileStatus,
    TaskBaseline, WorktreeError, WorktreeInspection,
};
#[cfg(unix)]
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fmt, fs, io,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Output},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

#[cfg(unix)]
use rustix::{
    fd::OwnedFd,
    fs::{
        fchmod, fstat, fsync, mkdirat, open, openat, readlinkat, renameat, renameat_with, statat,
        symlinkat, unlinkat, AtFlags, FileType, Mode, OFlags, RenameFlags,
    },
    io::{dup, Errno},
};
#[cfg(unix)]
use std::{
    ffi::OsString,
    os::unix::{fs::MetadataExt, process::CommandExt},
    os::{
        fd::{AsRawFd, BorrowedFd},
        unix::ffi::OsStringExt,
    },
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
};
#[cfg(unix)]
use tempfile::NamedTempFile;

#[cfg(unix)]
static ROLLBACK_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
static MUTATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(unix)]
static RECOVERY_REQUIRED_REPOSITORIES: OnceLock<Mutex<BTreeMap<(u64, u64), String>>> =
    OnceLock::new();

#[cfg(unix)]
const RECOVERY_INDEX_NAME: &str = "original-index";
#[cfg(unix)]
const RECOVERY_MANIFEST_NAME: &str = "manifest.json";
#[cfg(unix)]
const RECOVERY_MANIFEST_VERSION: u32 = 2;
#[cfg(unix)]
const RECOVERY_OWNER_LOCK_NAME: &str = "joydsh-commit.lock";
#[cfg(unix)]
const RECOVERY_INDEX_LOCK_NAME: &str = "index.lock";
#[cfg(unix)]
const MAX_RECOVERY_MANIFEST_BYTES: u64 = 1024 * 1024;
#[cfg(unix)]
const MAX_RECOVERY_INDEX_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(unix)]
const MAX_RECOVERY_PATHS: usize = 1_000;
#[cfg(unix)]
const MAX_RECOVERY_PATH_BYTES: usize = 4 * 1024;

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeMutation {
    pub(crate) affected_paths: Vec<String>,
    pub(crate) inspection: WorktreeInspection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileChangeSnapshot {
    pub(crate) change: FileChange,
    pub(crate) snapshot_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadonlyTaskChangeSnapshots {
    pub(crate) inspection: WorktreeInspection,
    pub(crate) snapshots: Vec<FileChangeSnapshot>,
}

#[derive(Debug)]
pub(crate) enum WorktreeMutationError {
    Inspection(WorktreeError),
    HeadChanged {
        expected: String,
        actual: Option<String>,
    },
    UnmergedChanges {
        paths: Vec<String>,
    },
    OperationInProgress {
        operation: &'static str,
    },
    ExpectedChangeMissing {
        path: String,
    },
    ExpectedChangeChanged {
        path: String,
    },
    RepositoryChangedDuringSnapshot {
        path: String,
    },
    UnsupportedSafeMutation {
        platform: &'static str,
    },
    OverlappingRename {
        path: String,
        conflicting_paths: Vec<String>,
    },
    UnexpectedOccupant {
        path: String,
    },
    RecoveryRequired {
        detail: String,
    },
    UnsafePath {
        path: String,
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
    PostconditionFailed {
        remaining_paths: Vec<String>,
    },
}

impl fmt::Display for WorktreeMutationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Inspection(error) => write!(formatter, "无法检查任务变更：{error}"),
            Self::HeadChanged { expected, actual } => write!(
                formatter,
                "HEAD 已偏离任务基线（期望 {expected}，实际 {}），已拒绝回滚",
                actual.as_deref().unwrap_or("无提交")
            ),
            Self::UnmergedChanges { paths } => write!(
                formatter,
                "工作区存在未解决冲突，已拒绝回滚：{}",
                paths.join("、")
            ),
            Self::OperationInProgress { operation } => {
                write!(formatter, "Git 正在进行{operation}，已拒绝回滚")
            }
            Self::ExpectedChangeMissing { path } => {
                write!(formatter, "待拒绝的变更已不存在：{path}")
            }
            Self::ExpectedChangeChanged { path } => {
                write!(formatter, "文件变更已更新，请重新检查后再拒绝：{path}")
            }
            Self::RepositoryChangedDuringSnapshot { path } => {
                write!(
                    formatter,
                    "生成文件变更快照期间内容发生变化，请重试：{path}"
                )
            }
            Self::UnsupportedSafeMutation { platform } => write!(
                formatter,
                "当前 {platform} 构建尚不支持可证明不越界的文件回滚"
            ),
            Self::OverlappingRename {
                path,
                conflicting_paths,
            } => write!(
                formatter,
                "重命名 {path} 与其他文件变更重叠，请先处理：{}",
                conflicting_paths.join("、")
            ),
            Self::UnexpectedOccupant { path } => write!(
                formatter,
                "路径 {path:?} 出现了 Git 状态未报告的文件，已拒绝覆盖"
            ),
            Self::RecoveryRequired { detail } => {
                write!(
                    formatter,
                    "回滚补偿未能安全完成，已阻断后续文件操作：{detail}"
                )
            }
            Self::UnsafePath { path, detail } => {
                write!(formatter, "拒绝操作不安全的文件路径 {path:?}：{detail}")
            }
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
            Self::PostconditionFailed { remaining_paths } => write!(
                formatter,
                "回滚后仍存在任务变更：{}",
                remaining_paths.join("、")
            ),
        }
    }
}

impl std::error::Error for WorktreeMutationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Inspection(error) => Some(error),
            Self::PathUnavailable { source, .. } | Self::GitUnavailable(source) => Some(source),
            _ => None,
        }
    }
}

impl From<WorktreeError> for WorktreeMutationError {
    fn from(error: WorktreeError) -> Self {
        Self::Inspection(error)
    }
}

fn ensure_safe_mutation_supported() -> Result<(), WorktreeMutationError> {
    if cfg!(unix) {
        Ok(())
    } else {
        Err(WorktreeMutationError::UnsupportedSafeMutation {
            platform: std::env::consts::OS,
        })
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct RepositoryCapability {
    canonical_path: PathBuf,
    root: OwnedFd,
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl RepositoryCapability {
    fn open(repository_root: &Path) -> Result<Self, WorktreeMutationError> {
        let canonical_path = fs::canonicalize(repository_root).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
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
            inode: stat.st_ino as u64,
        };
        capability.verify_binding()?;
        Ok(capability)
    }

    fn identity(&self) -> (u64, u64) {
        (self.device, self.inode)
    }

    fn verify_binding(&self) -> Result<(), WorktreeMutationError> {
        let current = open_absolute_directory(&self.canonical_path)?;
        let stat = fstat(&current).map_err(|error| path_errno("<repository-root>", error))?;
        if stat.st_dev as u64 != self.device || stat.st_ino as u64 != self.inode {
            return Err(unsafe_path(
                self.canonical_path.to_string_lossy().as_ref(),
                "工作区根目录或其祖先在操作期间发生替换",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
fn open_absolute_directory(path: &Path) -> Result<OwnedFd, WorktreeMutationError> {
    if !path.is_absolute() {
        return Err(unsafe_path(
            path.to_string_lossy().as_ref(),
            "工作区根目录不是绝对路径",
        ));
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW;
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
                    "工作区根目录路径包含符号链接或非目录组件",
                )
            } else {
                path_errno(path.to_string_lossy().as_ref(), error)
            }
        })?;
    }
    Ok(directory)
}

#[cfg(unix)]
fn mutation_process_lock() -> &'static Mutex<()> {
    MUTATION_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(unix)]
fn recovery_required_repositories() -> &'static Mutex<BTreeMap<(u64, u64), String>> {
    RECOVERY_REQUIRED_REPOSITORIES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[cfg(unix)]
fn ensure_recovery_not_required(
    capability: &RepositoryCapability,
) -> Result<(), WorktreeMutationError> {
    let blocked = recovery_required_repositories()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(detail) = blocked.get(&capability.identity()) {
        return Err(WorktreeMutationError::RecoveryRequired {
            detail: detail.clone(),
        });
    }
    drop(blocked);

    let output = run_git_capability(
        capability,
        "定位 Git 元数据目录",
        ["rev-parse", "--absolute-git-dir"],
    )?;
    let git_directory = PathBuf::from(trimmed_utf8(&output.stdout, "定位 Git 元数据目录")?);
    let git_directory = fs::canonicalize(&git_directory).map_err(|source| {
        WorktreeMutationError::PathUnavailable {
            path: git_directory.clone(),
            source,
        }
    })?;
    let pending = pending_recovery_directories(&git_directory)?;
    if !pending.is_empty() {
        return Err(WorktreeMutationError::RecoveryRequired {
            detail: format!("发现未完成的持久恢复 journal：{}", pending.join("、")),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn mark_recovery_required(capability: &RepositoryCapability, detail: String) {
    recovery_required_repositories()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(capability.identity(), detail);
}

#[cfg(unix)]
fn configured_git_command_for_capability(capability: &RepositoryCapability) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("--literal-pathspecs")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
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
        .env_remove("GIT_CONFIG_COUNT");
    let root_fd = capability.root.as_raw_fd();
    // SAFETY: the borrowed descriptor remains owned by `capability` until the child has spawned;
    // fchdir is async-signal-safe and the closure performs no allocation or shared-state access.
    unsafe {
        command.pre_exec(move || {
            let root = BorrowedFd::borrow_raw(root_fd);
            rustix::process::fchdir(root).map_err(io::Error::from)
        });
    }
    command
}

#[cfg(unix)]
fn run_git_capability<I, S>(
    capability: &RepositoryCapability,
    operation: &'static str,
    args: I,
) -> Result<Output, WorktreeMutationError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    capability.verify_binding()?;
    let output = configured_git_command_for_capability(capability)
        .args(args)
        .output()
        .map_err(WorktreeMutationError::GitUnavailable)?;
    capability.verify_binding()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeMutationError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

#[cfg(unix)]
fn run_git_capability_with_index<I, S>(
    capability: &RepositoryCapability,
    index_path: &Path,
    operation: &'static str,
    args: I,
) -> Result<Output, WorktreeMutationError>
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
    let output = configured_git_command_for_capability(capability)
        .env("GIT_INDEX_FILE", index_path)
        .args(args)
        .output()
        .map_err(WorktreeMutationError::GitUnavailable)?;
    capability.verify_binding()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeMutationError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct MutationFaults {
    fail_after_worktree_paths: Option<usize>,
    fail_after_index_commit: bool,
    fail_compensation: bool,
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
    fn acquire(
        git_directory_path: &Path,
        git_directory: &OwnedFd,
        create: bool,
    ) -> Result<Self, WorktreeMutationError> {
        let mut flags = OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        if create {
            flags |= OFlags::CREATE;
        }
        let descriptor = openat(
            git_directory,
            RECOVERY_OWNER_LOCK_NAME,
            flags,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|error| path_errno(RECOVERY_OWNER_LOCK_NAME, error))?;
        let stat =
            fstat(&descriptor).map_err(|error| path_errno(RECOVERY_OWNER_LOCK_NAME, error))?;
        let git_stat =
            fstat(git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
            || stat.st_uid != git_stat.st_uid
            || stat.st_mode & 0o777 != 0o600
        {
            return Err(unsafe_path(
                RECOVERY_OWNER_LOCK_NAME,
                "成果事务 owner lock 的类型、所有者或权限不安全",
            ));
        }
        let file: fs::File = descriptor.into();
        FileExt::try_lock_exclusive(&file).map_err(|source| {
            if source.kind() == io::ErrorKind::WouldBlock {
                WorktreeMutationError::GitCommand {
                    operation: "获取成果事务 owner lock",
                    detail: "其他 JoyDSH 进程正在修改仓库成果".into(),
                }
            } else {
                WorktreeMutationError::PathUnavailable {
                    path: git_directory_path.join(RECOVERY_OWNER_LOCK_NAME),
                    source,
                }
            }
        })?;
        fsync(git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        let owner = Self {
            file,
            git_directory: dup(git_directory)
                .map_err(|error| path_errno("<git-directory>", error))?,
            device: stat.st_dev as u64,
            inode: stat.st_ino,
            owner: stat.st_uid,
        };
        owner.verify_binding()?;
        Ok(owner)
    }

    fn verify_binding(&self) -> Result<(), WorktreeMutationError> {
        let locked_stat =
            fstat(&self.file).map_err(|error| path_errno(RECOVERY_OWNER_LOCK_NAME, error))?;
        let current = openat(
            &self.git_directory,
            RECOVERY_OWNER_LOCK_NAME,
            OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno(RECOVERY_OWNER_LOCK_NAME, error))?;
        let current_stat =
            fstat(&current).map_err(|error| path_errno(RECOVERY_OWNER_LOCK_NAME, error))?;
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
                RECOVERY_OWNER_LOCK_NAME,
                "成果事务 owner lock 在操作期间发生替换",
            ))
        }
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct IndexTransaction {
    git_directory_path: PathBuf,
    git_directory: OwnedFd,
    git_device: u64,
    git_inode: u64,
    index_name: OsString,
    lock_name: OsString,
    lock_file: Option<fs::File>,
    original_index: NamedTempFile,
    prepared_index: NamedTempFile,
    original_digest: [u8; 32],
    index_mode: Mode,
    quarantine_name: OsString,
    quarantine: OwnedFd,
    owner_lock: RepositoryOwnerLock,
    committed: bool,
    preserve_for_recovery: bool,
    durable_manifest: Option<DurableRecoveryManifest>,
}

#[cfg(unix)]
impl IndexTransaction {
    fn begin(capability: &RepositoryCapability) -> Result<Self, WorktreeMutationError> {
        capability.verify_binding()?;
        let output = run_git_capability(
            capability,
            "定位 Git 元数据目录",
            ["rev-parse", "--absolute-git-dir"],
        )?;
        let git_directory_path =
            PathBuf::from(trimmed_utf8(&output.stdout, "定位 Git 元数据目录")?);
        if !git_directory_path.is_absolute() {
            return Err(WorktreeMutationError::InvalidGitOutput {
                operation: "定位 Git 元数据目录",
                detail: "Git 元数据目录不是绝对路径".into(),
            });
        }
        let git_directory_path = fs::canonicalize(&git_directory_path).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: git_directory_path.clone(),
                source,
            }
        })?;
        let git_directory = open_absolute_directory(&git_directory_path)?;
        let git_stat =
            fstat(&git_directory).map_err(|error| path_errno("<git-directory>", error))?;
        let owner_lock = RepositoryOwnerLock::acquire(&git_directory_path, &git_directory, true)?;

        let index_name = OsString::from("index");
        let lock_name = OsString::from("index.lock");
        let lock_descriptor = match openat(
            &git_directory,
            &lock_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from(0o600),
        ) {
            Ok(descriptor) => descriptor,
            Err(Errno::EXIST) => {
                return Err(WorktreeMutationError::GitCommand {
                    operation: "获取索引锁",
                    detail: "Git index.lock 已存在，工作区可能正被其他 Git 操作修改".into(),
                })
            }
            Err(error) => return Err(path_errno(".git/index.lock", error)),
        };
        let mut lock_file: fs::File = lock_descriptor.into();
        let pending_recovery = match pending_recovery_directories(&git_directory_path) {
            Ok(pending) => pending,
            Err(error) => {
                drop(lock_file);
                let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
                return Err(error);
            }
        };
        if !pending_recovery.is_empty() {
            drop(lock_file);
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            return Err(WorktreeMutationError::RecoveryRequired {
                detail: format!(
                    "发现未完成的持久恢复 journal：{}",
                    pending_recovery.join("、")
                ),
            });
        }

        let index_descriptor = openat(
            &git_directory,
            &index_name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| path_errno(".git/index", error));
        let index_descriptor = match index_descriptor {
            Ok(descriptor) => descriptor,
            Err(error) => {
                let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
                return Err(error);
            }
        };
        let index_stat = fstat(&index_descriptor).map_err(|error| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            path_errno(".git/index", error)
        })?;
        if FileType::from_raw_mode(index_stat.st_mode) != FileType::RegularFile {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            return Err(unsafe_path(".git/index", "Git 索引不是普通文件"));
        }
        let index_mode = Mode::from_raw_mode(index_stat.st_mode) & Mode::from(0o777);
        fchmod(&lock_file, index_mode).map_err(|error| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            path_errno(".git/index.lock", error)
        })?;

        let mut original_index = NamedTempFile::new().map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: PathBuf::from("<temporary-index-backup>"),
                source,
            }
        })?;
        let mut prepared_index = NamedTempFile::new().map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: PathBuf::from("<temporary-prepared-index>"),
                source,
            }
        })?;
        let mut index_file: fs::File = index_descriptor.into();
        io::copy(&mut index_file, original_index.as_file_mut()).map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: git_directory_path.join("index"),
                source,
            }
        })?;
        index_file.seek(SeekFrom::Start(0)).map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: git_directory_path.join("index"),
                source,
            }
        })?;
        io::copy(&mut index_file, prepared_index.as_file_mut()).map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: git_directory_path.join("index"),
                source,
            }
        })?;
        original_index.as_file_mut().sync_all().map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: original_index.path().to_path_buf(),
                source,
            }
        })?;
        prepared_index.as_file_mut().sync_all().map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: prepared_index.path().to_path_buf(),
                source,
            }
        })?;
        let original_digest = digest_file(original_index.as_file_mut()).map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            WorktreeMutationError::PathUnavailable {
                path: original_index.path().to_path_buf(),
                source,
            }
        })?;

        let (quarantine_name, quarantine) =
            match create_private_directory(&git_directory, "joydsh-recovery") {
                Ok(created) => created,
                Err(error) => {
                    let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
                    return Err(error);
                }
            };
        if let Err(error) = persist_recovery_index(&quarantine, &mut original_index) {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            let _ = unlinkat(&quarantine, RECOVERY_INDEX_NAME, AtFlags::empty());
            let _ = unlinkat(&git_directory, &quarantine_name, AtFlags::REMOVEDIR);
            return Err(error);
        }
        lock_file.seek(SeekFrom::Start(0)).map_err(|source| {
            let _ = unlinkat(&git_directory, &lock_name, AtFlags::empty());
            let _ = unlinkat(&quarantine, RECOVERY_INDEX_NAME, AtFlags::empty());
            let _ = unlinkat(&git_directory, &quarantine_name, AtFlags::REMOVEDIR);
            WorktreeMutationError::PathUnavailable {
                path: git_directory_path.join("index.lock"),
                source,
            }
        })?;

        Ok(Self {
            git_directory_path,
            git_directory,
            git_device: git_stat.st_dev as u64,
            git_inode: git_stat.st_ino as u64,
            index_name,
            lock_name,
            lock_file: Some(lock_file),
            original_index,
            prepared_index,
            original_digest,
            index_mode,
            quarantine_name,
            quarantine,
            owner_lock,
            committed: false,
            preserve_for_recovery: false,
            durable_manifest: None,
        })
    }

    fn prepared_path(&self) -> &Path {
        self.prepared_index.path()
    }

    fn verify_git_directory(&self) -> Result<(), WorktreeMutationError> {
        self.owner_lock.verify_binding()?;
        let current = open_absolute_directory(&self.git_directory_path)?;
        let stat = fstat(&current).map_err(|error| path_errno("<git-directory>", error))?;
        if stat.st_dev as u64 != self.git_device || stat.st_ino as u64 != self.git_inode {
            return Err(unsafe_path(
                self.git_directory_path.to_string_lossy().as_ref(),
                "Git 元数据目录在事务期间发生替换",
            ));
        }
        Ok(())
    }

    fn prepare_index(
        &mut self,
        capability: &RepositoryCapability,
        baseline_revision: &str,
        baseline_paths: &[String],
        absent_paths: &[String],
    ) -> Result<(), WorktreeMutationError> {
        self.verify_git_directory()?;
        if !baseline_paths.is_empty() {
            let mut args = vec![
                "restore".to_string(),
                format!("--source={baseline_revision}"),
                "--staged".to_string(),
                "--ignore-skip-worktree-bits".to_string(),
                "--".to_string(),
            ];
            args.extend(baseline_paths.iter().cloned());
            run_git_capability_with_index(capability, self.prepared_path(), "准备基线索引", args)?;
        }
        if !absent_paths.is_empty() {
            let mut args = vec![
                "rm".to_string(),
                "--cached".to_string(),
                "--force".to_string(),
                "--ignore-unmatch".to_string(),
                "--".to_string(),
            ];
            args.extend(absent_paths.iter().cloned());
            run_git_capability_with_index(capability, self.prepared_path(), "准备清理索引", args)?;
        }
        self.verify_git_directory()
    }

    fn persist_manifest(
        &mut self,
        capability: &RepositoryCapability,
        baseline_revision: &str,
        prepared: &[PreparedPath],
        created: &[CreatedDirectory],
    ) -> Result<(), WorktreeMutationError> {
        let paths = prepared
            .iter()
            .map(|path| {
                let quarantine_name = path.backup_name.to_str().ok_or_else(|| {
                    WorktreeMutationError::InvalidGitOutput {
                        operation: "编码回滚恢复 journal",
                        detail: "隔离文件名不是 UTF-8".into(),
                    }
                })?;
                Ok(DurableRecoveryPath {
                    path: path.plan.path.clone(),
                    quarantine_name: quarantine_name.to_string(),
                    original_guard: path.plan.expected.clone(),
                    replacement_name: path
                        .replacement_name
                        .as_ref()
                        .map(|name| name.to_string_lossy().into_owned()),
                    replacement_guard: path.replacement_guard.clone(),
                })
            })
            .collect::<Result<Vec<_>, WorktreeMutationError>>()?;
        let repository_root = capability.canonical_path.to_str().ok_or_else(|| {
            WorktreeMutationError::InvalidGitOutput {
                operation: "编码回滚恢复 journal",
                detail: "工作区根目录不是 UTF-8".into(),
            }
        })?;
        let git_directory = self.git_directory_path.to_str().ok_or_else(|| {
            WorktreeMutationError::InvalidGitOutput {
                operation: "编码回滚恢复 journal",
                detail: "Git 元数据目录不是 UTF-8".into(),
            }
        })?;
        let manifest = DurableRecoveryManifest {
            version: RECOVERY_MANIFEST_VERSION,
            repository_root: repository_root.to_string(),
            repository_device: capability.device,
            repository_inode: capability.inode,
            git_directory: git_directory.to_string(),
            git_device: self.git_device,
            git_inode: self.git_inode,
            owner_lock_device: self.owner_lock.device,
            owner_lock_inode: self.owner_lock.inode,
            owner_lock_owner: self.owner_lock.owner,
            baseline_revision: baseline_revision.to_string(),
            disposition: RecoveryDisposition::RestoreOriginal,
            original_index_file: RECOVERY_INDEX_NAME.to_string(),
            original_index_sha256: encode_digest(&self.original_digest),
            prepared_index_sha256: encode_digest(
                &digest_file(self.prepared_index.as_file_mut()).map_err(|source| {
                    WorktreeMutationError::PathUnavailable {
                        path: self.prepared_index.path().to_path_buf(),
                        source,
                    }
                })?,
            ),
            owned_index_lock_guard: capture_leaf_guard_at(
                &self.git_directory,
                &self.lock_name,
                ".git/index.lock",
            )?,
            index_mode: self.index_mode.as_raw_mode(),
            paths,
            created_directories: created
                .iter()
                .map(|entry| DurableRecoveryDirectory {
                    path: entry.path.clone(),
                    device: entry.device,
                    inode: entry.inode,
                    mode: entry.mode,
                })
                .collect(),
        };
        self.write_manifest(&manifest)?;
        self.durable_manifest = Some(manifest);
        Ok(())
    }

    fn set_recovery_disposition(
        &mut self,
        disposition: RecoveryDisposition,
    ) -> Result<(), WorktreeMutationError> {
        let Some(mut manifest) = self.durable_manifest.take() else {
            return Err(WorktreeMutationError::InvalidGitOutput {
                operation: "更新回滚恢复 journal",
                detail: "恢复 manifest 尚未建立".into(),
            });
        };
        manifest.disposition = disposition;
        let result = self.write_manifest(&manifest);
        self.durable_manifest = Some(manifest);
        result
    }

    fn write_manifest(
        &self,
        manifest: &DurableRecoveryManifest,
    ) -> Result<(), WorktreeMutationError> {
        let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
            WorktreeMutationError::InvalidGitOutput {
                operation: "编码回滚恢复 journal",
                detail: error.to_string(),
            }
        })?;
        write_atomic_file_at(
            &self.quarantine,
            RECOVERY_MANIFEST_NAME,
            &bytes,
            "<rollback-recovery-manifest>",
        )
    }

    fn mark_for_recovery(&mut self) {
        self.preserve_for_recovery = true;
    }

    fn commit(&mut self) -> Result<(), WorktreeMutationError> {
        self.verify_git_directory()?;
        let current_digest = digest_openat_file(&self.git_directory, &self.index_name)?;
        if current_digest != self.original_digest {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: ".git/index".into(),
            });
        }
        let lock_file = self
            .lock_file
            .as_mut()
            .expect("an uncommitted transaction owns index.lock");
        lock_file
            .set_len(0)
            .map_err(|source| WorktreeMutationError::PathUnavailable {
                path: self.git_directory_path.join("index.lock"),
                source,
            })?;
        lock_file.seek(SeekFrom::Start(0)).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: self.git_directory_path.join("index.lock"),
                source,
            }
        })?;
        let mut prepared_file = fs::File::open(self.prepared_index.path()).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: self.prepared_index.path().to_path_buf(),
                source,
            }
        })?;
        io::copy(&mut prepared_file, lock_file).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: self.git_directory_path.join("index.lock"),
                source,
            }
        })?;
        fchmod(&*lock_file, self.index_mode)
            .map_err(|error| path_errno(".git/index.lock", error))?;
        lock_file
            .sync_all()
            .map_err(|source| WorktreeMutationError::PathUnavailable {
                path: self.git_directory_path.join("index.lock"),
                source,
            })?;
        drop(self.lock_file.take());
        renameat(
            &self.git_directory,
            &self.lock_name,
            &self.git_directory,
            &self.index_name,
        )
        .map_err(|error| path_errno(".git/index", error))?;
        self.committed = true;
        Ok(())
    }

    fn restore_original_index(&mut self) -> Result<(), WorktreeMutationError> {
        self.verify_git_directory()?;
        if !self.committed {
            drop(self.lock_file.take());
            match unlinkat(&self.git_directory, &self.lock_name, AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => return Ok(()),
                Err(error) => return Err(path_errno(".git/index.lock", error)),
            }
        }

        let descriptor = openat(
            &self.git_directory,
            &self.lock_name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from(0o600),
        )
        .map_err(|error| path_errno(".git/index.lock", error))?;
        let mut lock_file: fs::File = descriptor.into();
        fchmod(&lock_file, self.index_mode)
            .map_err(|error| path_errno(".git/index.lock", error))?;
        self.original_index
            .as_file_mut()
            .seek(SeekFrom::Start(0))
            .map_err(|source| WorktreeMutationError::PathUnavailable {
                path: self.original_index.path().to_path_buf(),
                source,
            })?;
        io::copy(self.original_index.as_file_mut(), &mut lock_file).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: self.git_directory_path.join("index.lock"),
                source,
            }
        })?;
        lock_file
            .sync_all()
            .map_err(|source| WorktreeMutationError::PathUnavailable {
                path: self.git_directory_path.join("index.lock"),
                source,
            })?;
        drop(lock_file);
        renameat(
            &self.git_directory,
            &self.lock_name,
            &self.git_directory,
            &self.index_name,
        )
        .map_err(|error| path_errno(".git/index", error))?;
        self.committed = false;
        Ok(())
    }

    fn cleanup(&mut self) -> Vec<String> {
        let mut failures = Vec::new();
        drop(self.lock_file.take());
        if !self.committed {
            if let Err(error) = unlinkat(&self.git_directory, &self.lock_name, AtFlags::empty()) {
                if error != Errno::NOENT {
                    failures.push(format!("清理自有 Git index.lock 失败：{error}"));
                }
            }
        }
        if self.preserve_for_recovery {
            return failures;
        }
        if let Err(error) = unlinkat(&self.quarantine, RECOVERY_INDEX_NAME, AtFlags::empty()) {
            if error != Errno::NOENT {
                failures.push(format!("清理恢复文件 {RECOVERY_INDEX_NAME} 失败：{error}"));
                return failures;
            }
        }
        if let Err(error) = unlinkat(&self.quarantine, RECOVERY_MANIFEST_NAME, AtFlags::empty()) {
            if error != Errno::NOENT {
                failures.push(format!(
                    "清理恢复文件 {RECOVERY_MANIFEST_NAME} 失败：{error}"
                ));
                return failures;
            }
        }
        // Deletion durability across a power loss is outside this API's process-return guarantee.
        let _ = fsync(&self.quarantine);
        if let Err(error) = unlinkat(
            &self.git_directory,
            &self.quarantine_name,
            AtFlags::REMOVEDIR,
        ) {
            if error != Errno::NOENT {
                failures.push(format!("删除 Git 恢复目录失败：{error}"));
            }
        } else {
            let _ = fsync(&self.git_directory);
        }
        failures
    }
}

#[cfg(unix)]
impl Drop for IndexTransaction {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

#[cfg(unix)]
fn digest_file(file: &mut fs::File) -> io::Result<[u8; 32]> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(hasher.finalize().into())
}

#[cfg(unix)]
fn encode_digest(digest: &[u8; 32]) -> String {
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

#[cfg(unix)]
fn persist_recovery_index(
    directory: &OwnedFd,
    original_index: &mut NamedTempFile,
) -> Result<(), WorktreeMutationError> {
    original_index
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: original_index.path().to_path_buf(),
            source,
        })?;
    let descriptor = openat(
        directory,
        RECOVERY_INDEX_NAME,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from(0o600),
    )
    .map_err(|error| path_errno("<rollback-original-index>", error))?;
    let mut destination: fs::File = descriptor.into();
    let result = io::copy(original_index.as_file_mut(), &mut destination)
        .and_then(|_| destination.sync_all())
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: PathBuf::from("<rollback-original-index>"),
            source,
        });
    if let Err(error) = result {
        drop(destination);
        let _ = unlinkat(directory, RECOVERY_INDEX_NAME, AtFlags::empty());
        return Err(error);
    }
    fsync(directory).map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    original_index
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: original_index.path().to_path_buf(),
            source,
        })?;
    Ok(())
}

#[cfg(unix)]
fn write_atomic_file_at(
    directory: &OwnedFd,
    final_name: &str,
    bytes: &[u8],
    display_path: &str,
) -> Result<(), WorktreeMutationError> {
    let temporary_name = random_temporary_name("manifest")?;
    let descriptor = openat(
        directory,
        &temporary_name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from(0o600),
    )
    .map_err(|error| path_errno(display_path, error))?;
    let mut file: fs::File = descriptor.into();
    let write_result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: PathBuf::from(display_path),
            source,
        });
    drop(file);
    if let Err(error) = write_result {
        let _ = unlinkat(directory, &temporary_name, AtFlags::empty());
        return Err(error);
    }
    if let Err(error) = renameat(directory, &temporary_name, directory, final_name) {
        let _ = unlinkat(directory, &temporary_name, AtFlags::empty());
        return Err(path_errno(display_path, error));
    }
    fsync(directory).map_err(|error| path_errno(display_path, error))
}

#[cfg(unix)]
fn digest_openat_file(
    directory: &OwnedFd,
    name: &OsStr,
) -> Result<[u8; 32], WorktreeMutationError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| path_errno(".git/index", error))?;
    let mut file: fs::File = descriptor.into();
    digest_file(&mut file).map_err(|source| WorktreeMutationError::PathUnavailable {
        path: PathBuf::from(".git/index"),
        source,
    })
}

#[cfg(unix)]
fn create_private_directory(
    parent: &OwnedFd,
    prefix: &str,
) -> Result<(OsString, OwnedFd), WorktreeMutationError> {
    for _ in 0..32 {
        let name = random_temporary_name(prefix)?;
        match mkdirat(parent, &name, Mode::from(0o700)) {
            Ok(()) => {
                let descriptor = openat(
                    parent,
                    &name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|error| path_errno("<transaction-directory>", error))?;
                return Ok((name, descriptor));
            }
            Err(Errno::EXIST) => continue,
            Err(error) => return Err(path_errno("<transaction-directory>", error)),
        }
    }
    Err(unsafe_path(
        "<transaction-directory>",
        "无法创建唯一的 Git 私有恢复目录",
    ))
}

#[cfg(unix)]
fn pending_recovery_directories(
    git_directory_path: &Path,
) -> Result<Vec<String>, WorktreeMutationError> {
    let entries = fs::read_dir(git_directory_path).map_err(|source| {
        WorktreeMutationError::PathUnavailable {
            path: git_directory_path.to_path_buf(),
            source,
        }
    })?;
    let mut pending = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| WorktreeMutationError::PathUnavailable {
            path: git_directory_path.to_path_buf(),
            source,
        })?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(".joydsh-recovery-") {
            pending.push(name.to_string());
        }
    }
    pending.sort();
    Ok(pending)
}

#[cfg(unix)]
fn random_temporary_name(prefix: &str) -> Result<OsString, WorktreeMutationError> {
    let mut random = [0_u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut random))
        .map_err(WorktreeMutationError::GitUnavailable)?;
    let mut name = format!(".{prefix}-");
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut name, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(OsString::from(name))
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum LeafGuard {
    Missing,
    Regular {
        device: u64,
        inode: u64,
        mode: u32,
        length: u64,
        digest: [u8; 32],
    },
    SymbolicLink {
        device: u64,
        inode: u64,
        mode: u32,
        target: Vec<u8>,
    },
}

#[cfg(unix)]
impl LeafGuard {
    fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct CreatedDirectory {
    parent: OwnedFd,
    name: OsString,
    path: String,
    device: u64,
    inode: u64,
    mode: u32,
}

#[cfg(unix)]
#[derive(Debug)]
struct PlannedPath {
    path: String,
    baseline: Option<BaselineTreeEntry>,
    expected: LeafGuard,
    unexpected_if_present: bool,
}

#[cfg(unix)]
#[derive(Debug)]
struct PreparedPath {
    plan: PlannedPath,
    parent: Option<OwnedFd>,
    leaf: OsString,
    backup_name: OsString,
    replacement_name: Option<OsString>,
    replacement_guard: Option<LeafGuard>,
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableRecoveryManifest {
    version: u32,
    repository_root: String,
    repository_device: u64,
    repository_inode: u64,
    git_directory: String,
    git_device: u64,
    git_inode: u64,
    owner_lock_device: u64,
    owner_lock_inode: u64,
    owner_lock_owner: u32,
    baseline_revision: String,
    disposition: RecoveryDisposition,
    original_index_file: String,
    original_index_sha256: String,
    prepared_index_sha256: String,
    owned_index_lock_guard: LeafGuard,
    index_mode: u16,
    paths: Vec<DurableRecoveryPath>,
    created_directories: Vec<DurableRecoveryDirectory>,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RecoveryDisposition {
    RestoreOriginal,
    CleanupOnlyRestored,
    CleanupOnlyCommitted,
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableRecoveryPath {
    path: String,
    quarantine_name: String,
    original_guard: LeafGuard,
    replacement_name: Option<String>,
    replacement_guard: Option<LeafGuard>,
}

#[cfg(unix)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DurableRecoveryDirectory {
    path: String,
    device: u64,
    inode: u64,
    mode: u32,
}

#[cfg(unix)]
#[derive(Debug)]
struct RecoveryPathSnapshot {
    entry: DurableRecoveryPath,
    parent_present: bool,
    leaf_guard: LeafGuard,
    quarantine_guard: LeafGuard,
    replacement_guard: LeafGuard,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DirectoryGuard {
    device: u64,
    inode: u64,
    mode: u32,
}

#[cfg(unix)]
fn invalid_recovery_manifest(detail: impl Into<String>) -> WorktreeMutationError {
    WorktreeMutationError::InvalidGitOutput {
        operation: "读取回滚恢复 journal",
        detail: detail.into(),
    }
}

#[cfg(unix)]
fn decode_digest(value: &str, field: &str) -> Result<[u8; 32], WorktreeMutationError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(invalid_recovery_manifest(format!(
            "{field} 不是完整 SHA-256"
        )));
    }
    let mut digest = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let encoded = std::str::from_utf8(pair)
            .map_err(|_| invalid_recovery_manifest(format!("{field} 不是 UTF-8")))?;
        digest[index] = u8::from_str_radix(encoded, 16)
            .map_err(|_| invalid_recovery_manifest(format!("{field} 包含无效字符")))?;
    }
    Ok(digest)
}

#[cfg(unix)]
fn validate_random_name(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[cfg(unix)]
fn validate_replacement_name(name: &str) -> bool {
    let Some(suffix) = name.strip_prefix(".joydsh-rollback-") else {
        return false;
    };
    let Some((process, sequence)) = suffix.split_once('-') else {
        return false;
    };
    !process.is_empty()
        && !sequence.is_empty()
        && process.bytes().all(|byte| byte.is_ascii_digit())
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(unix)]
fn validate_serialized_leaf_guard(
    guard: &LeafGuard,
    field: &str,
) -> Result<(), WorktreeMutationError> {
    match guard {
        LeafGuard::Missing => Ok(()),
        LeafGuard::Regular { mode, .. }
            if *mode <= u16::MAX as u32
                && FileType::from_raw_mode(*mode as u16) == FileType::RegularFile =>
        {
            Ok(())
        }
        LeafGuard::SymbolicLink { mode, target, .. }
            if *mode <= u16::MAX as u32
                && FileType::from_raw_mode(*mode as u16) == FileType::Symlink
                && target.len() <= 64 * 1024
                && !target.contains(&0) =>
        {
            Ok(())
        }
        _ => Err(invalid_recovery_manifest(format!(
            "{field} 的文件类型或内容无效"
        ))),
    }
}

#[cfg(unix)]
fn validate_recovery_manifest(
    manifest: &DurableRecoveryManifest,
    capability: &RepositoryCapability,
    git_directory_path: &Path,
    git_stat: &rustix::fs::Stat,
) -> Result<([u8; 32], [u8; 32]), WorktreeMutationError> {
    if manifest.version != RECOVERY_MANIFEST_VERSION {
        return Err(invalid_recovery_manifest(format!(
            "不支持的 manifest 版本 {}",
            manifest.version
        )));
    }
    if manifest.repository_root != capability.canonical_path.to_string_lossy()
        || manifest.repository_device != capability.device
        || manifest.repository_inode != capability.inode
    {
        return Err(invalid_recovery_manifest("manifest 不属于当前工作区"));
    }
    if manifest.git_directory != git_directory_path.to_string_lossy()
        || manifest.git_device != git_stat.st_dev as u64
        || manifest.git_inode != git_stat.st_ino as u64
    {
        return Err(invalid_recovery_manifest(
            "manifest 不属于当前 Git 元数据目录",
        ));
    }
    if manifest.baseline_revision.len() < 40
        || manifest.baseline_revision.len() > 64
        || !manifest
            .baseline_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(invalid_recovery_manifest("manifest 基线 revision 无效"));
    }
    if manifest.original_index_file != RECOVERY_INDEX_NAME {
        return Err(invalid_recovery_manifest("原始索引文件名越界"));
    }
    if manifest.index_mode & !0o777 != 0 {
        return Err(invalid_recovery_manifest("Git 索引权限无效"));
    }
    validate_serialized_leaf_guard(&manifest.owned_index_lock_guard, "ownedIndexLockGuard")?;
    if !matches!(manifest.owned_index_lock_guard, LeafGuard::Regular { .. }) {
        return Err(invalid_recovery_manifest(
            "事务 index.lock 的强身份不是普通文件",
        ));
    }
    if manifest.paths.len() > MAX_RECOVERY_PATHS
        || manifest.created_directories.len() > MAX_RECOVERY_PATHS
    {
        return Err(invalid_recovery_manifest("恢复路径数量超过限制"));
    }

    let mut paths = BTreeSet::new();
    let mut quarantine_names = BTreeSet::new();
    for (index, entry) in manifest.paths.iter().enumerate() {
        if entry.path.len() > MAX_RECOVERY_PATH_BYTES {
            return Err(invalid_recovery_manifest(format!(
                "paths[{index}] 超过路径长度限制"
            )));
        }
        let components = validate_relative_mutation_path(&entry.path)?;
        if !paths.insert(entry.path.as_str()) {
            return Err(invalid_recovery_manifest(format!(
                "重复恢复路径 {:?}",
                entry.path
            )));
        }
        if !validate_random_name(&entry.quarantine_name, ".original-")
            || !quarantine_names.insert(entry.quarantine_name.as_str())
        {
            return Err(invalid_recovery_manifest(format!(
                "路径 {:?} 的隔离文件名无效或重复",
                entry.path
            )));
        }
        validate_serialized_leaf_guard(
            &entry.original_guard,
            &format!("paths[{index}].originalGuard"),
        )?;
        match (&entry.replacement_name, &entry.replacement_guard) {
            (None, None) => {}
            (Some(name), Some(guard)) if validate_replacement_name(name) && !guard.is_missing() => {
                if components
                    .last()
                    .is_some_and(|leaf| leaf == OsStr::new(name))
                {
                    return Err(invalid_recovery_manifest(format!(
                        "路径 {:?} 的替换名与目标名相同",
                        entry.path
                    )));
                }
                validate_serialized_leaf_guard(guard, &format!("paths[{index}].replacementGuard"))?;
            }
            _ => {
                return Err(invalid_recovery_manifest(format!(
                    "路径 {:?} 的替换文件映射不完整",
                    entry.path
                )))
            }
        }
    }

    let mut directories = BTreeSet::new();
    for (index, directory) in manifest.created_directories.iter().enumerate() {
        if directory.path.len() > MAX_RECOVERY_PATH_BYTES {
            return Err(invalid_recovery_manifest(format!(
                "createdDirectories[{index}] 超过路径长度限制"
            )));
        }
        validate_relative_mutation_path(&directory.path)?;
        if !directories.insert(directory.path.as_str())
            || directory.mode > u16::MAX as u32
            || FileType::from_raw_mode(directory.mode as u16) != FileType::Directory
        {
            return Err(invalid_recovery_manifest(format!(
                "createdDirectories[{index}] 的身份无效或重复"
            )));
        }
    }

    Ok((
        decode_digest(&manifest.original_index_sha256, "originalIndexSha256")?,
        decode_digest(&manifest.prepared_index_sha256, "preparedIndexSha256")?,
    ))
}

#[cfg(unix)]
fn open_git_directory(
    capability: &RepositoryCapability,
) -> Result<(PathBuf, OwnedFd, rustix::fs::Stat), WorktreeMutationError> {
    let output = run_git_capability(
        capability,
        "定位 Git 元数据目录",
        ["rev-parse", "--absolute-git-dir"],
    )?;
    let path = PathBuf::from(trimmed_utf8(&output.stdout, "定位 Git 元数据目录")?);
    if !path.is_absolute() {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "定位 Git 元数据目录",
            detail: "Git 元数据目录不是绝对路径".into(),
        });
    }
    let path =
        fs::canonicalize(&path).map_err(|source| WorktreeMutationError::PathUnavailable {
            path: path.clone(),
            source,
        })?;
    let directory = open_absolute_directory(&path)?;
    let stat = fstat(&directory).map_err(|error| path_errno("<git-directory>", error))?;
    Ok((path, directory, stat))
}

#[cfg(unix)]
fn read_bounded_regular_file_at(
    directory: &OwnedFd,
    name: &OsStr,
    max_bytes: u64,
    display_path: &str,
    expected_owner: u32,
    expected_mode: u16,
) -> Result<Vec<u8>, WorktreeMutationError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| path_errno(display_path, error))?;
    let before = fstat(&descriptor).map_err(|error| path_errno(display_path, error))?;
    if FileType::from_raw_mode(before.st_mode) != FileType::RegularFile
        || before.st_uid != expected_owner
        || before.st_mode & 0o777 != expected_mode
        || before.st_size < 0
        || before.st_size as u64 > max_bytes
    {
        return Err(unsafe_path(
            display_path,
            "恢复文件的类型、所有者、权限或大小越界",
        ));
    }
    let mut file: fs::File = descriptor.into();
    let mut bytes = Vec::with_capacity(before.st_size as usize);
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: PathBuf::from(display_path),
            source,
        })?;
    let after = file
        .metadata()
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: PathBuf::from(display_path),
            source,
        })?;
    if bytes.len() as u64 != before.st_size as u64
        || bytes.len() as u64 > max_bytes
        || after.dev() != before.st_dev as u64
        || after.ino() != before.st_ino as u64
        || after.mode() != before.st_mode as u32
        || after.len() != before.st_size as u64
    {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: display_path.to_string(),
        });
    }
    Ok(bytes)
}

#[cfg(unix)]
fn digest_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[cfg(unix)]
fn capture_directory_guard(
    capability: &RepositoryCapability,
    path: &str,
) -> Result<Option<DirectoryGuard>, WorktreeMutationError> {
    let components = validate_relative_mutation_path(path)?;
    let mut directory = dup(&capability.root).map_err(|error| path_errno(path, error))?;
    for component in components {
        match openat(
            &directory,
            &component,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(next) => directory = next,
            Err(Errno::NOENT) => return Ok(None),
            Err(Errno::LOOP | Errno::NOTDIR) => {
                return Err(unsafe_path(path, "恢复目录路径包含符号链接或非目录组件"))
            }
            Err(error) => return Err(path_errno(path, error)),
        }
    }
    let stat = fstat(&directory).map_err(|error| path_errno(path, error))?;
    Ok(Some(DirectoryGuard {
        device: stat.st_dev as u64,
        inode: stat.st_ino as u64,
        mode: stat.st_mode as u32,
    }))
}

#[cfg(unix)]
fn capture_recovery_path_snapshot(
    capability: &RepositoryCapability,
    quarantine: &OwnedFd,
    entry: &DurableRecoveryPath,
) -> Result<RecoveryPathSnapshot, WorktreeMutationError> {
    let mut no_created = Vec::new();
    let parent = open_parent_from_capability(capability, &entry.path, false, &mut no_created)?;
    let (parent_present, leaf_guard, replacement_guard) = match parent {
        Some((parent, leaf)) => {
            let leaf_guard = capture_leaf_guard_at(&parent, &leaf, &entry.path)?;
            let replacement_guard = match entry.replacement_name.as_deref() {
                Some(name) => capture_leaf_guard_at(&parent, OsStr::new(name), &entry.path)?,
                None => LeafGuard::Missing,
            };
            (true, leaf_guard, replacement_guard)
        }
        None => (false, LeafGuard::Missing, LeafGuard::Missing),
    };
    let quarantine_guard =
        capture_leaf_guard_at(quarantine, OsStr::new(&entry.quarantine_name), &entry.path)?;
    Ok(RecoveryPathSnapshot {
        entry: entry.clone(),
        parent_present,
        leaf_guard,
        quarantine_guard,
        replacement_guard,
    })
}

#[cfg(unix)]
fn validate_recovery_path_snapshot(
    disposition: RecoveryDisposition,
    snapshot: &RecoveryPathSnapshot,
) -> Result<(), WorktreeMutationError> {
    let entry = &snapshot.entry;
    let replacement = entry.replacement_guard.as_ref();
    let replacement_at_leaf = replacement.is_some_and(|guard| snapshot.leaf_guard == *guard);
    let replacement_at_temp = replacement.is_some_and(|guard| snapshot.replacement_guard == *guard);
    if !snapshot.replacement_guard.is_missing() && !replacement_at_temp {
        return Err(WorktreeMutationError::UnexpectedOccupant {
            path: entry.path.clone(),
        });
    }
    if replacement_at_leaf && replacement_at_temp {
        return Err(WorktreeMutationError::UnexpectedOccupant {
            path: entry.path.clone(),
        });
    }

    match disposition {
        RecoveryDisposition::RestoreOriginal => {
            if entry.original_guard.is_missing() {
                if !snapshot.quarantine_guard.is_missing()
                    || (!snapshot.leaf_guard.is_missing() && !replacement_at_leaf)
                {
                    return Err(WorktreeMutationError::UnexpectedOccupant {
                        path: entry.path.clone(),
                    });
                }
            } else if snapshot.quarantine_guard == entry.original_guard {
                if !snapshot.leaf_guard.is_missing() && !replacement_at_leaf {
                    return Err(WorktreeMutationError::UnexpectedOccupant {
                        path: entry.path.clone(),
                    });
                }
            } else if snapshot.quarantine_guard.is_missing()
                && snapshot.leaf_guard == entry.original_guard
            {
            } else {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: entry.path.clone(),
                });
            }
        }
        RecoveryDisposition::CleanupOnlyRestored => {
            let restored = if entry.original_guard.is_missing() {
                snapshot.leaf_guard.is_missing()
            } else {
                snapshot.leaf_guard == entry.original_guard
            };
            if !restored
                || !snapshot.quarantine_guard.is_missing()
                || !snapshot.replacement_guard.is_missing()
            {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: entry.path.clone(),
                });
            }
        }
        RecoveryDisposition::CleanupOnlyCommitted => {
            let committed = replacement.map_or_else(
                || snapshot.leaf_guard.is_missing(),
                |guard| snapshot.leaf_guard == *guard,
            );
            let original_backup_valid = snapshot.quarantine_guard.is_missing()
                || snapshot.quarantine_guard == entry.original_guard;
            if !committed || !original_backup_valid || !snapshot.replacement_guard.is_missing() {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: entry.path.clone(),
                });
            }
        }
    }
    if !snapshot.parent_present
        && (!snapshot.leaf_guard.is_missing() || !snapshot.replacement_guard.is_missing())
    {
        return Err(WorktreeMutationError::UnexpectedOccupant {
            path: entry.path.clone(),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_index_lock_absent(git_directory: &OwnedFd) -> Result<(), WorktreeMutationError> {
    match statat(
        git_directory,
        RECOVERY_INDEX_LOCK_NAME,
        AtFlags::SYMLINK_NOFOLLOW,
    ) {
        Err(Errno::NOENT) => Ok(()),
        Ok(_) => Err(WorktreeMutationError::GitCommand {
            operation: "恢复未完成回滚",
            detail: "Git index.lock 已存在，拒绝自动恢复".into(),
        }),
        Err(error) => Err(path_errno(".git/index.lock", error)),
    }
}

#[cfg(unix)]
fn validate_owned_index_lock(
    git_directory: &OwnedFd,
    manifest: &DurableRecoveryManifest,
) -> Result<Option<LeafGuard>, WorktreeMutationError> {
    let current = capture_leaf_guard_at(
        git_directory,
        OsStr::new(RECOVERY_INDEX_LOCK_NAME),
        ".git/index.lock",
    )?;
    if current.is_missing() {
        return Ok(None);
    }
    if manifest.disposition == RecoveryDisposition::RestoreOriginal
        && current == manifest.owned_index_lock_guard
    {
        Ok(Some(current))
    } else {
        Err(WorktreeMutationError::GitCommand {
            operation: "恢复未完成回滚",
            detail: "检测到不属于恢复 journal 的 Git index.lock，拒绝自动恢复".into(),
        })
    }
}

#[cfg(unix)]
fn validate_quarantine_entries(
    quarantine_path: &Path,
    quarantine: &OwnedFd,
    manifest: &DurableRecoveryManifest,
) -> Result<(), WorktreeMutationError> {
    let before =
        fstat(quarantine).map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    let mut allowed = BTreeSet::from([
        RECOVERY_INDEX_NAME.to_string(),
        RECOVERY_MANIFEST_NAME.to_string(),
    ]);
    allowed.extend(
        manifest
            .paths
            .iter()
            .map(|entry| entry.quarantine_name.clone()),
    );
    for entry in
        fs::read_dir(quarantine_path).map_err(|source| WorktreeMutationError::PathUnavailable {
            path: quarantine_path.to_path_buf(),
            source,
        })?
    {
        let entry = entry.map_err(|source| WorktreeMutationError::PathUnavailable {
            path: quarantine_path.to_path_buf(),
            source,
        })?;
        let name = entry.file_name().into_string().map_err(|_| {
            unsafe_path(
                "<rollback-recovery-directory>",
                "恢复目录包含非 UTF-8 文件名",
            )
        })?;
        if !allowed.contains(&name) {
            return Err(unsafe_path(
                "<rollback-recovery-directory>",
                format!("恢复目录包含未知文件 {name:?}"),
            ));
        }
    }
    let after =
        fstat(quarantine).map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    if before.st_dev != after.st_dev || before.st_ino != after.st_ino {
        return Err(unsafe_path(
            "<rollback-recovery-directory>",
            "恢复目录在检查期间发生替换",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_created_directories(
    capability: &RepositoryCapability,
    manifest: &DurableRecoveryManifest,
) -> Result<(), WorktreeMutationError> {
    for directory in &manifest.created_directories {
        let expected = DirectoryGuard {
            device: directory.device,
            inode: directory.inode,
            mode: directory.mode,
        };
        let actual = capture_directory_guard(capability, &directory.path)?;
        let valid = match manifest.disposition {
            RecoveryDisposition::RestoreOriginal => actual.is_none() || actual == Some(expected),
            RecoveryDisposition::CleanupOnlyRestored => actual.is_none(),
            RecoveryDisposition::CleanupOnlyCommitted => actual == Some(expected),
        };
        if !valid {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: directory.path.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn remove_exact_leaf(
    parent: &OwnedFd,
    leaf: &OsStr,
    path: &str,
    expected: &LeafGuard,
) -> Result<(), WorktreeMutationError> {
    let current = capture_leaf_guard_at(parent, leaf, path)?;
    if current != *expected {
        return Err(WorktreeMutationError::UnexpectedOccupant {
            path: path.to_string(),
        });
    }
    unlinkat(parent, leaf, AtFlags::empty()).map_err(|error| path_errno(path, error))?;
    fsync(parent).map_err(|error| path_errno(path, error))
}

#[cfg(unix)]
fn restore_recovery_paths(
    capability: &RepositoryCapability,
    quarantine: &OwnedFd,
    snapshots: &[RecoveryPathSnapshot],
) -> Result<(), WorktreeMutationError> {
    for snapshot in snapshots.iter().rev() {
        let mut no_created = Vec::new();
        let parent =
            open_parent_from_capability(capability, &snapshot.entry.path, false, &mut no_created)?;
        let Some((parent, leaf)) = parent else {
            if snapshot.parent_present {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: snapshot.entry.path.clone(),
                });
            }
            continue;
        };
        if !snapshot.parent_present {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: snapshot.entry.path.clone(),
            });
        }
        let current_leaf = capture_leaf_guard_at(&parent, &leaf, &snapshot.entry.path)?;
        let current_quarantine = capture_leaf_guard_at(
            quarantine,
            OsStr::new(&snapshot.entry.quarantine_name),
            &snapshot.entry.path,
        )?;
        let current_replacement = match snapshot.entry.replacement_name.as_deref() {
            Some(name) => capture_leaf_guard_at(&parent, OsStr::new(name), &snapshot.entry.path)?,
            None => LeafGuard::Missing,
        };
        if current_leaf != snapshot.leaf_guard
            || current_quarantine != snapshot.quarantine_guard
            || current_replacement != snapshot.replacement_guard
        {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: snapshot.entry.path.clone(),
            });
        }

        if let Some(replacement) = snapshot.entry.replacement_guard.as_ref() {
            if current_leaf == *replacement {
                remove_exact_leaf(&parent, &leaf, &snapshot.entry.path, replacement)?;
            }
            if current_replacement == *replacement {
                let replacement_name = snapshot
                    .entry
                    .replacement_name
                    .as_deref()
                    .expect("a replacement guard has a replacement name");
                remove_exact_leaf(
                    &parent,
                    OsStr::new(replacement_name),
                    &snapshot.entry.path,
                    replacement,
                )?;
            }
        }

        if current_quarantine == snapshot.entry.original_guard
            && !snapshot.entry.original_guard.is_missing()
        {
            renameat_with(
                quarantine,
                OsStr::new(&snapshot.entry.quarantine_name),
                &parent,
                &leaf,
                RenameFlags::NOREPLACE,
            )
            .map_err(|error| path_errno(&snapshot.entry.path, error))?;
            let restored = capture_leaf_guard_at(&parent, &leaf, &snapshot.entry.path)?;
            if restored != snapshot.entry.original_guard {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: snapshot.entry.path.clone(),
                });
            }
            fsync(&parent).map_err(|error| path_errno(&snapshot.entry.path, error))?;
            fsync(quarantine)
                .map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
        }
        let final_guard = capture_leaf_guard_at(&parent, &leaf, &snapshot.entry.path)?;
        if final_guard != snapshot.entry.original_guard {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: snapshot.entry.path.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn remove_recovered_created_directories(
    capability: &RepositoryCapability,
    manifest: &DurableRecoveryManifest,
) -> Result<(), WorktreeMutationError> {
    for directory in manifest.created_directories.iter().rev() {
        let expected = DirectoryGuard {
            device: directory.device,
            inode: directory.inode,
            mode: directory.mode,
        };
        match capture_directory_guard(capability, &directory.path)? {
            None => continue,
            Some(actual) if actual == expected => {}
            Some(_) => {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: directory.path.clone(),
                })
            }
        }
        let mut no_created = Vec::new();
        let Some((parent, leaf)) =
            open_parent_from_capability(capability, &directory.path, false, &mut no_created)?
        else {
            continue;
        };
        let stat = statat(&parent, &leaf, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| path_errno(&directory.path, error))?;
        if stat.st_dev as u64 != expected.device
            || stat.st_ino as u64 != expected.inode
            || stat.st_mode as u32 != expected.mode
        {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: directory.path.clone(),
            });
        }
        unlinkat(&parent, &leaf, AtFlags::REMOVEDIR)
            .map_err(|error| path_errno(&directory.path, error))?;
        fsync(&parent).map_err(|error| path_errno(&directory.path, error))?;
    }
    Ok(())
}

#[cfg(unix)]
fn restore_original_index_bytes(
    git_directory: &OwnedFd,
    original_index: &[u8],
    original_digest: &[u8; 32],
    index_mode: u16,
) -> Result<(), WorktreeMutationError> {
    ensure_index_lock_absent(git_directory)?;
    let descriptor = openat(
        git_directory,
        RECOVERY_INDEX_LOCK_NAME,
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|error| path_errno(".git/index.lock", error))?;
    let mut lock_file: fs::File = descriptor.into();
    let result = (|| -> Result<(), WorktreeMutationError> {
        fchmod(&lock_file, Mode::from_raw_mode(index_mode))
            .map_err(|error| path_errno(".git/index.lock", error))?;
        lock_file.write_all(original_index).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: PathBuf::from(".git/index.lock"),
                source,
            }
        })?;
        lock_file
            .sync_all()
            .map_err(|source| WorktreeMutationError::PathUnavailable {
                path: PathBuf::from(".git/index.lock"),
                source,
            })?;
        lock_file.seek(SeekFrom::Start(0)).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: PathBuf::from(".git/index.lock"),
                source,
            }
        })?;
        let written = digest_file(&mut lock_file).map_err(|source| {
            WorktreeMutationError::PathUnavailable {
                path: PathBuf::from(".git/index.lock"),
                source,
            }
        })?;
        if &written != original_digest {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: ".git/index.lock".into(),
            });
        }
        Ok(())
    })();
    drop(lock_file);
    if let Err(error) = result {
        let _ = unlinkat(git_directory, RECOVERY_INDEX_LOCK_NAME, AtFlags::empty());
        return Err(error);
    }
    renameat(
        git_directory,
        RECOVERY_INDEX_LOCK_NAME,
        git_directory,
        "index",
    )
    .map_err(|error| path_errno(".git/index", error))?;
    fsync(git_directory).map_err(|error| path_errno("<git-directory>", error))
}

#[cfg(unix)]
fn write_recovery_manifest(
    quarantine: &OwnedFd,
    manifest: &DurableRecoveryManifest,
) -> Result<(), WorktreeMutationError> {
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
        WorktreeMutationError::InvalidGitOutput {
            operation: "编码回滚恢复 journal",
            detail: error.to_string(),
        }
    })?;
    write_atomic_file_at(
        quarantine,
        RECOVERY_MANIFEST_NAME,
        &bytes,
        "<rollback-recovery-manifest>",
    )
}

#[cfg(unix)]
fn persist_regular_file_at(
    directory: &OwnedFd,
    name: &str,
    bytes: &[u8],
    display_path: &str,
) -> Result<(), WorktreeMutationError> {
    let descriptor = openat(
        directory,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map_err(|error| path_errno(display_path, error))?;
    let mut file: fs::File = descriptor.into();
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|source| WorktreeMutationError::PathUnavailable {
            path: PathBuf::from(display_path),
            source,
        })?;
    fsync(directory).map_err(|error| path_errno(display_path, error))
}

#[cfg(unix)]
fn cleanup_recovery_journal(
    git_directory: &OwnedFd,
    quarantine_name: &OsStr,
    quarantine: &OwnedFd,
    quarantine_path: &Path,
    manifest: &DurableRecoveryManifest,
    original_index: &[u8],
) -> Result<(), WorktreeMutationError> {
    validate_quarantine_entries(quarantine_path, quarantine, manifest)?;
    if manifest.disposition == RecoveryDisposition::CleanupOnlyCommitted {
        for entry in &manifest.paths {
            let guard =
                capture_leaf_guard_at(quarantine, OsStr::new(&entry.quarantine_name), &entry.path)?;
            if guard.is_missing() {
                continue;
            }
            if guard != entry.original_guard {
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: entry.path.clone(),
                });
            }
            unlinkat(
                quarantine,
                OsStr::new(&entry.quarantine_name),
                AtFlags::empty(),
            )
            .map_err(|error| path_errno(&entry.path, error))?;
        }
        fsync(quarantine).map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    }

    let index_bytes = read_bounded_regular_file_at(
        quarantine,
        OsStr::new(RECOVERY_INDEX_NAME),
        MAX_RECOVERY_INDEX_BYTES,
        "<rollback-original-index>",
        fstat(quarantine)
            .map_err(|error| path_errno("<rollback-recovery-directory>", error))?
            .st_uid,
        0o600,
    )?;
    if index_bytes != original_index {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: "<rollback-original-index>".into(),
        });
    }
    unlinkat(quarantine, RECOVERY_INDEX_NAME, AtFlags::empty())
        .map_err(|error| path_errno("<rollback-original-index>", error))?;
    unlinkat(quarantine, RECOVERY_MANIFEST_NAME, AtFlags::empty())
        .map_err(|error| path_errno("<rollback-recovery-manifest>", error))?;
    fsync(quarantine).map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    match unlinkat(git_directory, quarantine_name, AtFlags::REMOVEDIR) {
        Ok(()) => {
            fsync(git_directory).map_err(|error| path_errno("<git-directory>", error))?;
            Ok(())
        }
        Err(remove_error) => {
            let index_restore = persist_regular_file_at(
                quarantine,
                RECOVERY_INDEX_NAME,
                original_index,
                "<rollback-original-index>",
            );
            let manifest_restore = write_recovery_manifest(quarantine, manifest);
            match (index_restore, manifest_restore) {
                (Ok(()), Ok(())) => Err(path_errno("<rollback-recovery-directory>", remove_error)),
                (index, manifest) => Err(WorktreeMutationError::RecoveryRequired {
                    detail: format!(
                        "清理恢复目录失败且重建恢复证据不完整：删除错误 {remove_error}；索引重建 {index:?}；manifest 重建 {manifest:?}"
                    ),
                }),
            }
        }
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct WorktreeJournalEntry {
    path: String,
    parent: OwnedFd,
    leaf: OsString,
    backup_name: Option<OsString>,
    installed_guard: Option<LeafGuard>,
    replacement_name: Option<OsString>,
}

#[cfg(unix)]
fn validate_relative_mutation_path(path: &str) -> Result<Vec<OsString>, WorktreeMutationError> {
    if path.is_empty() || path.contains('\0') {
        return Err(unsafe_path(path, "路径为空或包含 NUL"));
    }
    let components = Path::new(path)
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err(unsafe_path(path, "路径不是规范的仓库内相对路径")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err(unsafe_path(path, "路径为空"));
    }
    if components[0].to_string_lossy().eq_ignore_ascii_case(".git") {
        return Err(unsafe_path(path, "路径指向 Git 元数据目录"));
    }
    Ok(components)
}

#[cfg(unix)]
fn open_parent_from_capability(
    capability: &RepositoryCapability,
    path: &str,
    create_parents: bool,
    created: &mut Vec<CreatedDirectory>,
) -> Result<Option<(OwnedFd, OsString)>, WorktreeMutationError> {
    capability.verify_binding()?;
    let components = validate_relative_mutation_path(path)?;
    let leaf = components
        .last()
        .cloned()
        .expect("validated non-empty path");
    let mut directory = dup(&capability.root).map_err(|error| path_errno(path, error))?;
    for (index, component) in components[..components.len() - 1].iter().enumerate() {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        directory = match openat(&directory, component, flags, Mode::empty()) {
            Ok(next) => next,
            Err(Errno::NOENT) if !create_parents => return Ok(None),
            Err(Errno::NOENT) => {
                let retained_parent = dup(&directory).map_err(|error| path_errno(path, error))?;
                let created_here = match mkdirat(&directory, component, Mode::from(0o755)) {
                    Ok(()) => true,
                    Err(Errno::EXIST) => false,
                    Err(error) => return Err(path_errno(path, error)),
                };
                let next = openat(&directory, component, flags, Mode::empty())
                    .map_err(|error| path_errno(path, error))?;
                if created_here {
                    let stat = fstat(&next).map_err(|error| path_errno(path, error))?;
                    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory {
                        return Err(unsafe_path(path, "新建路径父组件不是目录"));
                    }
                    created.push(CreatedDirectory {
                        parent: retained_parent,
                        name: component.clone(),
                        path: components[..=index]
                            .iter()
                            .map(|part| part.to_string_lossy())
                            .collect::<Vec<_>>()
                            .join("/"),
                        device: stat.st_dev as u64,
                        inode: stat.st_ino as u64,
                        mode: stat.st_mode as u32,
                    });
                }
                next
            }
            Err(Errno::LOOP | Errno::NOTDIR) => {
                return Err(unsafe_path(path, "路径父目录是符号链接或非目录"))
            }
            Err(error) => return Err(path_errno(path, error)),
        };
    }
    Ok(Some((directory, leaf)))
}

#[cfg(unix)]
fn capture_leaf_guard(
    capability: &RepositoryCapability,
    path: &str,
) -> Result<LeafGuard, WorktreeMutationError> {
    let mut no_created = Vec::new();
    let Some((parent, leaf)) =
        open_parent_from_capability(capability, path, false, &mut no_created)?
    else {
        return Ok(LeafGuard::Missing);
    };
    capture_leaf_guard_at(&parent, &leaf, path)
}

#[cfg(unix)]
fn capture_leaf_guard_at(
    parent: &OwnedFd,
    leaf: &OsStr,
    path: &str,
) -> Result<LeafGuard, WorktreeMutationError> {
    let stat = match statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => stat,
        Err(Errno::NOENT) => return Ok(LeafGuard::Missing),
        Err(error) => return Err(path_errno(path, error)),
    };
    match FileType::from_raw_mode(stat.st_mode) {
        FileType::RegularFile => {
            let descriptor = openat(
                parent,
                leaf,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|error| path_errno(path, error))?;
            let before = fstat(&descriptor).map_err(|error| path_errno(path, error))?;
            if before.st_dev != stat.st_dev || before.st_ino != stat.st_ino {
                return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                    path: path.to_string(),
                });
            }
            let mut file: fs::File = descriptor.into();
            let digest = digest_file(&mut file).map_err(|source| {
                WorktreeMutationError::PathUnavailable {
                    path: PathBuf::from(path),
                    source,
                }
            })?;
            let after =
                file.metadata()
                    .map_err(|source| WorktreeMutationError::PathUnavailable {
                        path: PathBuf::from(path),
                        source,
                    })?;
            if after.dev() != before.st_dev as u64
                || after.ino() != before.st_ino as u64
                || after.mode() != before.st_mode as u32
                || after.len() != before.st_size as u64
            {
                return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                    path: path.to_string(),
                });
            }
            Ok(LeafGuard::Regular {
                device: before.st_dev as u64,
                inode: before.st_ino as u64,
                mode: before.st_mode as u32,
                length: before.st_size as u64,
                digest,
            })
        }
        FileType::Symlink => {
            let target = readlinkat(parent, leaf, Vec::new())
                .map_err(|error| path_errno(path, error))?
                .into_bytes();
            let after = statat(parent, leaf, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|error| path_errno(path, error))?;
            if after.st_dev != stat.st_dev
                || after.st_ino != stat.st_ino
                || after.st_mode != stat.st_mode
            {
                return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                    path: path.to_string(),
                });
            }
            Ok(LeafGuard::SymbolicLink {
                device: stat.st_dev as u64,
                inode: stat.st_ino as u64,
                mode: stat.st_mode as u32,
                target,
            })
        }
        FileType::Directory => Err(unsafe_path(path, "目标是目录，禁止递归删除或覆盖")),
        _ => Err(unsafe_path(path, "目标不是普通文件或符号链接")),
    }
}

#[cfg(unix)]
fn baseline_tree_entry_optional(
    capability: &RepositoryCapability,
    baseline_revision: &str,
    path: &str,
) -> Result<Option<BaselineTreeEntry>, WorktreeMutationError> {
    let output = run_git_capability(
        capability,
        "读取基线树条目",
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
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: format!("路径 {path:?} 返回了多个基线条目"),
        });
    }
    let separator = records[0]
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or_else(|| WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: "树条目缺少文件路径".into(),
        })?;
    if &records[0][separator + 1..] != path.as_bytes() {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: "Git 返回了其他文件路径".into(),
        });
    }
    let header = std::str::from_utf8(&records[0][..separator]).map_err(|_| {
        WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: "树条目头不是 UTF-8".into(),
        }
    })?;
    let mut fields = header.split(' ');
    let mode = u32::from_str_radix(fields.next().unwrap_or_default(), 8).map_err(|_| {
        WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: "树条目模式无效".into(),
        }
    })?;
    let object_type = fields.next().unwrap_or_default();
    let object_id = fields.next().unwrap_or_default();
    if fields.next().is_some()
        || !matches!((mode, object_type), (0o160000, "commit") | (_, "blob"))
        || object_id.len() < 40
        || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: "树条目对象无效".into(),
        });
    }
    Ok(Some(BaselineTreeEntry {
        mode,
        object_id: object_id.to_ascii_lowercase(),
    }))
}

#[cfg(unix)]
fn prepare_replacement(
    capability: &RepositoryCapability,
    parent: &OwnedFd,
    path: &str,
    entry: &BaselineTreeEntry,
) -> Result<(OsString, LeafGuard), WorktreeMutationError> {
    match entry.mode {
        0o100644 | 0o100755 => {
            let (name, descriptor) = create_temporary_file(parent, path)?;
            let mut file: fs::File = descriptor.into();
            let result = stream_git_blob_capability(capability, &entry.object_id, &mut file, path)
                .and_then(|_| {
                    let mode = if entry.mode == 0o100755 {
                        Mode::from(0o755)
                    } else {
                        Mode::from(0o644)
                    };
                    fchmod(&file, mode).map_err(|error| path_errno(path, error))?;
                    file.sync_all()
                        .map_err(|source| WorktreeMutationError::PathUnavailable {
                            path: PathBuf::from(path),
                            source,
                        })
                });
            drop(file);
            if let Err(error) = result {
                let _ = unlinkat(parent, &name, AtFlags::empty());
                return Err(error);
            }
            match capture_leaf_guard_at(parent, &name, path) {
                Ok(guard) => Ok((name, guard)),
                Err(error) => {
                    let _ = unlinkat(parent, &name, AtFlags::empty());
                    Err(error)
                }
            }
        }
        0o120000 => {
            let target = read_symlink_blob_capability(capability, &entry.object_id)?;
            let target = OsString::from_vec(target);
            let name = reserve_temporary_symlink(parent, &target, path)?;
            match capture_leaf_guard_at(parent, &name, path) {
                Ok(guard) => Ok((name, guard)),
                Err(error) => {
                    let _ = unlinkat(parent, &name, AtFlags::empty());
                    Err(error)
                }
            }
        }
        0o160000 => Err(unsafe_path(
            path,
            "基线目标是 Git 子模块，当前不支持安全回滚",
        )),
        mode => Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线树条目",
            detail: format!("不支持的 Git 文件模式 {mode:o}"),
        }),
    }
}

#[cfg(unix)]
fn stream_git_blob_capability(
    capability: &RepositoryCapability,
    object_id: &str,
    destination: &mut fs::File,
    path: &str,
) -> Result<(), WorktreeMutationError> {
    capability.verify_binding()?;
    let mut child = configured_git_command_for_capability(capability)
        .args(["cat-file", "blob", object_id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(WorktreeMutationError::GitUnavailable)?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| WorktreeMutationError::GitCommand {
            operation: "读取基线文件内容",
            detail: "无法读取 cat-file 输出".into(),
        })?;
    if let Err(source) = io::copy(&mut stdout, destination) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(WorktreeMutationError::PathUnavailable {
            path: PathBuf::from(path),
            source,
        });
    }
    drop(stdout);
    let output = child
        .wait_with_output()
        .map_err(WorktreeMutationError::GitUnavailable)?;
    capability.verify_binding()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(WorktreeMutationError::GitCommand {
            operation: "读取基线文件内容",
            detail: stderr_detail(&output),
        })
    }
}

#[cfg(unix)]
fn read_symlink_blob_capability(
    capability: &RepositoryCapability,
    object_id: &str,
) -> Result<Vec<u8>, WorktreeMutationError> {
    const MAX_SYMBOLIC_LINK_BYTES: u64 = 64 * 1024;

    let size = run_git_capability(
        capability,
        "读取基线符号链接大小",
        ["cat-file", "-s", object_id],
    )?;
    let size = trimmed_utf8(&size.stdout, "读取基线符号链接大小")?
        .parse::<u64>()
        .map_err(|_| WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线符号链接大小",
            detail: "Git 未返回有效的 blob 大小".into(),
        })?;
    if size > MAX_SYMBOLIC_LINK_BYTES {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线符号链接",
            detail: "符号链接目标超过 64 KiB 限额".into(),
        });
    }
    let output = run_git_capability(
        capability,
        "读取基线符号链接",
        ["cat-file", "blob", object_id],
    )?;
    if output.stdout.len() as u64 != size || output.stdout.contains(&0) {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取基线符号链接",
            detail: "符号链接目标长度不符或包含 NUL".into(),
        });
    }
    Ok(output.stdout)
}

#[cfg(unix)]
fn build_path_plans(
    capability: &RepositoryCapability,
    baseline_revision: &str,
    inspection: &WorktreeInspection,
    changes: &[FileChange],
) -> Result<Vec<PlannedPath>, WorktreeMutationError> {
    let mut affected = BTreeSet::new();
    let mut unexpected_if_present = BTreeSet::new();
    for change in changes {
        affected.insert(change.path.clone());
        match change.status {
            FileStatus::Deleted => {
                unexpected_if_present.insert(change.path.clone());
            }
            FileStatus::Renamed => {
                let previous_path = change.previous_path.as_ref().ok_or_else(|| {
                    WorktreeMutationError::UnsafePath {
                        path: change.path.clone(),
                        detail: "重命名变更缺少原路径".into(),
                    }
                })?;
                affected.insert(previous_path.clone());
                let separately_reported = inspection
                    .changes
                    .iter()
                    .any(|candidate| candidate.path == *previous_path && candidate != change);
                if !separately_reported {
                    unexpected_if_present.insert(previous_path.clone());
                }
            }
            FileStatus::Added
            | FileStatus::Modified
            | FileStatus::Copied
            | FileStatus::TypeChanged
            | FileStatus::Untracked => {}
            FileStatus::Unmerged => {
                return Err(WorktreeMutationError::UnmergedChanges {
                    paths: vec![change.path.clone()],
                })
            }
        }
    }

    affected
        .into_iter()
        .map(|path| {
            let baseline = baseline_tree_entry_optional(capability, baseline_revision, &path)?;
            let expected = capture_leaf_guard(capability, &path)?;
            let unexpected = unexpected_if_present.contains(&path);
            if unexpected && !expected.is_missing() {
                return Err(WorktreeMutationError::UnexpectedOccupant { path });
            }
            Ok(PlannedPath {
                path,
                baseline,
                expected,
                unexpected_if_present: unexpected,
            })
        })
        .collect()
}

#[cfg(unix)]
fn verify_path_plan_guards(
    capability: &RepositoryCapability,
    plans: &[PlannedPath],
) -> Result<(), WorktreeMutationError> {
    for plan in plans {
        let current = capture_leaf_guard(capability, &plan.path)?;
        if plan.unexpected_if_present && !current.is_missing() {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: plan.path.clone(),
            });
        }
        if current != plan.expected {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: plan.path.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prepare_paths(
    capability: &RepositoryCapability,
    transaction: &IndexTransaction,
    plans: Vec<PlannedPath>,
    created: &mut Vec<CreatedDirectory>,
    prepared: &mut Vec<PreparedPath>,
) -> Result<(), WorktreeMutationError> {
    prepared.reserve(plans.len());
    let mut reserved_backup_names = BTreeSet::new();
    for plan in plans {
        let backup_name =
            reserve_quarantine_name(transaction, &plan.path, &mut reserved_backup_names)?;
        let parent =
            open_parent_from_capability(capability, &plan.path, plan.baseline.is_some(), created)?;
        let (parent, leaf) = match parent {
            Some((parent, leaf)) => (Some(parent), leaf),
            None => {
                let leaf = validate_relative_mutation_path(&plan.path)?
                    .last()
                    .cloned()
                    .expect("validated non-empty path");
                prepared.push(PreparedPath {
                    plan,
                    parent: None,
                    leaf,
                    backup_name,
                    replacement_name: None,
                    replacement_guard: None,
                });
                continue;
            }
        };
        let parent_stat =
            fstat(parent.as_ref().unwrap()).map_err(|error| path_errno(&plan.path, error))?;
        let quarantine_stat = fstat(&transaction.quarantine)
            .map_err(|error| path_errno("<transaction-directory>", error))?;
        if parent_stat.st_dev != quarantine_stat.st_dev {
            return Err(unsafe_path(
                &plan.path,
                "工作区与 Git 恢复目录不在同一文件系统，无法提供原子隔离",
            ));
        }
        let (replacement_name, replacement_guard) = if let Some(entry) = &plan.baseline {
            let (name, guard) =
                prepare_replacement(capability, parent.as_ref().unwrap(), &plan.path, entry)?;
            (Some(name), Some(guard))
        } else {
            (None, None)
        };
        prepared.push(PreparedPath {
            plan,
            parent,
            leaf,
            backup_name,
            replacement_name,
            replacement_guard,
        });
    }
    Ok(())
}

#[cfg(unix)]
fn reserve_quarantine_name(
    transaction: &IndexTransaction,
    path: &str,
    reserved: &mut BTreeSet<OsString>,
) -> Result<OsString, WorktreeMutationError> {
    for _ in 0..32 {
        let name = random_temporary_name("original")?;
        match statat(&transaction.quarantine, &name, AtFlags::SYMLINK_NOFOLLOW) {
            Err(Errno::NOENT) if reserved.insert(name.clone()) => return Ok(name),
            Err(Errno::NOENT) => continue,
            Ok(_) => continue,
            Err(error) => return Err(path_errno(path, error)),
        }
    }
    Err(unsafe_path(path, "无法分配唯一的隔离文件名"))
}

#[cfg(unix)]
fn move_to_quarantine(
    source_parent: &OwnedFd,
    source_name: &OsStr,
    transaction: &IndexTransaction,
    prefix: &str,
    path: &str,
) -> Result<Option<OsString>, WorktreeMutationError> {
    for _ in 0..32 {
        let backup_name = random_temporary_name(prefix)?;
        match renameat_with(
            source_parent,
            source_name,
            &transaction.quarantine,
            &backup_name,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => return Ok(Some(backup_name)),
            Err(Errno::NOENT) => return Ok(None),
            Err(Errno::EXIST) => continue,
            Err(Errno::XDEV) => {
                return Err(unsafe_path(
                    path,
                    "工作区与 Git 恢复目录不在同一文件系统，无法提供原子隔离",
                ))
            }
            Err(error) => return Err(path_errno(path, error)),
        }
    }
    Err(unsafe_path(path, "无法分配唯一的隔离文件名"))
}

#[cfg(unix)]
fn move_to_quarantine_named(
    source_parent: &OwnedFd,
    source_name: &OsStr,
    transaction: &IndexTransaction,
    backup_name: &OsStr,
    path: &str,
) -> Result<Option<OsString>, WorktreeMutationError> {
    match renameat_with(
        source_parent,
        source_name,
        &transaction.quarantine,
        backup_name,
        RenameFlags::NOREPLACE,
    ) {
        Ok(()) => Ok(Some(backup_name.to_os_string())),
        Err(Errno::NOENT) => Ok(None),
        Err(Errno::EXIST) => Err(unsafe_path(path, "隔离文件名在事务期间被占用")),
        Err(Errno::XDEV) => Err(unsafe_path(
            path,
            "工作区与 Git 恢复目录不在同一文件系统，无法提供原子隔离",
        )),
        Err(error) => Err(path_errno(path, error)),
    }
}

#[cfg(unix)]
fn apply_prepared_path(
    capability: &RepositoryCapability,
    transaction: &IndexTransaction,
    prepared: &mut PreparedPath,
    journal: &mut Vec<WorktreeJournalEntry>,
) -> Result<(), WorktreeMutationError> {
    let Some(parent) = prepared.parent.as_ref() else {
        if !prepared.plan.expected.is_missing() || prepared.plan.baseline.is_some() {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: prepared.plan.path.clone(),
            });
        }
        let current = capture_leaf_guard(capability, &prepared.plan.path)?;
        if !current.is_missing() {
            return Err(WorktreeMutationError::UnexpectedOccupant {
                path: prepared.plan.path.clone(),
            });
        }
        return Ok(());
    };

    let backup_name = move_to_quarantine_named(
        parent,
        &prepared.leaf,
        transaction,
        &prepared.backup_name,
        &prepared.plan.path,
    )?;
    let parent = prepared
        .parent
        .take()
        .expect("the prepared path parent was checked above");
    journal.push(WorktreeJournalEntry {
        path: prepared.plan.path.clone(),
        parent,
        leaf: prepared.leaf.clone(),
        backup_name,
        installed_guard: None,
        replacement_name: prepared.replacement_name.take(),
    });
    let entry = journal
        .last_mut()
        .expect("the journal entry was just pushed");
    let quarantined = match &entry.backup_name {
        Some(name) => capture_leaf_guard_at(&transaction.quarantine, name, &prepared.plan.path)?,
        None => LeafGuard::Missing,
    };
    if prepared.plan.unexpected_if_present && !quarantined.is_missing() {
        return Err(WorktreeMutationError::UnexpectedOccupant {
            path: prepared.plan.path.clone(),
        });
    }
    if quarantined != prepared.plan.expected {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: prepared.plan.path.clone(),
        });
    }

    if let Some(replacement_name) = entry.replacement_name.take() {
        match renameat_with(
            &entry.parent,
            &replacement_name,
            &entry.parent,
            &entry.leaf,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {}
            Err(Errno::EXIST) => {
                entry.replacement_name = Some(replacement_name);
                return Err(WorktreeMutationError::UnexpectedOccupant {
                    path: entry.path.clone(),
                });
            }
            Err(error) => {
                entry.replacement_name = Some(replacement_name);
                return Err(path_errno(&entry.path, error));
            }
        }
        let installed = capture_leaf_guard_at(&entry.parent, &entry.leaf, &entry.path)?;
        if Some(&installed) != prepared.replacement_guard.as_ref() {
            entry.installed_guard = Some(installed);
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: entry.path.clone(),
            });
        }
        entry.installed_guard = Some(installed);
    }
    Ok(())
}

#[cfg(unix)]
fn cleanup_uninstalled_paths(prepared: &mut [PreparedPath]) -> Vec<String> {
    let mut failures = Vec::new();
    for path in prepared {
        if let (Some(parent), Some(name)) = (&path.parent, path.replacement_name.as_ref()) {
            match unlinkat(parent, name, AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => path.replacement_name = None,
                Err(error) => {
                    failures.push(format!("清理预备文件 {} 失败：{error}", path.plan.path))
                }
            }
        }
    }
    failures
}

#[cfg(unix)]
fn remove_created_directories(created: &mut [CreatedDirectory]) -> Vec<String> {
    let mut failures = Vec::new();
    for directory in created.iter().rev() {
        match unlinkat(&directory.parent, &directory.name, AtFlags::REMOVEDIR) {
            Ok(()) | Err(Errno::NOENT) => {}
            Err(error) => failures.push(format!("删除新建目录 {} 失败：{error}", directory.path)),
        }
    }
    failures
}

#[cfg(unix)]
fn compensate_worktree(
    transaction: &IndexTransaction,
    journal: &mut [WorktreeJournalEntry],
    created: &mut [CreatedDirectory],
) -> Vec<String> {
    let mut failures = Vec::new();
    for entry in journal.iter_mut().rev() {
        if let Some(installed_guard) = entry.installed_guard.take() {
            match move_to_quarantine(
                &entry.parent,
                &entry.leaf,
                transaction,
                "installed",
                &entry.path,
            ) {
                Ok(Some(installed_name)) => {
                    match capture_leaf_guard_at(
                        &transaction.quarantine,
                        &installed_name,
                        &entry.path,
                    ) {
                        Ok(actual) if actual == installed_guard => {
                            if let Err(error) =
                                unlinkat(&transaction.quarantine, &installed_name, AtFlags::empty())
                            {
                                failures
                                    .push(format!("清理已安装文件 {} 失败：{error}", entry.path));
                            }
                        }
                        Ok(_) | Err(_) => {
                            let _ = renameat_with(
                                &transaction.quarantine,
                                &installed_name,
                                &entry.parent,
                                &entry.leaf,
                                RenameFlags::NOREPLACE,
                            );
                            failures.push(format!("补偿时发现路径 {} 已被再次修改", entry.path));
                        }
                    }
                }
                Ok(None) => failures.push(format!("补偿时路径 {} 已不存在", entry.path)),
                Err(error) => failures.push(format!("隔离已安装文件 {} 失败：{error}", entry.path)),
            }
        }

        if let Some(name) = entry.replacement_name.take() {
            if let Err(error) = unlinkat(&entry.parent, &name, AtFlags::empty()) {
                if error != Errno::NOENT {
                    failures.push(format!("清理预备文件 {} 失败：{error}", entry.path));
                }
            }
        }

        if let Some(backup_name) = entry.backup_name.take() {
            match renameat_with(
                &transaction.quarantine,
                &backup_name,
                &entry.parent,
                &entry.leaf,
                RenameFlags::NOREPLACE,
            ) {
                Ok(()) => {}
                Err(error) => {
                    entry.backup_name = Some(backup_name);
                    failures.push(format!("恢复原文件 {} 失败：{error}", entry.path));
                }
            }
        }
    }
    failures.extend(remove_created_directories(created));
    failures
}

#[cfg(unix)]
fn cleanup_successful_journal(
    transaction: &IndexTransaction,
    journal: &mut [WorktreeJournalEntry],
) -> Vec<String> {
    let mut failures = Vec::new();
    for entry in journal {
        if let Some(backup_name) = entry.backup_name.as_ref() {
            match unlinkat(&transaction.quarantine, backup_name, AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => entry.backup_name = None,
                Err(error) => failures.push(format!("清理原文件备份 {} 失败：{error}", entry.path)),
            }
        }
        if let Some(name) = entry.replacement_name.as_ref() {
            match unlinkat(&entry.parent, name, AtFlags::empty()) {
                Ok(()) | Err(Errno::NOENT) => entry.replacement_name = None,
                Err(error) => failures.push(format!("清理预备文件 {} 失败：{error}", entry.path)),
            }
        }
    }
    failures
}

#[cfg(unix)]
fn verify_prepared_index_postcondition(
    capability: &RepositoryCapability,
    index_path: &Path,
    affected_paths: &[String],
    require_clean: bool,
) -> Result<(), WorktreeMutationError> {
    let mut args = vec![
        "status".to_string(),
        "--porcelain=v2".to_string(),
        "-z".to_string(),
        "--untracked-files=all".to_string(),
    ];
    if !require_clean {
        args.push("--".into());
        args.extend(affected_paths.iter().cloned());
    }
    let output = run_git_capability_with_index(capability, index_path, "验证预备回滚结果", args)?;
    if output.stdout.is_empty() {
        Ok(())
    } else {
        Err(WorktreeMutationError::PostconditionFailed {
            remaining_paths: affected_paths.to_vec(),
        })
    }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn execute_rollback_transaction<F>(
    path: &Path,
    baseline: &TaskBaseline,
    before: WorktreeInspection,
    changes: &[FileChange],
    affected_paths: Vec<String>,
    require_clean: bool,
    before_transaction: F,
    faults: MutationFaults,
) -> Result<WorktreeMutation, WorktreeMutationError>
where
    F: FnOnce(),
{
    let capability = RepositoryCapability::open(&before.repository_root)?;
    ensure_recovery_not_required(&capability)?;
    verify_repository_guard(&before.repository_root, &before.baseline_revision)?;
    let plans = build_path_plans(&capability, &before.baseline_revision, &before, changes)?;

    before_transaction();

    capability.verify_binding()?;
    verify_repository_guard(&before.repository_root, &before.baseline_revision)?;
    verify_path_plan_guards(&capability, &plans)?;

    let baseline_paths = plans
        .iter()
        .filter(|plan| plan.baseline.is_some())
        .map(|plan| plan.path.clone())
        .collect::<Vec<_>>();
    let absent_paths = plans
        .iter()
        .filter(|plan| plan.baseline.is_none())
        .map(|plan| plan.path.clone())
        .collect::<Vec<_>>();
    let mut transaction = IndexTransaction::begin(&capability)?;
    let mut created = Vec::new();
    let mut prepared = Vec::new();
    let mut journal = Vec::new();

    let operation = (|| -> Result<WorktreeInspection, WorktreeMutationError> {
        transaction.prepare_index(
            &capability,
            &before.baseline_revision,
            &baseline_paths,
            &absent_paths,
        )?;
        prepare_paths(
            &capability,
            &transaction,
            plans,
            &mut created,
            &mut prepared,
        )?;
        transaction.persist_manifest(
            &capability,
            &before.baseline_revision,
            &prepared,
            &created,
        )?;

        let mut applied = 0_usize;
        while !prepared.is_empty() {
            capability.verify_binding()?;
            let path_plan = prepared
                .last_mut()
                .expect("the prepared path list is not empty");
            apply_prepared_path(&capability, &transaction, path_plan, &mut journal)?;
            prepared.pop();
            applied += 1;
            if faults.fail_after_worktree_paths == Some(applied) {
                return Err(WorktreeMutationError::GitCommand {
                    operation: "注入工作树事务故障",
                    detail: format!("已应用 {applied} 个路径后中断"),
                });
            }
        }

        capability.verify_binding()?;
        verify_repository_guard(&before.repository_root, &before.baseline_revision)?;
        verify_prepared_index_postcondition(
            &capability,
            transaction.prepared_path(),
            &affected_paths,
            require_clean,
        )?;
        transaction.commit()?;
        if faults.fail_after_index_commit {
            return Err(WorktreeMutationError::GitCommand {
                operation: "注入索引发布后故障",
                detail: "索引已发布，开始验证补偿".into(),
            });
        }

        capability.verify_binding()?;
        let inspection = inspect_ready_worktree(path, baseline)?;
        capability.verify_binding()?;
        let remaining_paths = inspection
            .changes
            .iter()
            .filter(|change| require_clean || affected_paths.contains(&change.path))
            .map(|change| change.path.clone())
            .collect::<Vec<_>>();
        if !remaining_paths.is_empty() {
            return Err(WorktreeMutationError::PostconditionFailed { remaining_paths });
        }
        Ok(inspection)
    })();

    match operation {
        Ok(inspection) => {
            if let Err(disposition_error) =
                transaction.set_recovery_disposition(RecoveryDisposition::CleanupOnlyCommitted)
            {
                transaction.mark_for_recovery();
                let detail = format!(
                    "回滚已提交，但无法持久化清理阶段：{disposition_error}；Git 恢复目录：{}/{}",
                    transaction.git_directory_path.display(),
                    transaction.quarantine_name.to_string_lossy()
                );
                mark_recovery_required(&capability, detail.clone());
                return Err(WorktreeMutationError::RecoveryRequired { detail });
            }
            let cleanup_failures = cleanup_successful_journal(&transaction, &mut journal);
            if cleanup_failures.is_empty() {
                let transaction_cleanup_failures = transaction.cleanup();
                if transaction_cleanup_failures.is_empty() {
                    Ok(WorktreeMutation {
                        affected_paths,
                        inspection,
                    })
                } else {
                    transaction.mark_for_recovery();
                    let detail = format!(
                        "回滚已提交，但恢复目录清理失败：{}；Git 恢复目录：{}/{}",
                        transaction_cleanup_failures.join("；"),
                        transaction.git_directory_path.display(),
                        transaction.quarantine_name.to_string_lossy()
                    );
                    mark_recovery_required(&capability, detail.clone());
                    Err(WorktreeMutationError::RecoveryRequired { detail })
                }
            } else {
                transaction.mark_for_recovery();
                let detail = format!(
                    "回滚已提交，但隔离备份清理失败：{}；Git 恢复目录：{}/{}",
                    cleanup_failures.join("；"),
                    transaction.git_directory_path.display(),
                    transaction.quarantine_name.to_string_lossy()
                );
                mark_recovery_required(&capability, detail.clone());
                Err(WorktreeMutationError::RecoveryRequired { detail })
            }
        }
        Err(error) => {
            let mut recovery_failures = Vec::new();
            let mut partial_journal_failure = None;
            if transaction.durable_manifest.is_none()
                && (!prepared.is_empty() || !created.is_empty())
            {
                if let Err(journal_error) = transaction.persist_manifest(
                    &capability,
                    &before.baseline_revision,
                    &prepared,
                    &created,
                ) {
                    partial_journal_failure =
                        Some(format!("持久化部分准备资源 journal 失败：{journal_error}"));
                }
            }
            recovery_failures.extend(cleanup_uninstalled_paths(&mut prepared));
            if faults.fail_compensation {
                transaction.mark_for_recovery();
                let journal_detail = partial_journal_failure
                    .as_deref()
                    .map(|detail| format!("；{detail}"))
                    .unwrap_or_default();
                let detail = format!(
                    "故障注入阻止自动补偿{journal_detail}；Git 恢复目录：{}/{}",
                    transaction.git_directory_path.display(),
                    transaction.quarantine_name.to_string_lossy()
                );
                mark_recovery_required(&capability, detail.clone());
                return Err(WorktreeMutationError::RecoveryRequired { detail });
            }

            if let Err(recovery_error) = transaction.restore_original_index() {
                recovery_failures.push(format!("恢复 Git 索引失败：{recovery_error}"));
            }
            recovery_failures.extend(compensate_worktree(
                &transaction,
                &mut journal,
                &mut created,
            ));
            if recovery_failures.is_empty() && transaction.durable_manifest.is_some() {
                if let Err(disposition_error) =
                    transaction.set_recovery_disposition(RecoveryDisposition::CleanupOnlyRestored)
                {
                    recovery_failures
                        .push(format!("更新已补偿恢复 journal 失败：{disposition_error}"));
                }
            }
            if recovery_failures.is_empty() {
                recovery_failures.extend(transaction.cleanup());
                if recovery_failures.is_empty() {
                    Err(error)
                } else {
                    transaction.mark_for_recovery();
                    if let Some(journal_failure) = partial_journal_failure.take() {
                        recovery_failures.insert(0, journal_failure);
                    }
                    let detail = format!(
                        "补偿已完成，但事务资源清理失败：{}；Git 恢复目录：{}/{}；原始错误：{}",
                        recovery_failures.join("；"),
                        transaction.git_directory_path.display(),
                        transaction.quarantine_name.to_string_lossy(),
                        error
                    );
                    mark_recovery_required(&capability, detail.clone());
                    Err(WorktreeMutationError::RecoveryRequired { detail })
                }
            } else {
                transaction.mark_for_recovery();
                if let Some(journal_failure) = partial_journal_failure.take() {
                    recovery_failures.insert(0, journal_failure);
                }
                let detail = format!(
                    "{}；Git 恢复目录：{}/{}；原始错误：{}",
                    recovery_failures.join("；"),
                    transaction.git_directory_path.display(),
                    transaction.quarantine_name.to_string_lossy(),
                    error
                );
                mark_recovery_required(&capability, detail.clone());
                Err(WorktreeMutationError::RecoveryRequired { detail })
            }
        }
    }
}

pub(crate) fn recover_pending_worktree_rollbacks(
    path: &Path,
    baseline: &TaskBaseline,
) -> Result<(), WorktreeMutationError> {
    ensure_safe_mutation_supported()?;
    #[cfg(unix)]
    {
        let _process_guard = mutation_process_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        recover_pending_worktree_rollbacks_locked(path, baseline)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, baseline);
        Err(WorktreeMutationError::UnsupportedSafeMutation {
            platform: std::env::consts::OS,
        })
    }
}

#[cfg(unix)]
fn recover_pending_worktree_rollbacks_locked(
    path: &Path,
    baseline: &TaskBaseline,
) -> Result<(), WorktreeMutationError> {
    let capability = RepositoryCapability::open(&baseline.repository_root)?;
    let (git_directory_path, git_directory, git_stat) = open_git_directory(&capability)?;
    let pending = pending_recovery_directories(&git_directory_path)?;
    if pending.is_empty() {
        recovery_required_repositories()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&capability.identity());
        return Ok(());
    }
    if pending.len() != 1 {
        return Err(WorktreeMutationError::RecoveryRequired {
            detail: format!("发现多个未完成的回滚 journal：{}", pending.join("、")),
        });
    }
    let quarantine_name = &pending[0];
    if !validate_random_name(quarantine_name, ".joydsh-recovery-") {
        return Err(invalid_recovery_manifest("恢复目录名无效"));
    }

    let owner_lock = RepositoryOwnerLock::acquire(&git_directory_path, &git_directory, false)?;
    owner_lock.verify_binding()?;
    let quarantine = openat(
        &git_directory,
        quarantine_name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    let quarantine_stat =
        fstat(&quarantine).map_err(|error| path_errno("<rollback-recovery-directory>", error))?;
    if FileType::from_raw_mode(quarantine_stat.st_mode) != FileType::Directory
        || quarantine_stat.st_uid != git_stat.st_uid
        || quarantine_stat.st_mode & 0o777 != 0o700
        || quarantine_stat.st_dev != git_stat.st_dev
    {
        return Err(unsafe_path(
            "<rollback-recovery-directory>",
            "恢复目录的类型、所有者、权限或文件系统身份无效",
        ));
    }
    let quarantine_path = git_directory_path.join(quarantine_name);
    let manifest_bytes = read_bounded_regular_file_at(
        &quarantine,
        OsStr::new(RECOVERY_MANIFEST_NAME),
        MAX_RECOVERY_MANIFEST_BYTES,
        "<rollback-recovery-manifest>",
        quarantine_stat.st_uid,
        0o600,
    )?;
    let mut manifest: DurableRecoveryManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| invalid_recovery_manifest(format!("manifest JSON 无效：{error}")))?;
    let (original_digest, prepared_digest) =
        validate_recovery_manifest(&manifest, &capability, &git_directory_path, &git_stat)?;
    if manifest.owner_lock_device != owner_lock.device
        || manifest.owner_lock_inode != owner_lock.inode
        || manifest.owner_lock_owner != owner_lock.owner
    {
        return Err(invalid_recovery_manifest(
            "manifest 的 owner lock 身份与当前锁不一致",
        ));
    }
    if manifest.baseline_revision != baseline.revision {
        return Err(WorktreeMutationError::HeadChanged {
            expected: manifest.baseline_revision.clone(),
            actual: Some(baseline.revision.clone()),
        });
    }
    let original_index = read_bounded_regular_file_at(
        &quarantine,
        OsStr::new(RECOVERY_INDEX_NAME),
        MAX_RECOVERY_INDEX_BYTES,
        "<rollback-original-index>",
        quarantine_stat.st_uid,
        0o600,
    )?;
    if digest_bytes(&original_index) != original_digest {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: "<rollback-original-index>".into(),
        });
    }
    let current_index = read_bounded_regular_file_at(
        &git_directory,
        OsStr::new("index"),
        MAX_RECOVERY_INDEX_BYTES,
        ".git/index",
        git_stat.st_uid,
        manifest.index_mode,
    )?;
    let current_index_digest = digest_bytes(&current_index);
    let valid_index = match manifest.disposition {
        RecoveryDisposition::RestoreOriginal => {
            current_index_digest == original_digest || current_index_digest == prepared_digest
        }
        RecoveryDisposition::CleanupOnlyRestored => current_index_digest == original_digest,
        RecoveryDisposition::CleanupOnlyCommitted => current_index_digest == prepared_digest,
    };
    if !valid_index {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: ".git/index".into(),
        });
    }
    let owned_index_lock = validate_owned_index_lock(&git_directory, &manifest)?;

    let workspace = validate_git_workspace(path)?;
    if workspace.repository_root != capability.canonical_path {
        return Err(unsafe_path(
            path.to_string_lossy().as_ref(),
            "恢复请求指向其他工作区",
        ));
    }
    ensure_no_operation_in_progress(&capability.canonical_path)?;
    let snapshots = manifest
        .paths
        .iter()
        .map(|entry| capture_recovery_path_snapshot(&capability, &quarantine, entry))
        .collect::<Result<Vec<_>, _>>()?;
    for snapshot in &snapshots {
        validate_recovery_path_snapshot(manifest.disposition, snapshot)?;
    }
    validate_created_directories(&capability, &manifest)?;
    validate_quarantine_entries(&quarantine_path, &quarantine, &manifest)?;

    capability.verify_binding()?;
    owner_lock.verify_binding()?;
    verify_repository_guard(&capability.canonical_path, &manifest.baseline_revision)?;
    let confirmed_owned_index_lock = validate_owned_index_lock(&git_directory, &manifest)?;
    if confirmed_owned_index_lock != owned_index_lock {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: ".git/index.lock".into(),
        });
    }
    let confirmed_index = read_bounded_regular_file_at(
        &git_directory,
        OsStr::new("index"),
        MAX_RECOVERY_INDEX_BYTES,
        ".git/index",
        git_stat.st_uid,
        manifest.index_mode,
    )?;
    if digest_bytes(&confirmed_index) != current_index_digest {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: ".git/index".into(),
        });
    }

    if let Some(lock_guard) = owned_index_lock.as_ref() {
        remove_exact_leaf(
            &git_directory,
            OsStr::new(RECOVERY_INDEX_LOCK_NAME),
            ".git/index.lock",
            lock_guard,
        )?;
    }

    if manifest.disposition == RecoveryDisposition::RestoreOriginal {
        restore_recovery_paths(&capability, &quarantine, &snapshots)?;
        if current_index_digest == prepared_digest {
            owner_lock.verify_binding()?;
            restore_original_index_bytes(
                &git_directory,
                &original_index,
                &original_digest,
                manifest.index_mode,
            )?;
        }
        remove_recovered_created_directories(&capability, &manifest)?;
        let restored = manifest
            .paths
            .iter()
            .map(|entry| capture_recovery_path_snapshot(&capability, &quarantine, entry))
            .collect::<Result<Vec<_>, _>>()?;
        for snapshot in &restored {
            validate_recovery_path_snapshot(RecoveryDisposition::CleanupOnlyRestored, snapshot)?;
        }
        if digest_openat_file(&git_directory, OsStr::new("index"))? != original_digest {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: ".git/index".into(),
            });
        }
        manifest.disposition = RecoveryDisposition::CleanupOnlyRestored;
        write_recovery_manifest(&quarantine, &manifest)?;
    }

    owner_lock.verify_binding()?;
    capability.verify_binding()?;
    cleanup_recovery_journal(
        &git_directory,
        OsStr::new(quarantine_name),
        &quarantine,
        &quarantine_path,
        &manifest,
        &original_index,
    )?;
    recovery_required_repositories()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&capability.identity());
    Ok(())
}

/// Captures the exact index and worktree bytes that a later rejection would discard.
#[cfg(test)]
fn capture_file_change_snapshot(
    path: &Path,
    baseline: &TaskBaseline,
    expected: &FileChange,
) -> Result<FileChangeSnapshot, WorktreeMutationError> {
    capture_file_change_snapshot_with_hook(path, baseline, expected, || {})
}

pub(crate) fn capture_task_change_snapshots(
    path: &Path,
    baseline: &TaskBaseline,
) -> Result<Vec<FileChangeSnapshot>, WorktreeMutationError> {
    let before = inspect_ready_worktree(path, baseline)?;
    let tokens = fingerprint_change_set(
        &before.repository_root,
        &before.baseline_revision,
        &before.changes,
    )?;
    let after = inspect_ready_worktree(path, baseline)?;
    if after.changes != before.changes {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: first_change_path(&before.changes, &after.changes),
        });
    }
    Ok(before
        .changes
        .into_iter()
        .zip(tokens)
        .map(|(change, snapshot_token)| FileChangeSnapshot {
            change,
            snapshot_token,
        })
        .collect())
}

/// Captures review-only strong tokens even when the task baseline is no longer mutation-ready.
/// These tokens use a separate schema and must never authorize reject or rollback operations.
pub(crate) fn capture_task_readonly_change_snapshots(
    path: &Path,
    baseline: &TaskBaseline,
) -> Result<ReadonlyTaskChangeSnapshots, WorktreeMutationError> {
    capture_task_readonly_change_snapshots_with_hook(path, baseline, || {})
}

fn capture_task_readonly_change_snapshots_with_hook<F>(
    path: &Path,
    baseline: &TaskBaseline,
    before_second_inspection: F,
) -> Result<ReadonlyTaskChangeSnapshots, WorktreeMutationError>
where
    F: FnOnce(),
{
    let before = inspect_changes_from_task_baseline(path, baseline)?;
    let actual_head = before.head_revision.clone();
    let tokens = fingerprint_change_set_with_consistency(
        &before.repository_root,
        &before.baseline_revision,
        &before.changes,
        SnapshotConsistency::Readonly {
            actual_head: actual_head.as_deref(),
        },
    )?;

    before_second_inspection();

    let after = inspect_changes_from_task_baseline(path, baseline)?;
    if after != before {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: first_change_path(&before.changes, &after.changes),
        });
    }
    let snapshots = before
        .changes
        .iter()
        .cloned()
        .zip(tokens)
        .map(|(change, snapshot_token)| FileChangeSnapshot {
            change,
            snapshot_token,
        })
        .collect();
    Ok(ReadonlyTaskChangeSnapshots {
        inspection: before,
        snapshots,
    })
}

#[cfg(test)]
fn capture_file_change_snapshot_with_hook<F>(
    path: &Path,
    baseline: &TaskBaseline,
    expected: &FileChange,
    after_first_fingerprint: F,
) -> Result<FileChangeSnapshot, WorktreeMutationError>
where
    F: FnOnce(),
{
    let before = inspect_ready_worktree(path, baseline)?;
    let actual = find_expected_change(&before, expected)?;
    let first_token =
        fingerprint_change_state(&before.repository_root, &before.baseline_revision, actual)?;

    after_first_fingerprint();

    let after = inspect_ready_worktree(path, baseline)?;
    let confirmed = after
        .changes
        .iter()
        .find(|change| change.path == expected.path)
        .filter(|change| *change == expected)
        .ok_or_else(|| WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: expected.path.clone(),
        })?;
    let confirmed_token =
        fingerprint_change_state(&after.repository_root, &after.baseline_revision, confirmed)?;
    if first_token != confirmed_token {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: expected.path.clone(),
        });
    }

    Ok(FileChangeSnapshot {
        change: confirmed.clone(),
        snapshot_token: confirmed_token,
    })
}

/// Rejects exactly the captured file change. The SHA-256 token covers worktree bytes and index
/// entries, so binary, oversized and staged-only changes cannot pass through a stale UI snapshot.
pub(crate) fn reject_file_change(
    path: &Path,
    baseline: &TaskBaseline,
    expected: &FileChangeSnapshot,
) -> Result<WorktreeMutation, WorktreeMutationError> {
    ensure_safe_mutation_supported()?;
    reject_file_change_with_hook(path, baseline, expected, || {})
}

fn reject_file_change_with_hook<F>(
    path: &Path,
    baseline: &TaskBaseline,
    expected: &FileChangeSnapshot,
    before_write: F,
) -> Result<WorktreeMutation, WorktreeMutationError>
where
    F: FnOnce(),
{
    #[cfg(unix)]
    {
        let _process_guard = mutation_process_lock()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = inspect_ready_worktree(path, baseline)?;
        let capability = RepositoryCapability::open(&before.repository_root)?;
        ensure_recovery_not_required(&capability)?;
        let actual = find_expected_change(&before, &expected.change)?;
        let current_token =
            fingerprint_change_state(&before.repository_root, &before.baseline_revision, actual)?;
        if current_token != expected.snapshot_token {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: expected.change.path.clone(),
            });
        }

        let affected_paths = affected_paths(&expected.change)?;
        ensure_rename_is_isolated(&before, &expected.change, &affected_paths)?;
        preflight_change(&before.repository_root, &expected.change)?;
        let changes = vec![expected.change.clone()];
        execute_rollback_transaction(
            path,
            baseline,
            before,
            &changes,
            affected_paths,
            false,
            before_write,
            MutationFaults::default(),
        )
    }

    #[cfg(not(unix))]
    {
        let _ = (path, baseline, expected, before_write);
        Err(WorktreeMutationError::UnsupportedSafeMutation {
            platform: std::env::consts::OS,
        })
    }
}

fn find_expected_change<'a>(
    inspection: &'a WorktreeInspection,
    expected: &FileChange,
) -> Result<&'a FileChange, WorktreeMutationError> {
    let actual = inspection
        .changes
        .iter()
        .find(|change| change.path == expected.path)
        .ok_or_else(|| WorktreeMutationError::ExpectedChangeMissing {
            path: expected.path.clone(),
        })?;
    if actual != expected {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: expected.path.clone(),
        });
    }
    Ok(actual)
}

/// Restores every change relative to the clean task baseline. All paths are checked before the
/// first write, and success is returned only after a fresh inspection reports a clean worktree.
pub(crate) fn rollback_all_task_changes(
    path: &Path,
    baseline: &TaskBaseline,
    expected: &[FileChangeSnapshot],
) -> Result<WorktreeMutation, WorktreeMutationError> {
    ensure_safe_mutation_supported()?;
    rollback_all_task_changes_with_hook_and_faults(
        path,
        baseline,
        expected,
        || {},
        MutationFaults::default(),
    )
}

#[cfg(unix)]
fn rollback_all_task_changes_with_hook_and_faults<F>(
    path: &Path,
    baseline: &TaskBaseline,
    expected: &[FileChangeSnapshot],
    before_transaction: F,
    faults: MutationFaults,
) -> Result<WorktreeMutation, WorktreeMutationError>
where
    F: FnOnce(),
{
    let _process_guard = mutation_process_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = inspect_ready_worktree(path, baseline)?;
    let capability = RepositoryCapability::open(&before.repository_root)?;
    ensure_recovery_not_required(&capability)?;
    ensure_expected_snapshot_set(&before, expected, false)?;
    let mut affected = BTreeSet::new();
    for change in &before.changes {
        for path in affected_paths(change)? {
            affected.insert(path);
        }
        preflight_change(&before.repository_root, change)?;
    }

    // This is the final compare-and-swap check before the first mutation. It hashes every
    // discarded byte and verifies all involved metadata and index entries remained stable while
    // the set was captured. Any mismatch returns before Git or the filesystem is changed.
    ensure_expected_snapshot_set(&before, expected, true)?;
    let changes = before.changes.clone();
    execute_rollback_transaction(
        path,
        baseline,
        before,
        &changes,
        affected.into_iter().collect(),
        true,
        before_transaction,
        faults,
    )
}

#[cfg(not(unix))]
fn rollback_all_task_changes_with_hook_and_faults<F>(
    _path: &Path,
    _baseline: &TaskBaseline,
    _expected: &[FileChangeSnapshot],
    _before_transaction: F,
    _faults: MutationFaults,
) -> Result<WorktreeMutation, WorktreeMutationError>
where
    F: FnOnce(),
{
    Err(WorktreeMutationError::UnsupportedSafeMutation {
        platform: std::env::consts::OS,
    })
}

fn inspect_ready_worktree(
    path: &Path,
    baseline: &TaskBaseline,
) -> Result<WorktreeInspection, WorktreeMutationError> {
    let inspection = inspect_changes_from_task_baseline(path, baseline)?;
    ensure_inspection_is_ready(&inspection)?;
    verify_repository_guard(&inspection.repository_root, &inspection.baseline_revision)?;
    Ok(inspection)
}

fn ensure_inspection_is_ready(
    inspection: &WorktreeInspection,
) -> Result<(), WorktreeMutationError> {
    if inspection.head_revision.as_deref() != Some(inspection.baseline_revision.as_str()) {
        return Err(WorktreeMutationError::HeadChanged {
            expected: inspection.baseline_revision.clone(),
            actual: inspection.head_revision.clone(),
        });
    }
    let conflicts = inspection
        .changes
        .iter()
        .filter(|change| change.status == FileStatus::Unmerged)
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    if !conflicts.is_empty() {
        return Err(WorktreeMutationError::UnmergedChanges { paths: conflicts });
    }
    ensure_no_operation_in_progress(&inspection.repository_root)
}

fn verify_repository_guard(
    repository_root: &Path,
    expected_revision: &str,
) -> Result<(), WorktreeMutationError> {
    let actual = current_head(repository_root)?;
    if actual.as_deref() != Some(expected_revision) {
        return Err(WorktreeMutationError::HeadChanged {
            expected: expected_revision.to_string(),
            actual,
        });
    }

    let conflicts = current_unmerged_paths(repository_root)?;
    if !conflicts.is_empty() {
        return Err(WorktreeMutationError::UnmergedChanges { paths: conflicts });
    }
    ensure_no_operation_in_progress(repository_root)?;

    let actual = current_head(repository_root)?;
    if actual.as_deref() != Some(expected_revision) {
        return Err(WorktreeMutationError::HeadChanged {
            expected: expected_revision.to_string(),
            actual,
        });
    }
    Ok(())
}

fn preflight_change(
    repository_root: &Path,
    change: &FileChange,
) -> Result<(), WorktreeMutationError> {
    validate_mutation_path(repository_root, &change.path)?;
    match change.status {
        FileStatus::Renamed => {
            let previous_path = change.previous_path.as_deref().ok_or_else(|| {
                WorktreeMutationError::UnsafePath {
                    path: change.path.clone(),
                    detail: "重命名变更缺少原路径".into(),
                }
            })?;
            validate_mutation_path(repository_root, previous_path)?;
            if previous_path.to_lowercase() == change.path.to_lowercase() {
                return Err(WorktreeMutationError::UnsafePath {
                    path: change.path.clone(),
                    detail: "无法安全回滚仅大小写不同的重命名".into(),
                });
            }
        }
        FileStatus::Unmerged => {
            return Err(WorktreeMutationError::UnmergedChanges {
                paths: vec![change.path.clone()],
            })
        }
        FileStatus::Added
        | FileStatus::Modified
        | FileStatus::Deleted
        | FileStatus::Copied
        | FileStatus::TypeChanged
        | FileStatus::Untracked => {}
    }
    Ok(())
}

fn affected_paths(change: &FileChange) -> Result<Vec<String>, WorktreeMutationError> {
    let mut paths = BTreeSet::from([change.path.clone()]);
    if change.status == FileStatus::Renamed {
        let previous_path =
            change
                .previous_path
                .clone()
                .ok_or_else(|| WorktreeMutationError::UnsafePath {
                    path: change.path.clone(),
                    detail: "重命名变更缺少原路径".into(),
                })?;
        paths.insert(previous_path);
    }
    Ok(paths.into_iter().collect())
}

fn ensure_rename_is_isolated(
    inspection: &WorktreeInspection,
    expected: &FileChange,
    affected_paths: &[String],
) -> Result<(), WorktreeMutationError> {
    if expected.status != FileStatus::Renamed {
        return Ok(());
    }
    let affected = affected_paths.iter().collect::<BTreeSet<_>>();
    let conflicting_paths = inspection
        .changes
        .iter()
        .filter(|change| *change != expected && affected.contains(&change.path))
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    if conflicting_paths.is_empty() {
        Ok(())
    } else {
        Err(WorktreeMutationError::OverlappingRename {
            path: expected.path.clone(),
            conflicting_paths,
        })
    }
}

fn ensure_expected_snapshot_set(
    inspection: &WorktreeInspection,
    expected: &[FileChangeSnapshot],
    verify_tokens: bool,
) -> Result<(), WorktreeMutationError> {
    let mut expected_by_path = BTreeMap::new();
    for snapshot in expected {
        if expected_by_path
            .insert(snapshot.change.path.as_str(), snapshot)
            .is_some()
        {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: snapshot.change.path.clone(),
            });
        }
    }
    if expected.len() != inspection.changes.len() {
        return Err(WorktreeMutationError::ExpectedChangeChanged {
            path: first_change_path(
                &inspection.changes,
                &expected
                    .iter()
                    .map(|snapshot| snapshot.change.clone())
                    .collect::<Vec<_>>(),
            ),
        });
    }

    let mut aligned = Vec::with_capacity(inspection.changes.len());
    for change in &inspection.changes {
        let snapshot = expected_by_path.get(change.path.as_str()).ok_or_else(|| {
            WorktreeMutationError::ExpectedChangeChanged {
                path: change.path.clone(),
            }
        })?;
        if snapshot.change != *change {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: change.path.clone(),
            });
        }
        aligned.push(*snapshot);
    }
    if !verify_tokens {
        return Ok(());
    }

    let tokens = fingerprint_change_set(
        &inspection.repository_root,
        &inspection.baseline_revision,
        &inspection.changes,
    )?;
    for (snapshot, token) in aligned.into_iter().zip(tokens) {
        if snapshot.snapshot_token != token {
            return Err(WorktreeMutationError::ExpectedChangeChanged {
                path: snapshot.change.path.clone(),
            });
        }
    }
    Ok(())
}

fn first_change_path(left: &[FileChange], right: &[FileChange]) -> String {
    left.iter()
        .map(|change| change.path.as_str())
        .chain(right.iter().map(|change| change.path.as_str()))
        .min()
        .unwrap_or("<clean-worktree>")
        .to_string()
}

#[derive(Clone, Copy)]
enum SnapshotConsistency<'a> {
    MutationReady,
    Readonly { actual_head: Option<&'a str> },
}

fn fingerprint_change_set(
    repository_root: &Path,
    baseline_revision: &str,
    changes: &[FileChange],
) -> Result<Vec<String>, WorktreeMutationError> {
    fingerprint_change_set_with_consistency(
        repository_root,
        baseline_revision,
        changes,
        SnapshotConsistency::MutationReady,
    )
}

fn fingerprint_change_set_with_consistency(
    repository_root: &Path,
    baseline_revision: &str,
    changes: &[FileChange],
    consistency: SnapshotConsistency<'_>,
) -> Result<Vec<String>, WorktreeMutationError> {
    if changes.is_empty() {
        verify_snapshot_consistency(
            repository_root,
            baseline_revision,
            consistency,
            "<repository-head>",
        )?;
        return Ok(Vec::new());
    }
    let mut path_set = BTreeSet::new();
    for change in changes {
        path_set.extend(affected_paths(change)?);
    }
    let paths = path_set.into_iter().collect::<Vec<_>>();
    let metadata_before = snapshot_path_metadata(repository_root, &paths)?;
    let index_before = index_state(repository_root, &paths)?;
    let tokens = changes
        .iter()
        .map(|change| {
            fingerprint_change_state_with_consistency(
                repository_root,
                baseline_revision,
                change,
                consistency,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let index_after = index_state(repository_root, &paths)?;
    let metadata_after = snapshot_path_metadata(repository_root, &paths)?;
    if index_before != index_after || metadata_before != metadata_after {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: changes[0].path.clone(),
        });
    }
    verify_snapshot_consistency(
        repository_root,
        baseline_revision,
        consistency,
        &changes[0].path,
    )?;
    Ok(tokens)
}

fn fingerprint_change_state(
    repository_root: &Path,
    baseline_revision: &str,
    change: &FileChange,
) -> Result<String, WorktreeMutationError> {
    fingerprint_change_state_with_consistency(
        repository_root,
        baseline_revision,
        change,
        SnapshotConsistency::MutationReady,
    )
}

fn fingerprint_change_state_with_consistency(
    repository_root: &Path,
    baseline_revision: &str,
    change: &FileChange,
    consistency: SnapshotConsistency<'_>,
) -> Result<String, WorktreeMutationError> {
    verify_snapshot_consistency(
        repository_root,
        baseline_revision,
        consistency,
        &change.path,
    )?;
    let paths = affected_paths(change)?;
    for path in &paths {
        validate_mutation_path(repository_root, path)?;
    }

    let metadata_before = snapshot_path_metadata(repository_root, &paths)?;
    let index_before = index_state(repository_root, &paths)?;
    let mut hasher = Sha256::new();
    match consistency {
        SnapshotConsistency::MutationReady => {
            hash_field(&mut hasher, b"schema", b"joydsh-file-change-snapshot-v1");
        }
        SnapshotConsistency::Readonly { actual_head } if actual_head == Some(baseline_revision) => {
            hash_field(&mut hasher, b"schema", b"joydsh-file-change-snapshot-v1");
        }
        SnapshotConsistency::Readonly { actual_head } => {
            hash_field(
                &mut hasher,
                b"schema",
                b"joydsh-file-change-readonly-snapshot-v1",
            );
            match actual_head {
                Some(revision) => {
                    hash_field(&mut hasher, b"actual-head-kind", b"commit");
                    hash_field(&mut hasher, b"actual-head", revision.as_bytes());
                }
                None => hash_field(&mut hasher, b"actual-head-kind", b"none"),
            }
        }
    }
    hash_field(&mut hasher, b"baseline", baseline_revision.as_bytes());
    let encoded_change =
        serde_json::to_vec(change).map_err(|error| WorktreeMutationError::InvalidGitOutput {
            operation: "编码文件变更快照",
            detail: error.to_string(),
        })?;
    hash_field(&mut hasher, b"change", &encoded_change);
    hash_field(&mut hasher, b"index", &index_before);
    for path in &paths {
        hash_worktree_path(&mut hasher, repository_root, path)?;
    }

    let index_after = index_state(repository_root, &paths)?;
    let metadata_after = snapshot_path_metadata(repository_root, &paths)?;
    if index_before != index_after || metadata_before != metadata_after {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: change.path.clone(),
        });
    }
    verify_snapshot_consistency(
        repository_root,
        baseline_revision,
        consistency,
        &change.path,
    )?;

    let digest = hasher.finalize();
    let mut token = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(token)
}

fn verify_snapshot_consistency(
    repository_root: &Path,
    baseline_revision: &str,
    consistency: SnapshotConsistency<'_>,
    changed_path: &str,
) -> Result<(), WorktreeMutationError> {
    match consistency {
        SnapshotConsistency::MutationReady => {
            verify_repository_guard(repository_root, baseline_revision)
        }
        SnapshotConsistency::Readonly { actual_head } => {
            if current_head(repository_root)?.as_deref() == actual_head {
                Ok(())
            } else {
                Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                    path: changed_path.to_string(),
                })
            }
        }
    }
}

fn index_state(repository_root: &Path, paths: &[String]) -> Result<Vec<u8>, WorktreeMutationError> {
    let mut args = vec![
        "ls-files".to_string(),
        "--stage".to_string(),
        "--debug".to_string(),
        "-z".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    Ok(run_git(repository_root, "读取文件索引快照", args)?.stdout)
}

fn hash_field(hasher: &mut Sha256, name: &[u8], value: &[u8]) {
    hasher.update((name.len() as u64).to_be_bytes());
    hasher.update(name);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn hash_worktree_path(
    hasher: &mut Sha256,
    repository_root: &Path,
    path: &str,
) -> Result<(), WorktreeMutationError> {
    validate_mutation_path(repository_root, path)?;
    hash_field(hasher, b"path", path.as_bytes());
    let absolute = repository_root.join(path);
    let metadata = match fs::symlink_metadata(&absolute) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            hash_field(hasher, b"kind", b"missing");
            return Ok(());
        }
        Err(source) => {
            return Err(WorktreeMutationError::PathUnavailable {
                path: absolute,
                source,
            })
        }
    };
    if metadata.file_type().is_dir() {
        return Err(unsafe_path(path, "目标是目录，无法生成文件快照"));
    }
    let expected_metadata = metadata_fingerprint(&metadata);
    hash_metadata_mode(hasher, &metadata);

    if metadata.file_type().is_symlink() {
        hash_field(hasher, b"kind", b"symlink");
        let target =
            fs::read_link(&absolute).map_err(|source| WorktreeMutationError::PathUnavailable {
                path: absolute.clone(),
                source,
            })?;
        hash_field(hasher, b"content", &os_path_bytes(&target));
    } else if metadata.file_type().is_file() {
        hash_field(hasher, b"kind", b"file");
        hasher.update(metadata.len().to_be_bytes());
        let mut file =
            fs::File::open(&absolute).map_err(|source| WorktreeMutationError::PathUnavailable {
                path: absolute.clone(),
                source,
            })?;
        let opened_metadata =
            file.metadata()
                .map_err(|source| WorktreeMutationError::PathUnavailable {
                    path: absolute.clone(),
                    source,
                })?;
        if metadata_fingerprint(&opened_metadata) != expected_metadata {
            return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                path: path.to_string(),
            });
        }

        let mut remaining = metadata.len();
        let mut buffer = [0_u8; 64 * 1024];
        while remaining > 0 {
            let limit = remaining.min(buffer.len() as u64) as usize;
            let read = file.read(&mut buffer[..limit]).map_err(|source| {
                WorktreeMutationError::PathUnavailable {
                    path: absolute.clone(),
                    source,
                }
            })?;
            if read == 0 {
                return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                    path: path.to_string(),
                });
            }
            hasher.update(&buffer[..read]);
            remaining -= read as u64;
        }
        let mut extra = [0_u8; 1];
        if file
            .read(&mut extra)
            .map_err(|source| WorktreeMutationError::PathUnavailable {
                path: absolute.clone(),
                source,
            })?
            != 0
        {
            return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
                path: path.to_string(),
            });
        }
    } else {
        return Err(unsafe_path(path, "目标不是普通文件或符号链接"));
    }

    validate_mutation_path(repository_root, path)?;
    let final_metadata = fs::symlink_metadata(&absolute).map_err(|source| {
        WorktreeMutationError::PathUnavailable {
            path: absolute,
            source,
        }
    })?;
    if metadata_fingerprint(&final_metadata) != expected_metadata {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: path.to_string(),
        });
    }
    Ok(())
}

fn snapshot_path_metadata(
    repository_root: &Path,
    paths: &[String],
) -> Result<Vec<(String, Option<PathMetadataFingerprint>)>, WorktreeMutationError> {
    paths
        .iter()
        .map(|path| {
            validate_mutation_path(repository_root, path)?;
            let absolute = repository_root.join(path);
            let metadata = match fs::symlink_metadata(&absolute) {
                Ok(metadata) => Some(metadata_fingerprint(&metadata)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(source) => {
                    return Err(WorktreeMutationError::PathUnavailable {
                        path: absolute,
                        source,
                    })
                }
            };
            Ok((path.clone(), metadata))
        })
        .collect()
}

#[derive(Debug, Eq, PartialEq)]
struct PathMetadataFingerprint {
    kind: u8,
    len: u64,
    readonly: bool,
    modified_nanos: Option<u128>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    modified_seconds: i64,
    #[cfg(unix)]
    modified_subseconds: i64,
    #[cfg(unix)]
    change_seconds: i64,
    #[cfg(unix)]
    change_subseconds: i64,
    #[cfg(windows)]
    file_attributes: u32,
    #[cfg(windows)]
    creation_time: u64,
    #[cfg(windows)]
    last_write_time: u64,
}

fn metadata_fingerprint(metadata: &fs::Metadata) -> PathMetadataFingerprint {
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
            readonly: metadata.permissions().readonly(),
            modified_nanos,
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
            modified_seconds: metadata.mtime(),
            modified_subseconds: metadata.mtime_nsec(),
            change_seconds: metadata.ctime(),
            change_subseconds: metadata.ctime_nsec(),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        PathMetadataFingerprint {
            kind,
            len: metadata.len(),
            readonly: metadata.permissions().readonly(),
            modified_nanos,
            file_attributes: metadata.file_attributes(),
            creation_time: metadata.creation_time(),
            last_write_time: metadata.last_write_time(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        PathMetadataFingerprint {
            kind,
            len: metadata.len(),
            readonly: metadata.permissions().readonly(),
            modified_nanos,
        }
    }
}

fn hash_metadata_mode(hasher: &mut Sha256, metadata: &fs::Metadata) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        hasher.update(metadata.mode().to_be_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        hasher.update(metadata.file_attributes().to_be_bytes());
    }
    #[cfg(not(any(unix, windows)))]
    {
        hasher.update([u8::from(metadata.permissions().readonly())]);
    }
}

#[cfg(unix)]
fn os_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn os_path_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn os_path_bytes(path: &Path) -> Vec<u8> {
    path.as_os_str().to_string_lossy().into_owned().into_bytes()
}

fn validate_mutation_path(repository_root: &Path, path: &str) -> Result<(), WorktreeMutationError> {
    if path.is_empty() || path.contains('\0') {
        return Err(unsafe_path(path, "路径为空或包含 NUL"));
    }

    let components = Path::new(path).components().collect::<Vec<_>>();
    if components.is_empty()
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(unsafe_path(path, "路径不是规范的仓库内相对路径"));
    }
    let Component::Normal(first) = components[0] else {
        unreachable!("all path components were checked above")
    };
    if first.to_string_lossy().eq_ignore_ascii_case(".git") {
        return Err(unsafe_path(path, "路径指向 Git 元数据目录"));
    }

    let mut current = repository_root.to_path_buf();
    let mut missing_parent = false;
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            unreachable!("all path components were checked above")
        };
        current.push(name);
        if missing_parent {
            continue;
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing_parent = true;
                continue;
            }
            Err(source) => {
                return Err(WorktreeMutationError::PathUnavailable {
                    path: current,
                    source,
                })
            }
        };
        let is_leaf = index + 1 == components.len();
        if !is_leaf && metadata_is_link_like(&metadata) {
            return Err(unsafe_path(path, "路径包含中间符号链接"));
        }
        if !is_leaf && !metadata.file_type().is_dir() {
            return Err(unsafe_path(path, "路径的中间组件不是目录"));
        }
        if is_leaf && metadata.file_type().is_dir() {
            return Err(unsafe_path(path, "目标是目录，禁止递归删除或覆盖"));
        }
    }
    Ok(())
}

fn metadata_is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn unsafe_path(path: &str, detail: impl Into<String>) -> WorktreeMutationError {
    WorktreeMutationError::UnsafePath {
        path: path.to_string(),
        detail: detail.into(),
    }
}

#[cfg(unix)]
#[derive(Clone, Debug)]
struct BaselineTreeEntry {
    mode: u32,
    object_id: String,
}

#[cfg(unix)]
fn create_temporary_file(
    parent: &OwnedFd,
    path: &str,
) -> Result<(OsString, OwnedFd), WorktreeMutationError> {
    for _ in 0..32 {
        let name = next_temporary_name();
        match openat(
            parent,
            &name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::from(0o600),
        ) {
            Ok(descriptor) => return Ok((name, descriptor)),
            Err(Errno::EXIST) => continue,
            Err(error) => return Err(path_errno(path, error)),
        }
    }
    Err(unsafe_path(path, "无法分配安全的同目录临时文件"))
}

#[cfg(unix)]
fn reserve_temporary_symlink(
    parent: &OwnedFd,
    target: &OsStr,
    path: &str,
) -> Result<OsString, WorktreeMutationError> {
    for _ in 0..32 {
        let name = next_temporary_name();
        match symlinkat(target, parent, &name) {
            Ok(()) => return Ok(name),
            Err(Errno::EXIST) => continue,
            Err(error) => return Err(path_errno(path, error)),
        }
    }
    Err(unsafe_path(path, "无法分配安全的同目录临时符号链接"))
}

#[cfg(unix)]
fn next_temporary_name() -> OsString {
    let id = ROLLBACK_TEMP_ID.fetch_add(1, Ordering::Relaxed);
    OsString::from(format!(".joydsh-rollback-{}-{id}", std::process::id()))
}

#[cfg(unix)]
fn path_errno(path: &str, error: Errno) -> WorktreeMutationError {
    if matches!(error, Errno::LOOP | Errno::NOTDIR) {
        return unsafe_path(path, "路径包含符号链接或非目录组件");
    }
    WorktreeMutationError::PathUnavailable {
        path: PathBuf::from(path),
        source: io::Error::from_raw_os_error(error.raw_os_error()),
    }
}

fn current_head(repository_root: &Path) -> Result<Option<String>, WorktreeMutationError> {
    let output = run_git_raw(
        repository_root,
        [
            OsStr::new("rev-parse"),
            OsStr::new("--verify"),
            OsStr::new("--quiet"),
            OsStr::new("--end-of-options"),
            OsStr::new("HEAD^{commit}"),
        ],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let revision = trimmed_utf8(&output.stdout, "读取 HEAD")?;
    if revision.len() < 40 || !revision.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取 HEAD",
            detail: "Git 未返回完整对象 ID".into(),
        });
    }
    Ok(Some(revision.to_ascii_lowercase()))
}

fn current_unmerged_paths(repository_root: &Path) -> Result<Vec<String>, WorktreeMutationError> {
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
            .ok_or_else(|| WorktreeMutationError::InvalidGitOutput {
                operation: "读取未解决冲突",
                detail: "索引冲突记录缺少文件路径".into(),
            })?;
        let path = String::from_utf8(record[separator + 1..].to_vec()).map_err(|_| {
            WorktreeMutationError::InvalidGitOutput {
                operation: "读取未解决冲突",
                detail: "冲突文件路径不是 UTF-8".into(),
            }
        })?;
        validate_git_output_path(&path, "读取未解决冲突")?;
        paths.insert(path);
    }
    Ok(paths.into_iter().collect())
}

fn ensure_no_operation_in_progress(repository_root: &Path) -> Result<(), WorktreeMutationError> {
    for (operation, marker) in [
        ("合并", "MERGE_HEAD"),
        ("变基", "rebase-merge"),
        ("变基", "rebase-apply"),
        ("拣选", "CHERRY_PICK_HEAD"),
        ("还原", "REVERT_HEAD"),
        ("拣选或还原序列", "sequencer"),
    ] {
        if git_path_exists(repository_root, marker)? {
            return Err(WorktreeMutationError::OperationInProgress { operation });
        }
    }
    Ok(())
}

fn git_path_exists(repository_root: &Path, name: &str) -> Result<bool, WorktreeMutationError> {
    let output = run_git(
        repository_root,
        "读取 Git 操作状态",
        ["rev-parse", "--git-path", name],
    )?;
    let path = PathBuf::from(trimmed_utf8(&output.stdout, "读取 Git 操作状态")?);
    if path.as_os_str().is_empty() {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation: "读取 Git 操作状态",
            detail: format!("{name} 路径为空"),
        });
    }
    let path = if path.is_absolute() {
        path
    } else {
        repository_root.join(path)
    };
    match fs::symlink_metadata(&path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(WorktreeMutationError::PathUnavailable { path, source }),
    }
}

fn validate_git_output_path(
    path: &str,
    operation: &'static str,
) -> Result<(), WorktreeMutationError> {
    if path.is_empty()
        || path.contains('\0')
        || Path::new(path)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(WorktreeMutationError::InvalidGitOutput {
            operation,
            detail: format!("Git 返回了不安全的相对路径：{path:?}"),
        });
    }
    Ok(())
}

fn trimmed_utf8<'a>(
    output: &'a [u8],
    operation: &'static str,
) -> Result<&'a str, WorktreeMutationError> {
    std::str::from_utf8(output).map(str::trim).map_err(|_| {
        WorktreeMutationError::InvalidGitOutput {
            operation,
            detail: "输出不是 UTF-8".into(),
        }
    })
}

fn run_git<I, S>(
    repository_root: &Path,
    operation: &'static str,
    args: I,
) -> Result<Output, WorktreeMutationError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = run_git_raw(repository_root, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(WorktreeMutationError::GitCommand {
            operation,
            detail: stderr_detail(&output),
        })
    }
}

fn run_git_raw<I, S>(repository_root: &Path, args: I) -> Result<Output, WorktreeMutationError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    configured_git_command(repository_root)
        .args(args)
        .output()
        .map_err(WorktreeMutationError::GitUnavailable)
}

fn configured_git_command(repository_root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("--no-pager")
        .arg("--literal-pathspecs")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .arg("-C")
        .arg(repository_root)
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
        .env_remove("GIT_CONFIG_COUNT");
    command
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
        capture_file_change_snapshot, capture_file_change_snapshot_with_hook,
        capture_task_change_snapshots, capture_task_readonly_change_snapshots,
        capture_task_readonly_change_snapshots_with_hook, recover_pending_worktree_rollbacks,
        reject_file_change, reject_file_change_with_hook, rollback_all_task_changes,
        FileChangeSnapshot, WorktreeMutationError,
    };
    #[cfg(unix)]
    use super::{
        pending_recovery_directories, read_symlink_blob_capability, recovery_required_repositories,
        rollback_all_task_changes_with_hook_and_faults, MutationFaults, RepositoryCapability,
        RECOVERY_INDEX_NAME, RECOVERY_MANIFEST_NAME,
    };
    use crate::worktree::{
        capture_task_baseline, inspect_changes_from_task_baseline, FileChange, FileDiff,
        FileStatus, TaskBaseline,
    };
    use std::{ffi::OsStr, fs, path::Path, process::Command};
    use tempfile::TempDir;

    struct TestRepository {
        directory: TempDir,
    }

    impl TestRepository {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let repository = Self { directory };
            repository.git(["init", "--quiet"]);
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
                .env("GIT_AUTHOR_NAME", "JoyDSH tests")
                .env("GIT_AUTHOR_EMAIL", "joydsh-tests@example.invalid")
                .env("GIT_COMMITTER_NAME", "JoyDSH tests")
                .env("GIT_COMMITTER_EMAIL", "joydsh-tests@example.invalid")
                .env("GIT_MERGE_AUTOEDIT", "no")
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
                .arg(self.path())
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

        fn baseline(&self) -> TaskBaseline {
            capture_task_baseline(self.path()).unwrap()
        }

        fn change(&self, baseline: &TaskBaseline, path: &str) -> FileChange {
            inspect_changes_from_task_baseline(self.path(), baseline)
                .unwrap()
                .changes
                .into_iter()
                .find(|change| change.path == path)
                .unwrap_or_else(|| panic!("missing change {path:?}"))
        }

        fn snapshot(&self, baseline: &TaskBaseline, path: &str) -> FileChangeSnapshot {
            let change = self.change(baseline, path);
            capture_file_change_snapshot(self.path(), baseline, &change).unwrap()
        }

        fn snapshots(&self, baseline: &TaskBaseline) -> Vec<FileChangeSnapshot> {
            capture_task_change_snapshots(self.path(), baseline).unwrap()
        }

        fn index_bytes(&self) -> Vec<u8> {
            fs::read(self.path().join(".git/index")).unwrap()
        }
    }

    #[test]
    fn rejects_modified_and_deleted_files_from_index_and_worktree() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("modified.txt"), "base modified\n").unwrap();
        fs::write(repository.path().join("deleted.txt"), "base deleted\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();

        fs::write(repository.path().join("modified.txt"), "staged\n").unwrap();
        repository.git(["add", "--", "modified.txt"]);
        fs::write(repository.path().join("modified.txt"), "worktree\n").unwrap();
        repository.git(["rm", "--quiet", "--", "deleted.txt"]);

        let modified = repository.snapshot(&baseline, "modified.txt");
        let result = reject_file_change(repository.path(), &baseline, &modified).unwrap();
        assert_eq!(result.affected_paths, ["modified.txt"]);
        assert_eq!(
            fs::read_to_string(repository.path().join("modified.txt")).unwrap(),
            "base modified\n"
        );

        let deleted = repository.snapshot(&baseline, "deleted.txt");
        let result = reject_file_change(repository.path(), &baseline, &deleted).unwrap();
        assert!(result.inspection.clean);
        assert_eq!(
            fs::read_to_string(repository.path().join("deleted.txt")).unwrap(),
            "base deleted\n"
        );
    }

    #[test]
    fn rejects_added_untracked_and_copied_targets_without_touching_the_source() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("source.txt"), "copy source unique\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();

        fs::write(repository.path().join("added.txt"), "brand new unique\n").unwrap();
        repository.git(["add", "--", "added.txt"]);
        fs::write(
            repository.path().join("untracked.txt"),
            "untracked unique\n",
        )
        .unwrap();
        fs::copy(
            repository.path().join("source.txt"),
            repository.path().join("copy.txt"),
        )
        .unwrap();
        repository.git(["add", "--", "copy.txt"]);
        fs::write(
            repository.path().join("source.txt"),
            "source changed after copy\n",
        )
        .unwrap();

        let copy = repository.snapshot(&baseline, "copy.txt");
        assert_eq!(copy.change.status, FileStatus::Copied);
        reject_file_change(repository.path(), &baseline, &copy).unwrap();
        assert!(!repository.path().join("copy.txt").exists());
        assert_eq!(
            fs::read_to_string(repository.path().join("source.txt")).unwrap(),
            "source changed after copy\n"
        );

        let added = repository.snapshot(&baseline, "added.txt");
        assert_eq!(added.change.status, FileStatus::Added);
        reject_file_change(repository.path(), &baseline, &added).unwrap();
        assert!(!repository.path().join("added.txt").exists());

        let untracked = repository.snapshot(&baseline, "untracked.txt");
        assert_eq!(untracked.change.status, FileStatus::Untracked);
        let result = reject_file_change(repository.path(), &baseline, &untracked).unwrap();
        assert!(!result.inspection.clean);
        assert!(!repository.path().join("untracked.txt").exists());

        let source = repository.snapshot(&baseline, "source.txt");
        let result = reject_file_change(repository.path(), &baseline, &source).unwrap();
        assert!(result.inspection.clean);
    }

    #[test]
    fn rejects_a_rename_by_restoring_the_previous_path_and_removing_the_target() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("before.txt"), "rename base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        repository.git(["mv", "--", "before.txt", "after.txt"]);

        let renamed = repository.snapshot(&baseline, "after.txt");
        assert_eq!(renamed.change.status, FileStatus::Renamed);
        let result = reject_file_change(repository.path(), &baseline, &renamed).unwrap();

        assert_eq!(result.affected_paths, ["after.txt", "before.txt"]);
        assert!(result.inspection.clean);
        assert!(!repository.path().join("after.txt").exists());
        assert_eq!(
            fs::read_to_string(repository.path().join("before.txt")).unwrap(),
            "rename base\n"
        );
    }

    #[test]
    fn isolates_a_rename_from_a_new_file_at_its_previous_path() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("before.txt"), "rename base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        repository.git(["mv", "--", "before.txt", "after.txt"]);
        fs::write(
            repository.path().join("before.txt"),
            "independent new file\n",
        )
        .unwrap();

        let renamed = repository.snapshot(&baseline, "after.txt");
        let error = reject_file_change(repository.path(), &baseline, &renamed).unwrap_err();
        assert!(matches!(
            error,
            WorktreeMutationError::OverlappingRename { .. }
        ));
        assert_eq!(
            fs::read_to_string(repository.path().join("before.txt")).unwrap(),
            "independent new file\n"
        );

        let snapshots = repository.snapshots(&baseline);
        let result = rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap();
        assert!(result.inspection.clean);
        assert_eq!(
            fs::read_to_string(repository.path().join("before.txt")).unwrap(),
            "rename base\n"
        );
        assert!(!repository.path().join("after.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_type_change_by_restoring_the_baseline_file() {
        use std::os::unix::fs::symlink;

        let repository = TestRepository::new();
        fs::write(repository.path().join("typed.txt"), "regular base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::remove_file(repository.path().join("typed.txt")).unwrap();
        symlink("outside-target", repository.path().join("typed.txt")).unwrap();
        repository.git(["add", "--", "typed.txt"]);

        let changed = repository.snapshot(&baseline, "typed.txt");
        assert_eq!(changed.change.status, FileStatus::TypeChanged);
        let result = reject_file_change(repository.path(), &baseline, &changed).unwrap();

        assert!(result.inspection.clean);
        assert_eq!(
            fs::read_to_string(repository.path().join("typed.txt")).unwrap(),
            "regular base\n"
        );
    }

    #[test]
    fn refuses_a_stale_expected_change() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "first\n").unwrap();
        let expected = repository.snapshot(&baseline, "tracked.txt");
        fs::write(repository.path().join("tracked.txt"), "second version\n").unwrap();

        let error = reject_file_change(repository.path(), &baseline, &expected).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "second version\n"
        );
    }

    #[test]
    fn refuses_stale_binary_content_with_the_same_diff_category() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("binary.dat"), [0, 1, 2, 3]).unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("binary.dat"), [0, 9, 2, 3]).unwrap();
        let expected = repository.snapshot(&baseline, "binary.dat");
        assert_eq!(expected.change.diff, FileDiff::Binary);
        fs::write(repository.path().join("binary.dat"), [0, 8, 2, 3]).unwrap();
        assert_eq!(repository.change(&baseline, "binary.dat"), expected.change);

        let error = reject_file_change(repository.path(), &baseline, &expected).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(
            fs::read(repository.path().join("binary.dat")).unwrap(),
            [0, 8, 2, 3]
        );
    }

    #[test]
    fn refuses_stale_oversized_content_without_buffering_it_all() {
        const TOO_LARGE_BYTES: usize = 2 * 1024 * 1024 + 1;

        let repository = TestRepository::new();
        fs::write(repository.path().join("large.bin"), b"base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        let first = vec![b'a'; TOO_LARGE_BYTES];
        fs::write(repository.path().join("large.bin"), &first).unwrap();
        let expected = repository.snapshot(&baseline, "large.bin");
        assert!(matches!(expected.change.diff, FileDiff::TooLarge { .. }));
        let mut second = first;
        second[TOO_LARGE_BYTES / 2] = b'b';
        fs::write(repository.path().join("large.bin"), &second).unwrap();

        let error = reject_file_change(repository.path(), &baseline, &expected).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(
            fs::metadata(repository.path().join("large.bin"))
                .unwrap()
                .len(),
            TOO_LARGE_BYTES as u64
        );
    }

    #[test]
    fn refuses_a_stale_index_when_the_worktree_diff_is_unchanged() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "first staged\n").unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        fs::write(repository.path().join("tracked.txt"), "visible worktree\n").unwrap();
        let expected = repository.snapshot(&baseline, "tracked.txt");

        fs::write(repository.path().join("tracked.txt"), "second staged\n").unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        fs::write(repository.path().join("tracked.txt"), "visible worktree\n").unwrap();
        assert_eq!(repository.change(&baseline, "tracked.txt"), expected.change);

        let error = reject_file_change(repository.path(), &baseline, &expected).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "visible worktree\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_index_lock_leaves_staged_and_unstaged_bytes_untouched() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "staged\n").unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        fs::write(repository.path().join("tracked.txt"), "unstaged\n").unwrap();
        let snapshot = repository.snapshot(&baseline, "tracked.txt");
        let index_before = repository.index_bytes();
        fs::write(repository.path().join(".git/index.lock"), "other owner\n").unwrap();

        let error = reject_file_change(repository.path(), &baseline, &snapshot).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::GitCommand {
                operation: "获取索引锁",
                ..
            }
        ));
        assert_eq!(repository.index_bytes(), index_before);
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join(".git/index.lock")).unwrap(),
            "other owner\n"
        );

        let error = rollback_all_task_changes(
            repository.path(),
            &baseline,
            std::slice::from_ref(&snapshot),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorktreeMutationError::GitCommand {
                operation: "获取索引锁",
                ..
            }
        ));
        assert_eq!(repository.index_bytes(), index_before);
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join(".git/index.lock")).unwrap(),
            "other owner\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_leaf_update_after_the_final_snapshot_is_preserved() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "task\n").unwrap();
        let snapshot = repository.snapshot(&baseline, "tracked.txt");
        let index_before = repository.index_bytes();

        let error = reject_file_change_with_hook(repository.path(), &baseline, &snapshot, || {
            fs::write(repository.path().join("tracked.txt"), "concurrent\n").unwrap()
        })
        .unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(repository.index_bytes(), index_before);
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "concurrent\n"
        );
        assert!(!repository.path().join(".git/index.lock").exists());
        assert!(!fs::read_dir(repository.path().join(".git"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter_map(|name| name.into_string().ok())
            .any(|name| name.starts_with(".joydsh-recovery-")));
        assert!(!fs::read_dir(repository.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter_map(|name| name.into_string().ok())
            .any(|name| name.starts_with(".joydsh-rollback-")));
    }

    #[cfg(unix)]
    #[test]
    fn a_mid_worktree_fault_restores_every_path_and_the_raw_index() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("first.txt"), "first base\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("first.txt"), "first staged\n").unwrap();
        repository.git(["add", "--", "first.txt"]);
        fs::write(repository.path().join("first.txt"), "first unstaged\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second task\n").unwrap();
        let snapshots = repository.snapshots(&baseline);
        let index_before = repository.index_bytes();

        let error = rollback_all_task_changes_with_hook_and_faults(
            repository.path(),
            &baseline,
            &snapshots,
            || {},
            MutationFaults {
                fail_after_worktree_paths: Some(1),
                ..MutationFaults::default()
            },
        )
        .unwrap_err();

        assert!(matches!(error, WorktreeMutationError::GitCommand { .. }));
        assert_eq!(repository.index_bytes(), index_before);
        assert_eq!(
            fs::read_to_string(repository.path().join("first.txt")).unwrap(),
            "first unstaged\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("second.txt")).unwrap(),
            "second task\n"
        );
        assert!(!repository.path().join(".git/index.lock").exists());
        assert!(!fs::read_dir(repository.path().join(".git"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter_map(|name| name.into_string().ok())
            .any(|name| name.starts_with(".joydsh-recovery-")));
        assert!(!fs::read_dir(repository.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter_map(|name| name.into_string().ok())
            .any(|name| name.starts_with(".joydsh-rollback-")));
    }

    #[cfg(unix)]
    #[test]
    fn a_fault_after_index_publish_restores_every_path_and_the_raw_index() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("first.txt"), "first base\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("first.txt"), "first task\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second task\n").unwrap();
        repository.git(["add", "--", "first.txt"]);
        let snapshots = repository.snapshots(&baseline);
        let index_before = repository.index_bytes();

        let error = rollback_all_task_changes_with_hook_and_faults(
            repository.path(),
            &baseline,
            &snapshots,
            || {},
            MutationFaults {
                fail_after_index_commit: true,
                ..MutationFaults::default()
            },
        )
        .unwrap_err();

        assert!(matches!(error, WorktreeMutationError::GitCommand { .. }));
        assert_eq!(repository.index_bytes(), index_before);
        assert_eq!(
            fs::read_to_string(repository.path().join("first.txt")).unwrap(),
            "first task\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("second.txt")).unwrap(),
            "second task\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_ignored_rename_source_occupant_is_never_overwritten() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("before.txt"), "rename base\n").unwrap();
        repository.git(["add", "--", "before.txt"]);
        fs::write(repository.path().join(".gitignore"), "before.txt\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        repository.git(["mv", "--", "before.txt", "after.txt"]);
        fs::write(repository.path().join("before.txt"), "ignored occupant\n").unwrap();
        let snapshot = repository.snapshot(&baseline, "after.txt");
        let index_before = repository.index_bytes();

        let error = reject_file_change(repository.path(), &baseline, &snapshot).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::UnexpectedOccupant { .. }
        ));
        assert_eq!(repository.index_bytes(), index_before);
        assert_eq!(
            fs::read_to_string(repository.path().join("before.txt")).unwrap(),
            "ignored occupant\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("after.txt")).unwrap(),
            "rename base\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn index_flags_are_part_of_the_strong_snapshot_token() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "staged task\n").unwrap();
        repository.git(["add", "--", "tracked.txt"]);
        let snapshot = repository.snapshot(&baseline, "tracked.txt");
        repository.git(["update-index", "--assume-unchanged", "--", "tracked.txt"]);
        let index_after_flag = repository.index_bytes();

        let error = reject_file_change(repository.path(), &baseline, &snapshot).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(repository.index_bytes(), index_after_flag);
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "staged task\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recovery_required_blocks_every_later_mutation_for_the_repository() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("first.txt"), "first base\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("first.txt"), "first task\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second task\n").unwrap();
        let snapshots = repository.snapshots(&baseline);
        let index_before = repository.index_bytes();

        let error = rollback_all_task_changes_with_hook_and_faults(
            repository.path(),
            &baseline,
            &snapshots,
            || {},
            MutationFaults {
                fail_after_worktree_paths: Some(1),
                fail_compensation: true,
                ..MutationFaults::default()
            },
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorktreeMutationError::RecoveryRequired { .. }
        ));

        let recovery_directories = fs::read_dir(repository.path().join(".git"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| name.starts_with(".joydsh-recovery-"))
            })
            .collect::<Vec<_>>();
        assert_eq!(recovery_directories.len(), 1);
        let recovery = &recovery_directories[0];
        assert_eq!(
            fs::read(recovery.join(RECOVERY_INDEX_NAME)).unwrap(),
            index_before
        );
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(recovery.join(RECOVERY_MANIFEST_NAME)).unwrap())
                .unwrap();
        assert_eq!(manifest["disposition"], "restore-original");
        let mapped_backup_exists = manifest["paths"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|path| path["quarantineName"].as_str())
            .any(|name| recovery.join(name).exists());
        assert!(mapped_backup_exists);

        let capability = RepositoryCapability::open(repository.path()).unwrap();
        recovery_required_repositories()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&capability.identity());

        let error =
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err();
        assert!(matches!(
            error,
            WorktreeMutationError::RecoveryRequired { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn pending_rollback_journal_is_recovered_before_the_next_artifact_inspection() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("first.txt"), "first base\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("first.txt"), "first task content changed\n").unwrap();
        fs::write(repository.path().join("second.txt"), "second task content changed\n").unwrap();
        let snapshots = repository.snapshots(&baseline);
        let index_before = repository.index_bytes();

        let error = rollback_all_task_changes_with_hook_and_faults(
            repository.path(),
            &baseline,
            &snapshots,
            || {},
            MutationFaults {
                fail_after_worktree_paths: Some(1),
                fail_compensation: true,
                ..MutationFaults::default()
            },
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorktreeMutationError::RecoveryRequired { .. }
        ));

        let capability = RepositoryCapability::open(repository.path()).unwrap();
        recovery_required_repositories()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&capability.identity());

        recover_pending_worktree_rollbacks(repository.path(), &baseline).unwrap();
        let recovered = capture_task_change_snapshots(repository.path(), &baseline).unwrap();

        assert_eq!(
            recovered
                .iter()
                .map(|snapshot| snapshot.change.path.as_str())
                .collect::<Vec<_>>(),
            vec!["first.txt", "second.txt"]
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("first.txt")).unwrap(),
            "first task content changed\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("second.txt")).unwrap(),
            "second task content changed\n"
        );
        assert_eq!(repository.index_bytes(), index_before);
        assert!(
            pending_recovery_directories(&repository.path().join(".git"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn readonly_snapshots_allow_advanced_head_and_bind_the_actual_head() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "task change\n").unwrap();

        let before = capture_task_readonly_change_snapshots(repository.path(), &baseline).unwrap();
        let before_token = before
            .snapshots
            .iter()
            .find(|snapshot| snapshot.change.path == "tracked.txt")
            .unwrap()
            .snapshot_token
            .clone();

        fs::write(repository.path().join("unrelated.txt"), "later commit\n").unwrap();
        repository.git(["add", "--", "unrelated.txt"]);
        repository.git(["commit", "--quiet", "-m", "advance head"]);

        let after = capture_task_readonly_change_snapshots(repository.path(), &baseline).unwrap();
        let after_token = &after
            .snapshots
            .iter()
            .find(|snapshot| snapshot.change.path == "tracked.txt")
            .unwrap()
            .snapshot_token;
        assert_ne!(&before_token, after_token);
        assert!(matches!(
            capture_task_change_snapshots(repository.path(), &baseline).unwrap_err(),
            WorktreeMutationError::HeadChanged { .. }
        ));
    }

    #[test]
    fn readonly_busy_snapshots_preserve_mutation_ready_content_tokens() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        let revision = repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "task change\n").unwrap();
        let ready = capture_task_change_snapshots(repository.path(), &baseline).unwrap();
        let ready_token = ready
            .iter()
            .find(|snapshot| snapshot.change.path == "tracked.txt")
            .unwrap()
            .snapshot_token
            .clone();

        fs::write(
            repository.path().join(".git/MERGE_HEAD"),
            format!("{revision}\n"),
        )
        .unwrap();
        let readonly =
            capture_task_readonly_change_snapshots(repository.path(), &baseline).unwrap();
        let readonly_token = &readonly
            .snapshots
            .iter()
            .find(|snapshot| snapshot.change.path == "tracked.txt")
            .unwrap()
            .snapshot_token;

        assert_eq!(&ready_token, readonly_token);
        assert!(matches!(
            capture_task_change_snapshots(repository.path(), &baseline).unwrap_err(),
            WorktreeMutationError::OperationInProgress {
                operation: "合并"
            }
        ));
    }

    #[test]
    fn readonly_snapshot_detects_head_changes_between_inspections() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "task change\n").unwrap();

        let error =
            capture_task_readonly_change_snapshots_with_hook(repository.path(), &baseline, || {
                fs::write(repository.path().join("unrelated.txt"), "later commit\n").unwrap();
                repository.git(["add", "--", "unrelated.txt"]);
                repository.git(["commit", "--quiet", "-m", "advance head"]);
            })
            .unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::RepositoryChangedDuringSnapshot { .. }
        ));
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "task change\n"
        );
    }

    #[test]
    fn readonly_snapshots_capture_unmerged_changes_during_a_merge() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("conflict.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let main_branch = repository.git(["branch", "--show-current"]);
        repository.git(["checkout", "--quiet", "-b", "conflict-side"]);
        fs::write(repository.path().join("conflict.txt"), "side\n").unwrap();
        repository.commit_all("side change");
        repository.git(["checkout", "--quiet", main_branch.as_str()]);
        fs::write(repository.path().join("conflict.txt"), "main\n").unwrap();
        repository.commit_all("main change");
        let baseline = repository.baseline();
        repository.git_must_fail(["merge", "--no-edit", "conflict-side"]);

        let captured =
            capture_task_readonly_change_snapshots(repository.path(), &baseline).unwrap();

        assert_eq!(
            captured.inspection.head_revision.as_deref(),
            Some(baseline.revision.as_str())
        );
        let conflict = captured
            .snapshots
            .iter()
            .find(|snapshot| snapshot.change.path == "conflict.txt")
            .unwrap();
        assert_eq!(conflict.change.status, FileStatus::Unmerged);
        assert_eq!(conflict.snapshot_token.len(), 64);
    }

    #[cfg(unix)]
    #[test]
    fn an_oversized_symlink_blob_is_rejected_after_the_size_query() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        fs::write(
            repository.path().join("large-target"),
            vec![b'a'; 64 * 1024 + 1],
        )
        .unwrap();
        let object_id = repository.git(["hash-object", "-w", "--", "large-target"]);
        let capability = RepositoryCapability::open(repository.path()).unwrap();

        let error = read_symlink_blob_capability(&capability, &object_id).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::InvalidGitOutput {
                operation: "读取基线符号链接",
                ..
            }
        ));
    }

    #[test]
    fn refuses_a_snapshot_when_binary_content_changes_during_capture() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("binary.dat"), [0, 1, 2, 3]).unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("binary.dat"), [0, 9, 2, 3]).unwrap();
        let expected = repository.change(&baseline, "binary.dat");

        let error =
            capture_file_change_snapshot_with_hook(repository.path(), &baseline, &expected, || {
                fs::write(repository.path().join("binary.dat"), [0, 8, 2, 3]).unwrap()
            })
            .unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::RepositoryChangedDuringSnapshot { .. }
        ));
    }

    #[test]
    fn stale_full_rollback_is_rejected_before_any_path_is_written() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("binary.dat"), [0, 1, 2, 3]).unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("binary.dat"), [0, 9, 2, 3]).unwrap();
        fs::write(repository.path().join("untracked.txt"), "must remain\n").unwrap();
        let snapshots = repository.snapshots(&baseline);
        fs::write(repository.path().join("binary.dat"), [0, 8, 2, 3]).unwrap();

        let error =
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::ExpectedChangeChanged { .. }
        ));
        assert_eq!(
            fs::read(repository.path().join("binary.dat")).unwrap(),
            [0, 8, 2, 3]
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("untracked.txt")).unwrap(),
            "must remain\n"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn treats_every_mutation_path_as_a_literal_git_pathspec() {
        let repository = TestRepository::new();
        let magic_path = ":(glob)*.txt";
        fs::write(repository.path().join(magic_path), "magic base\n").unwrap();
        fs::write(repository.path().join("other.txt"), "other base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join(magic_path), "magic task\n").unwrap();
        fs::write(
            repository.path().join("other.txt"),
            "other task changed length\n",
        )
        .unwrap();

        let expected = repository.snapshot(&baseline, magic_path);
        let result = reject_file_change(repository.path(), &baseline, &expected).unwrap();

        assert!(
            !result.inspection.clean,
            "unexpected clean result; status={:?}, other={:?}, index={:?}, worktree_oid={:?}",
            repository.git(["status", "--short"]),
            fs::read_to_string(repository.path().join("other.txt")).unwrap(),
            repository.git(["ls-files", "--stage", "--", "other.txt"]),
            repository.git(["hash-object", "--", "other.txt"])
        );
        assert_eq!(
            fs::read_to_string(repository.path().join(magic_path)).unwrap(),
            "magic base\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("other.txt")).unwrap(),
            "other task changed length\n"
        );
    }

    #[test]
    fn refuses_rollback_after_head_advances() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "committed later\n").unwrap();
        let snapshots = repository.snapshots(&baseline);
        repository.commit_all("advance head");

        let error =
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err();

        assert!(matches!(error, WorktreeMutationError::HeadChanged { .. }));
        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "committed later\n"
        );
    }

    #[test]
    fn refuses_rollback_with_unmerged_changes() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("conflict.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let main_branch = repository.git(["branch", "--show-current"]);
        repository.git(["checkout", "--quiet", "-b", "conflict-side"]);
        fs::write(repository.path().join("conflict.txt"), "side\n").unwrap();
        repository.commit_all("side change");
        repository.git(["checkout", "--quiet", main_branch.as_str()]);
        fs::write(repository.path().join("conflict.txt"), "main\n").unwrap();
        repository.commit_all("main change");
        let baseline = repository.baseline();
        repository.git_must_fail(["merge", "--no-edit", "conflict-side"]);

        let error = rollback_all_task_changes(repository.path(), &baseline, &[]).unwrap_err();

        assert!(matches!(
            error,
            WorktreeMutationError::UnmergedChanges { .. }
        ));
    }

    #[test]
    fn refuses_git_operation_markers() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        let revision = repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::write(repository.path().join("tracked.txt"), "task change\n").unwrap();
        let snapshots = repository.snapshots(&baseline);
        let git_directory = repository.path().join(".git");

        fs::write(git_directory.join("MERGE_HEAD"), format!("{revision}\n")).unwrap();
        assert!(matches!(
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err(),
            WorktreeMutationError::OperationInProgress {
                operation: "合并"
            }
        ));
        fs::remove_file(git_directory.join("MERGE_HEAD")).unwrap();

        fs::create_dir(git_directory.join("rebase-merge")).unwrap();
        assert!(matches!(
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err(),
            WorktreeMutationError::OperationInProgress {
                operation: "变基"
            }
        ));
        fs::remove_dir(git_directory.join("rebase-merge")).unwrap();

        fs::write(
            git_directory.join("CHERRY_PICK_HEAD"),
            format!("{revision}\n"),
        )
        .unwrap();
        assert!(matches!(
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err(),
            WorktreeMutationError::OperationInProgress {
                operation: "拣选"
            }
        ));
        fs::remove_file(git_directory.join("CHERRY_PICK_HEAD")).unwrap();

        fs::write(git_directory.join("REVERT_HEAD"), format!("{revision}\n")).unwrap();
        assert!(matches!(
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err(),
            WorktreeMutationError::OperationInProgress {
                operation: "还原"
            }
        ));
        fs::remove_file(git_directory.join("REVERT_HEAD")).unwrap();

        fs::create_dir(git_directory.join("sequencer")).unwrap();
        assert!(matches!(
            rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap_err(),
            WorktreeMutationError::OperationInProgress {
                operation: "拣选或还原序列"
            }
        ));
        fs::remove_dir(git_directory.join("sequencer")).unwrap();

        assert_eq!(
            fs::read_to_string(repository.path().join("tracked.txt")).unwrap(),
            "task change\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_restore_through_an_intermediate_symbolic_link() {
        use std::os::unix::fs::symlink;

        let repository = TestRepository::new();
        fs::create_dir(repository.path().join("nested")).unwrap();
        fs::write(repository.path().join("nested/tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::remove_file(repository.path().join("nested/tracked.txt")).unwrap();
        fs::remove_dir(repository.path().join("nested")).unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("tracked.txt"), "outside\n").unwrap();
        symlink(external.path(), repository.path().join("nested")).unwrap();

        let deleted = repository.change(&baseline, "nested/tracked.txt");
        let error =
            capture_file_change_snapshot(repository.path(), &baseline, &deleted).unwrap_err();

        assert!(matches!(error, WorktreeMutationError::UnsafePath { .. }));
        assert_eq!(
            fs::read_to_string(external.path().join("tracked.txt")).unwrap(),
            "outside\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_parent_symlink_swap_after_the_final_preflight() {
        use std::os::unix::fs::symlink;

        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();
        fs::create_dir(repository.path().join("nested")).unwrap();
        fs::write(repository.path().join("nested/new.txt"), "task file\n").unwrap();
        let snapshot = repository.snapshot(&baseline, "nested/new.txt");
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("new.txt"), "outside\n").unwrap();

        let error = reject_file_change_with_hook(repository.path(), &baseline, &snapshot, || {
            fs::remove_file(repository.path().join("nested/new.txt")).unwrap();
            fs::remove_dir(repository.path().join("nested")).unwrap();
            symlink(external.path(), repository.path().join("nested")).unwrap();
        })
        .unwrap_err();

        assert!(matches!(error, WorktreeMutationError::UnsafePath { .. }));
        assert_eq!(
            fs::read_to_string(external.path().join("new.txt")).unwrap(),
            "outside\n"
        );
        assert!(fs::symlink_metadata(repository.path().join("nested"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_repository_root_swap_never_redirects_git_or_file_writes() {
        use std::os::unix::fs::symlink;

        let repository = TestRepository::new();
        fs::write(repository.path().join("tracked.txt"), "base\n").unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();

        let external_parent = tempfile::tempdir().unwrap();
        let external = external_parent.path().join("external");
        let clone = Command::new("git")
            .args(["clone", "--quiet"])
            .arg(repository.path())
            .arg(&external)
            .output()
            .unwrap();
        assert!(
            clone.status.success(),
            "git clone failed: {}",
            String::from_utf8_lossy(&clone.stderr)
        );

        fs::write(repository.path().join("tracked.txt"), "task\n").unwrap();
        let snapshot = repository.snapshot(&baseline, "tracked.txt");
        let original_path = repository.path().to_path_buf();
        let moved_path = original_path.with_extension("joydsh-moved");

        let error = reject_file_change_with_hook(&original_path, &baseline, &snapshot, || {
            fs::rename(&original_path, &moved_path).unwrap();
            symlink(&external, &original_path).unwrap();
        })
        .unwrap_err();

        fs::remove_file(&original_path).unwrap();
        fs::rename(&moved_path, &original_path).unwrap();
        assert!(matches!(error, WorktreeMutationError::UnsafePath { .. }));
        assert_eq!(
            fs::read_to_string(original_path.join("tracked.txt")).unwrap(),
            "task\n"
        );
        assert_eq!(
            fs::read_to_string(external.join("tracked.txt")).unwrap(),
            "base\n"
        );
    }

    #[test]
    fn rolls_back_all_major_change_kinds_to_a_clean_baseline() {
        let repository = TestRepository::new();
        fs::write(repository.path().join("modified.txt"), "modified base\n").unwrap();
        fs::write(repository.path().join("deleted.txt"), "deleted base\n").unwrap();
        fs::write(
            repository.path().join("rename-old.txt"),
            "rename base unique\n",
        )
        .unwrap();
        fs::write(
            repository.path().join("copy-source.txt"),
            "copy base unique\n",
        )
        .unwrap();
        repository.commit_all("initial");
        let baseline = repository.baseline();

        fs::write(repository.path().join("modified.txt"), "modified task\n").unwrap();
        fs::remove_file(repository.path().join("deleted.txt")).unwrap();
        repository.git(["mv", "--", "rename-old.txt", "rename-new.txt"]);
        fs::copy(
            repository.path().join("copy-source.txt"),
            repository.path().join("copied.txt"),
        )
        .unwrap();
        repository.git(["add", "--", "copied.txt"]);
        fs::write(repository.path().join("added.txt"), "added task unique\n").unwrap();
        repository.git(["add", "--", "added.txt"]);
        fs::write(
            repository.path().join("untracked.txt"),
            "untracked task unique\n",
        )
        .unwrap();

        let snapshots = repository.snapshots(&baseline);
        let result = rollback_all_task_changes(repository.path(), &baseline, &snapshots).unwrap();

        assert!(result.inspection.clean);
        assert_eq!(result.affected_paths.len(), 7);
        assert_eq!(repository.git(["status", "--porcelain"]), "");
        assert_eq!(
            fs::read_to_string(repository.path().join("modified.txt")).unwrap(),
            "modified base\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("deleted.txt")).unwrap(),
            "deleted base\n"
        );
        assert_eq!(
            fs::read_to_string(repository.path().join("rename-old.txt")).unwrap(),
            "rename base unique\n"
        );
        assert!(!repository.path().join("rename-new.txt").exists());
        assert!(!repository.path().join("copied.txt").exists());
        assert!(!repository.path().join("added.txt").exists());
        assert!(!repository.path().join("untracked.txt").exists());
    }
}
