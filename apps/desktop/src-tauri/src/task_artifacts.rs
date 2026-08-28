use crate::worktree::{
    capture_task_baseline, capture_task_baseline_from_head, inspect_changes_from_task_baseline,
    validate_git_workspace, FileDiff, FileStatus, TaskBaseline, WorktreeError, WorktreeInspection,
};
#[cfg(unix)]
use crate::worktree_commits::recover_pending_worktree_commits;
use crate::worktree_commits::{
    commit_accepted_changes, AcceptedCommitPath, WorktreeCommit, WorktreeCommitError,
};
#[cfg(unix)]
use crate::worktree_mutations::recover_pending_worktree_rollbacks;
use crate::worktree_mutations::{
    capture_task_change_snapshots, capture_task_readonly_change_snapshots, reject_file_change,
    rollback_all_task_changes, FileChangeSnapshot, WorktreeMutationError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tempfile::{Builder as TempFileBuilder, NamedTempFile, TempPath};

const STORE_VERSION: u32 = 1;
const MAX_CAPTURED_AT_MS: u64 = 253_402_300_799_999;
const MAX_STORE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TEMPORARY_CANDIDATES: usize = 32;
const MAX_BASELINES: usize = 10_000;
const MAX_TOTAL_TASK_ID_BYTES: usize = 1024 * 1024;
const MAX_ACCEPTED_CHANGE_IDS_PER_TASK: usize = 1_000;
const MAX_TOTAL_ACCEPTED_CHANGE_IDS: usize = 100_000;
const MAX_CHANGE_ID_BYTES: usize = 256;
const TOKEN_KEY_BYTES: usize = 32;
const TEMP_FILE_SUFFIX: &str = ".tmp";

static IN_PROCESS_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskArtifactData {
    version: u32,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    token_key: Option<String>,
    baselines: HashMap<String, TaskBaseline>,
    #[serde(default)]
    accepted_change_ids: HashMap<String, BTreeSet<String>>,
}

#[derive(Deserialize)]
struct TaskArtifactHeader {
    version: u32,
}

impl Default for TaskArtifactData {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            generation: 0,
            token_key: None,
            baselines: HashMap::new(),
            accepted_change_ids: HashMap::new(),
        }
    }
}

enum StoreDataError {
    Damaged(String),
    UnsupportedVersion(u32),
}

struct RecoverySnapshot {
    path: PathBuf,
    data: TaskArtifactData,
}

impl StoreDataError {
    fn message(self) -> String {
        match self {
            Self::Damaged(detail) => format!("任务成果基线已损坏：{detail}"),
            Self::UnsupportedVersion(version) => {
                format!("不支持的任务成果基线版本：{version}")
            }
        }
    }
}

pub(crate) struct TaskArtifactStore {
    config_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArtifactFileReviewAction {
    Accept,
    Reject,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArtifactReviewState {
    Pending,
    Accepted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArtifactMutationBlockedReason {
    #[allow(dead_code)]
    TaskRunning,
    HeadAdvanced,
    Conflicted,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "availability", rename_all = "kebab-case")]
pub(crate) enum ArtifactMutationAvailability {
    Ready,
    Blocked {
        reason: ArtifactMutationBlockedReason,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ArtifactOperationErrorCode {
    StaleSnapshot,
    HeadAdvanced,
    RepositoryBusy,
    Conflicted,
    ChangeNotFound,
    #[allow(dead_code)]
    UnreviewedChanges,
    NothingToCommit,
    Unsupported,
    OperationFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskArtifactFileChange {
    pub(crate) change_id: String,
    pub(crate) review: ArtifactReviewState,
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) previous_path: Option<String>,
    pub(crate) status: FileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) similarity: Option<u8>,
    pub(crate) diff: FileDiff,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskArtifactWorktreeInspection {
    pub(crate) repository_root: PathBuf,
    pub(crate) baseline_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) head_revision: Option<String>,
    pub(crate) clean: bool,
    pub(crate) changes: Vec<TaskArtifactFileChange>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskArtifactInspection {
    pub(crate) baseline: TaskBaseline,
    pub(crate) snapshot_token: String,
    pub(crate) mutation: ArtifactMutationAvailability,
    pub(crate) inspection: TaskArtifactWorktreeInspection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactMutationResult {
    pub(crate) affected_change_ids: Vec<String>,
    pub(crate) latest_snapshot: TaskArtifactInspection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ArtifactCommitPreparation {
    pub(crate) baseline: TaskBaseline,
    pub(crate) snapshot_token: String,
    pub(crate) accepted_change_ids: Vec<String>,
    pub(crate) accepted_paths: Vec<AcceptedCommitPath>,
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
    pub(crate) latest_snapshot: TaskArtifactInspection,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArtifactOperationError {
    pub(crate) code: ArtifactOperationErrorCode,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) latest_snapshot: Option<Box<TaskArtifactInspection>>,
}

impl ArtifactOperationError {
    pub(crate) fn new(code: ArtifactOperationErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            latest_snapshot: None,
        }
    }

    pub(crate) fn with_latest_snapshot(mut self, latest_snapshot: TaskArtifactInspection) -> Self {
        self.latest_snapshot = Some(Box::new(latest_snapshot));
        self
    }
}

impl From<String> for ArtifactOperationError {
    fn from(message: String) -> Self {
        Self::new(ArtifactOperationErrorCode::OperationFailed, message)
    }
}

struct CapturedArtifactState {
    inspection: WorktreeInspection,
    change_tokens: Vec<String>,
    strong_snapshots: Option<Vec<FileChangeSnapshot>>,
    mutation: ArtifactMutationAvailability,
    blocked_error_code: Option<ArtifactOperationErrorCode>,
}

#[derive(Clone, Copy)]
struct ArtifactTokenKey([u8; TOKEN_KEY_BYTES]);

impl TaskArtifactStore {
    pub(crate) fn new(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    pub(crate) fn ensure_baseline(
        &self,
        task_id: &str,
        workspace_path: &Path,
    ) -> Result<TaskBaseline, String> {
        validate_task_id(task_id)?;
        self.with_store_lock(|| {
            let mut data = self.load_locked()?;
            let (_, token_key_created) = ensure_token_key(&mut data)?;
            if let Some(baseline) = data.baselines.get(task_id).cloned() {
                let workspace =
                    validate_git_workspace(workspace_path).map_err(|error| error.to_string())?;
                if workspace.repository_root != baseline.repository_root {
                    return Err("该任务已经绑定到另一个 Git 工作区".into());
                }
                if token_key_created {
                    self.save_mutation_locked(&mut data)?;
                }
                return Ok(baseline);
            }

            let baseline = match capture_task_baseline(workspace_path) {
                Ok(baseline) => baseline,
                Err(WorktreeError::DirtyTaskBaseline) => {
                    capture_task_baseline_from_head(workspace_path)
                        .map_err(|error| error.to_string())?
                }
                Err(error) => return Err(error.to_string()),
            };
            data.baselines.insert(task_id.to_string(), baseline.clone());
            self.save_mutation_locked(&mut data)?;
            Ok(baseline)
        })
    }

    #[cfg(test)]
    pub(crate) fn update_accepted_change_id(
        &self,
        task_id: &str,
        change_id: &str,
        accepted: bool,
    ) -> Result<Vec<String>, String> {
        validate_task_id(task_id)?;
        validate_change_id(change_id)?;
        self.mutate_accepted_change_ids(task_id, |change_ids| {
            if accepted {
                change_ids.insert(change_id.to_string());
            } else {
                change_ids.remove(change_id);
            }
        })
    }

    #[cfg(test)]
    pub(crate) fn replace_accepted_change_ids(
        &self,
        task_id: &str,
        change_ids: Vec<String>,
    ) -> Result<Vec<String>, String> {
        validate_task_id(task_id)?;
        let change_ids = normalize_change_ids(change_ids)?;
        self.mutate_accepted_change_ids(task_id, |accepted| *accepted = change_ids)
    }

    pub(crate) fn inspect(
        &self,
        task_id: &str,
        workspace_path: &Path,
    ) -> Result<TaskArtifactInspection, String> {
        self.inspect_with_optional_mutation_block(task_id, workspace_path, None)
    }

    pub(crate) fn inspect_with_mutation_block(
        &self,
        task_id: &str,
        workspace_path: &Path,
        reason: ArtifactMutationBlockedReason,
        message: String,
    ) -> Result<TaskArtifactInspection, String> {
        self.inspect_with_optional_mutation_block(task_id, workspace_path, Some((reason, message)))
    }

    fn inspect_with_optional_mutation_block(
        &self,
        task_id: &str,
        workspace_path: &Path,
        mutation_block: Option<(ArtifactMutationBlockedReason, String)>,
    ) -> Result<TaskArtifactInspection, String> {
        self.inspect_with_capture_recovery(
            task_id,
            workspace_path,
            mutation_block,
            capture_artifact_state_with_recovery,
        )
    }

    fn inspect_with_capture_recovery(
        &self,
        task_id: &str,
        workspace_path: &Path,
        mutation_block: Option<(ArtifactMutationBlockedReason, String)>,
        capture_with_recovery: impl FnOnce(
            &Path,
            &TaskBaseline,
        )
            -> Result<CapturedArtifactState, WorktreeMutationError>,
    ) -> Result<TaskArtifactInspection, String> {
        validate_task_id(task_id)?;
        self.with_store_lock(|| {
            let mut data = self.load_locked()?;
            let recovery_allowed = mutation_block.is_none();
            let (token_key, token_key_created) = if recovery_allowed {
                ensure_token_key(&mut data)?
            } else {
                let encoded = data
                    .token_key
                    .as_deref()
                    .ok_or("成果令牌密钥尚未初始化，请在任务空闲后重试")?;
                (decode_token_key(encoded)?, false)
            };
            if token_key_created {
                self.save_mutation_locked(&mut data)?;
            }
            let baseline = data
                .baselines
                .get(task_id)
                .cloned()
                .ok_or("该任务没有本地成果基线，不能安全计算或回滚变更")?;
            let mut captured = if recovery_allowed {
                capture_with_recovery(workspace_path, &baseline)
            } else {
                capture_artifact_state(workspace_path, &baseline)
            }
            .map_err(|error| error.to_string())?;
            if matches!(captured.mutation, ArtifactMutationAvailability::Ready) {
                if let Some((reason, message)) = mutation_block {
                    captured.mutation = ArtifactMutationAvailability::Blocked { reason, message };
                }
            }
            let (accepted, changed) =
                reconcile_accepted_change_ids(&mut data, task_id, &baseline, &token_key, &captured);
            if changed && recovery_allowed {
                self.save_mutation_locked(&mut data)?;
            }
            build_task_artifact_inspection(task_id, baseline, &token_key, &captured, &accepted)
        })
    }

    pub(crate) fn prepare_commit(
        &self,
        task_id: &str,
        workspace_path: &Path,
        snapshot_token: &str,
    ) -> Result<ArtifactCommitPreparation, ArtifactOperationError> {
        validate_task_id(task_id).map_err(ArtifactOperationError::from)?;
        self.with_store_lock(|| {
            let mut data = self.load_locked().map_err(ArtifactOperationError::from)?;
            let (token_key, token_key_created) =
                ensure_token_key(&mut data).map_err(ArtifactOperationError::from)?;
            if token_key_created {
                self.save_mutation_locked(&mut data)
                    .map_err(ArtifactOperationError::from)?;
            }
            self.prepare_commit_locked(
                task_id,
                workspace_path,
                snapshot_token,
                &token_key,
                &mut data,
            )
        })
    }

    pub(crate) fn commit_prepared(
        &self,
        task_id: &str,
        workspace_path: &Path,
        snapshot_token: &str,
        expected_change_ids: &[String],
        message: &str,
    ) -> Result<WorktreeCommit, ArtifactOperationError> {
        validate_task_id(task_id).map_err(ArtifactOperationError::from)?;
        let expected_change_ids = normalize_change_ids(expected_change_ids.to_vec())
            .map_err(ArtifactOperationError::from)?;
        self.with_store_lock(|| {
            let mut data = self.load_locked().map_err(ArtifactOperationError::from)?;
            let (token_key, token_key_created) =
                ensure_token_key(&mut data).map_err(ArtifactOperationError::from)?;
            if token_key_created {
                self.save_mutation_locked(&mut data)
                    .map_err(ArtifactOperationError::from)?;
            }
            let prepared = self.prepare_commit_locked(
                task_id,
                workspace_path,
                snapshot_token,
                &token_key,
                &mut data,
            )?;
            let current_change_ids = prepared
                .accepted_change_ids
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            if current_change_ids != expected_change_ids {
                return Err(ArtifactOperationError::new(
                    ArtifactOperationErrorCode::StaleSnapshot,
                    "已接受成果与提交说明提案不再一致，请重新生成",
                )
                .with_latest_snapshot(prepared.latest_snapshot));
            }

            match commit_accepted_changes(
                workspace_path,
                &prepared.baseline,
                &prepared.accepted_paths,
                message,
            ) {
                Ok(committed) => Ok(committed),
                Err(error) => {
                    #[cfg(unix)]
                    if let WorktreeCommitError::RecoveryRequired { journal_id, .. } = &error {
                        if let Some(committed) =
                            recover_completed_worktree_commit(workspace_path, journal_id)
                        {
                            return Ok(committed);
                        }
                    }
                    Err(self.worktree_commit_error_locked(
                        task_id,
                        workspace_path,
                        &prepared.baseline,
                        &token_key,
                        &mut data,
                        error,
                    ))
                }
            }
        })
    }

    fn prepare_commit_locked(
        &self,
        task_id: &str,
        workspace_path: &Path,
        snapshot_token: &str,
        token_key: &ArtifactTokenKey,
        data: &mut TaskArtifactData,
    ) -> Result<ArtifactCommitPreparation, ArtifactOperationError> {
        let baseline = data.baselines.get(task_id).cloned().ok_or_else(|| {
            ArtifactOperationError::new(
                ArtifactOperationErrorCode::OperationFailed,
                "该任务没有本地成果基线，不能安全提交成果",
            )
        })?;
        let captured = match capture_artifact_state_with_recovery(workspace_path, &baseline) {
            Ok(captured) => captured,
            Err(error) => {
                return Err(self.worktree_operation_error_locked(
                    task_id,
                    workspace_path,
                    &baseline,
                    token_key,
                    data,
                    error,
                ))
            }
        };
        let (accepted, reconciled) =
            reconcile_accepted_change_ids(data, task_id, &baseline, token_key, &captured);
        let latest_snapshot = build_task_artifact_inspection(
            task_id,
            baseline.clone(),
            token_key,
            &captured,
            &accepted,
        )
        .map_err(ArtifactOperationError::from)?;

        if let Some(code) = captured.blocked_error_code {
            if reconciled {
                self.save_reconciled_state_locked(data, &latest_snapshot)?;
            }
            return Err(ArtifactOperationError::new(
                code,
                mutation_blocked_message(&captured.mutation),
            )
            .with_latest_snapshot(latest_snapshot));
        }
        if !constant_time_eq(snapshot_token, &latest_snapshot.snapshot_token) {
            if reconciled {
                self.save_reconciled_state_locked(data, &latest_snapshot)?;
            }
            return Err(ArtifactOperationError::new(
                ArtifactOperationErrorCode::StaleSnapshot,
                "成果已经变化，请重新检查后再生成提交说明",
            )
            .with_latest_snapshot(latest_snapshot));
        }

        let mut accepted_change_ids = Vec::new();
        let mut accepted_paths = Vec::new();
        let mut additions = 0_u64;
        let mut deletions = 0_u64;
        for change in &latest_snapshot.inspection.changes {
            if change.review != ArtifactReviewState::Accepted {
                continue;
            }
            let expected_snapshot_token = captured
                .strong_snapshots
                .as_deref()
                .and_then(|snapshots| {
                    snapshots
                        .iter()
                        .find(|snapshot| snapshot.change.path == change.path)
                })
                .map(|snapshot| snapshot.snapshot_token.clone())
                .ok_or_else(|| {
                    ArtifactOperationError::new(
                        ArtifactOperationErrorCode::OperationFailed,
                        format!("无法取得已接受成果的强快照：{}", change.path),
                    )
                    .with_latest_snapshot(latest_snapshot.clone())
                })?;
            accepted_change_ids.push(change.change_id.clone());
            accepted_paths.push(AcceptedCommitPath {
                path: change.path.clone(),
                previous_path: (change.status == FileStatus::Renamed)
                    .then(|| change.previous_path.clone())
                    .flatten(),
                expected_snapshot_token,
            });
            if let FileDiff::Text {
                additions: change_additions,
                deletions: change_deletions,
                ..
            } = &change.diff
            {
                additions = additions.checked_add(*change_additions).ok_or_else(|| {
                    ArtifactOperationError::new(
                        ArtifactOperationErrorCode::OperationFailed,
                        "已接受成果的新增行统计溢出",
                    )
                    .with_latest_snapshot(latest_snapshot.clone())
                })?;
                deletions = deletions.checked_add(*change_deletions).ok_or_else(|| {
                    ArtifactOperationError::new(
                        ArtifactOperationErrorCode::OperationFailed,
                        "已接受成果的删除行统计溢出",
                    )
                    .with_latest_snapshot(latest_snapshot.clone())
                })?;
            }
        }
        if accepted_change_ids.is_empty() {
            return Err(ArtifactOperationError::new(
                ArtifactOperationErrorCode::NothingToCommit,
                "没有已接受的任务成果可提交",
            )
            .with_latest_snapshot(latest_snapshot));
        }

        Ok(ArtifactCommitPreparation {
            baseline,
            snapshot_token: snapshot_token.to_owned(),
            accepted_change_ids,
            accepted_paths,
            additions,
            deletions,
            latest_snapshot,
        })
    }

    pub(crate) fn review_file(
        &self,
        task_id: &str,
        workspace_path: &Path,
        snapshot_token: &str,
        change_id: &str,
        action: ArtifactFileReviewAction,
    ) -> Result<ArtifactMutationResult, ArtifactOperationError> {
        validate_task_id(task_id).map_err(ArtifactOperationError::from)?;
        validate_change_id(change_id).map_err(ArtifactOperationError::from)?;
        self.with_store_lock(|| {
            let mut data = self.load_locked().map_err(ArtifactOperationError::from)?;
            let (token_key, token_key_created) =
                ensure_token_key(&mut data).map_err(ArtifactOperationError::from)?;
            if token_key_created {
                self.save_mutation_locked(&mut data)
                    .map_err(ArtifactOperationError::from)?;
            }
            let baseline = data.baselines.get(task_id).cloned().ok_or_else(|| {
                ArtifactOperationError::new(
                    ArtifactOperationErrorCode::OperationFailed,
                    "该任务没有本地成果基线，不能安全评审变更",
                )
            })?;
            let captured = match capture_artifact_state_with_recovery(workspace_path, &baseline) {
                Ok(captured) => captured,
                Err(error) => {
                    return Err(self.worktree_operation_error_locked(
                        task_id,
                        workspace_path,
                        &baseline,
                        &token_key,
                        &mut data,
                        error,
                    ))
                }
            };
            let (mut accepted, reconciled) =
                reconcile_accepted_change_ids(&mut data, task_id, &baseline, &token_key, &captured);
            let latest = build_task_artifact_inspection(
                task_id,
                baseline.clone(),
                &token_key,
                &captured,
                &accepted,
            )
            .map_err(ArtifactOperationError::from)?;

            if let Some(code) = captured.blocked_error_code {
                if reconciled {
                    self.save_reconciled_state_locked(&mut data, &latest)?;
                }
                return Err(ArtifactOperationError::new(
                    code,
                    mutation_blocked_message(&captured.mutation),
                )
                .with_latest_snapshot(latest));
            }
            if !constant_time_eq(snapshot_token, &latest.snapshot_token) {
                if reconciled {
                    self.save_reconciled_state_locked(&mut data, &latest)?;
                }
                return Err(ArtifactOperationError::new(
                    ArtifactOperationErrorCode::StaleSnapshot,
                    "成果已经变化，请重新检查后再操作",
                )
                .with_latest_snapshot(latest));
            }

            let change_index = match captured
                .change_ids(task_id, &baseline, &token_key)
                .iter()
                .position(|candidate| constant_time_eq(candidate, change_id))
            {
                Some(change_index) => change_index,
                None => {
                    if reconciled {
                        self.save_reconciled_state_locked(&mut data, &latest)?;
                    }
                    return Err(ArtifactOperationError::new(
                        ArtifactOperationErrorCode::ChangeNotFound,
                        "待评审的文件变更已不存在",
                    )
                    .with_latest_snapshot(latest));
                }
            };

            match action {
                ArtifactFileReviewAction::Accept => {
                    accepted.insert(change_id.to_string());
                    set_accepted_change_ids(&mut data, task_id, accepted.clone());
                    self.save_mutation_locked(&mut data)
                        .map_err(ArtifactOperationError::from)?;
                    let latest_snapshot = build_task_artifact_inspection(
                        task_id, baseline, &token_key, &captured, &accepted,
                    )
                    .map_err(ArtifactOperationError::from)?;
                    Ok(ArtifactMutationResult {
                        affected_change_ids: vec![change_id.to_string()],
                        latest_snapshot,
                    })
                }
                ArtifactFileReviewAction::Reject => {
                    let expected = captured
                        .strong_snapshots
                        .as_ref()
                        .and_then(|snapshots| snapshots.get(change_index))
                        .ok_or_else(|| {
                            ArtifactOperationError::new(
                                ArtifactOperationErrorCode::Unsupported,
                                "当前成果快照不支持安全回滚",
                            )
                            .with_latest_snapshot(latest.clone())
                        })?;
                    let accepted_before = accepted.clone();
                    accepted.remove(change_id);
                    let pending_snapshot = build_task_artifact_inspection(
                        task_id,
                        baseline.clone(),
                        &token_key,
                        &captured,
                        &accepted,
                    )
                    .map_err(ArtifactOperationError::from)?;
                    if let Err(error) =
                        self.save_pending_before_mutation_locked(&mut data, task_id, &accepted)
                    {
                        return Err(ArtifactOperationError::new(
                            ArtifactOperationErrorCode::OperationFailed,
                            format!("未执行文件回滚：无法先持久化待评审状态：{error}"),
                        )
                        .with_latest_snapshot(pending_snapshot));
                    }

                    if let Err(error) = reject_file_change(workspace_path, &baseline, expected) {
                        if !matches!(error, WorktreeMutationError::RecoveryRequired { .. }) {
                            if let Err(restore_error) = self
                                .restore_accepted_after_failed_mutation_locked(
                                    &mut data,
                                    task_id,
                                    &accepted_before,
                                    &accepted,
                                )
                            {
                                return Err(ArtifactOperationError::new(
                                    ArtifactOperationErrorCode::OperationFailed,
                                    format!("{error}；{restore_error}"),
                                )
                                .with_latest_snapshot(pending_snapshot));
                            }
                        }
                        return Err(self.worktree_operation_error_locked(
                            task_id,
                            workspace_path,
                            &baseline,
                            &token_key,
                            &mut data,
                            error,
                        ));
                    }

                    let after = capture_artifact_state_with_recovery(workspace_path, &baseline)
                        .map_err(|error| {
                            ArtifactOperationError::new(
                                ArtifactOperationErrorCode::OperationFailed,
                                format!("文件已经回滚，但无法生成最新成果快照：{error}"),
                            )
                        })?;
                    let (accepted, reconciled_after) = reconcile_accepted_change_ids(
                        &mut data, task_id, &baseline, &token_key, &after,
                    );
                    let latest_snapshot = build_task_artifact_inspection(
                        task_id, baseline, &token_key, &after, &accepted,
                    )
                    .map_err(ArtifactOperationError::from)?;
                    if reconciled_after {
                        self.save_reconciled_state_locked(&mut data, &latest_snapshot)?;
                    }
                    Ok(ArtifactMutationResult {
                        affected_change_ids: vec![change_id.to_string()],
                        latest_snapshot,
                    })
                }
            }
        })
    }

    pub(crate) fn rollback(
        &self,
        task_id: &str,
        workspace_path: &Path,
        snapshot_token: &str,
    ) -> Result<ArtifactMutationResult, ArtifactOperationError> {
        validate_task_id(task_id).map_err(ArtifactOperationError::from)?;
        self.with_store_lock(|| {
            let mut data = self.load_locked().map_err(ArtifactOperationError::from)?;
            let (token_key, token_key_created) =
                ensure_token_key(&mut data).map_err(ArtifactOperationError::from)?;
            if token_key_created {
                self.save_mutation_locked(&mut data)
                    .map_err(ArtifactOperationError::from)?;
            }
            let baseline = data.baselines.get(task_id).cloned().ok_or_else(|| {
                ArtifactOperationError::new(
                    ArtifactOperationErrorCode::OperationFailed,
                    "该任务没有本地成果基线，不能安全回滚变更",
                )
            })?;
            let captured = match capture_artifact_state_with_recovery(workspace_path, &baseline) {
                Ok(captured) => captured,
                Err(error) => {
                    return Err(self.worktree_operation_error_locked(
                        task_id,
                        workspace_path,
                        &baseline,
                        &token_key,
                        &mut data,
                        error,
                    ))
                }
            };
            let (accepted, reconciled) =
                reconcile_accepted_change_ids(&mut data, task_id, &baseline, &token_key, &captured);
            let latest = build_task_artifact_inspection(
                task_id,
                baseline.clone(),
                &token_key,
                &captured,
                &accepted,
            )
            .map_err(ArtifactOperationError::from)?;

            if let Some(code) = captured.blocked_error_code {
                if reconciled {
                    self.save_reconciled_state_locked(&mut data, &latest)?;
                }
                return Err(ArtifactOperationError::new(
                    code,
                    mutation_blocked_message(&captured.mutation),
                )
                .with_latest_snapshot(latest));
            }
            if !constant_time_eq(snapshot_token, &latest.snapshot_token) {
                if reconciled {
                    self.save_reconciled_state_locked(&mut data, &latest)?;
                }
                return Err(ArtifactOperationError::new(
                    ArtifactOperationErrorCode::StaleSnapshot,
                    "成果已经变化，请重新检查后再操作",
                )
                .with_latest_snapshot(latest));
            }
            if captured.inspection.clean {
                if reconciled {
                    self.save_reconciled_state_locked(&mut data, &latest)?;
                }
                return Err(ArtifactOperationError::new(
                    ArtifactOperationErrorCode::NothingToCommit,
                    "任务成果没有需要回滚的变更",
                )
                .with_latest_snapshot(latest));
            }

            let affected_change_ids = captured.change_ids(task_id, &baseline, &token_key);
            let expected = captured.strong_snapshots.as_deref().ok_or_else(|| {
                ArtifactOperationError::new(
                    ArtifactOperationErrorCode::Unsupported,
                    "当前成果快照不支持安全回滚",
                )
                .with_latest_snapshot(latest.clone())
            })?;
            let accepted_before = accepted;
            let pending_accepted = BTreeSet::new();
            let pending_snapshot = build_task_artifact_inspection(
                task_id,
                baseline.clone(),
                &token_key,
                &captured,
                &pending_accepted,
            )
            .map_err(ArtifactOperationError::from)?;
            if let Err(error) =
                self.save_pending_before_mutation_locked(&mut data, task_id, &pending_accepted)
            {
                return Err(ArtifactOperationError::new(
                    ArtifactOperationErrorCode::OperationFailed,
                    format!("未执行任务回滚：无法先持久化待评审状态：{error}"),
                )
                .with_latest_snapshot(pending_snapshot));
            }

            if let Err(error) = rollback_all_task_changes(workspace_path, &baseline, expected) {
                if !matches!(error, WorktreeMutationError::RecoveryRequired { .. }) {
                    if let Err(restore_error) = self.restore_accepted_after_failed_mutation_locked(
                        &mut data,
                        task_id,
                        &accepted_before,
                        &pending_accepted,
                    ) {
                        return Err(ArtifactOperationError::new(
                            ArtifactOperationErrorCode::OperationFailed,
                            format!("{error}；{restore_error}"),
                        )
                        .with_latest_snapshot(pending_snapshot));
                    }
                }
                return Err(self.worktree_operation_error_locked(
                    task_id,
                    workspace_path,
                    &baseline,
                    &token_key,
                    &mut data,
                    error,
                ));
            }

            let after = capture_artifact_state_with_recovery(workspace_path, &baseline).map_err(
                |error| {
                    ArtifactOperationError::new(
                        ArtifactOperationErrorCode::OperationFailed,
                        format!("任务成果已经回滚，但无法生成最新快照：{error}"),
                    )
                },
            )?;
            let (accepted, reconciled_after) =
                reconcile_accepted_change_ids(&mut data, task_id, &baseline, &token_key, &after);
            let latest_snapshot =
                build_task_artifact_inspection(task_id, baseline, &token_key, &after, &accepted)
                    .map_err(ArtifactOperationError::from)?;
            if reconciled_after {
                self.save_reconciled_state_locked(&mut data, &latest_snapshot)?;
            }
            Ok(ArtifactMutationResult {
                affected_change_ids,
                latest_snapshot,
            })
        })
    }

    fn save_reconciled_state_locked(
        &self,
        data: &mut TaskArtifactData,
        latest: &TaskArtifactInspection,
    ) -> Result<(), ArtifactOperationError> {
        self.save_mutation_locked(data).map_err(|error| {
            ArtifactOperationError::new(
                ArtifactOperationErrorCode::OperationFailed,
                format!("无法持久化最新评审状态：{error}"),
            )
            .with_latest_snapshot(latest.clone())
        })
    }

    fn save_pending_before_mutation_locked(
        &self,
        data: &mut TaskArtifactData,
        task_id: &str,
        pending_accepted: &BTreeSet<String>,
    ) -> Result<(), String> {
        set_accepted_change_ids(data, task_id, pending_accepted.clone());
        self.save_mutation_locked(data)
    }

    fn restore_accepted_after_failed_mutation_locked(
        &self,
        data: &mut TaskArtifactData,
        task_id: &str,
        accepted_before: &BTreeSet<String>,
        pending_accepted: &BTreeSet<String>,
    ) -> Result<(), String> {
        if accepted_before == pending_accepted {
            return Ok(());
        }

        set_accepted_change_ids(data, task_id, accepted_before.clone());
        if let Err(restore_error) = self.save_mutation_locked(data) {
            set_accepted_change_ids(data, task_id, pending_accepted.clone());
            return match self.save_mutation_locked(data) {
                Ok(()) => Err(format!(
                    "无法恢复操作前的接受状态，已保持为待评审：{restore_error}"
                )),
                Err(pending_error) => Err(format!(
                    "无法恢复操作前的接受状态，也无法确认待评审状态已耐久保存：{restore_error}；{pending_error}"
                )),
            };
        }
        Ok(())
    }

    fn worktree_operation_error_locked(
        &self,
        task_id: &str,
        workspace_path: &Path,
        baseline: &TaskBaseline,
        token_key: &ArtifactTokenKey,
        data: &mut TaskArtifactData,
        error: WorktreeMutationError,
    ) -> ArtifactOperationError {
        let (code, message) = classify_worktree_operation_error(&error);
        let captured = match capture_artifact_state_with_recovery(workspace_path, baseline) {
            Ok(captured) => captured,
            Err(refresh_error) => {
                return ArtifactOperationError::new(
                    code,
                    format!("{message}；同时无法刷新最新成果：{refresh_error}"),
                )
            }
        };
        let (accepted, reconciled) =
            reconcile_accepted_change_ids(data, task_id, baseline, token_key, &captured);
        let latest = match build_task_artifact_inspection(
            task_id,
            baseline.clone(),
            token_key,
            &captured,
            &accepted,
        ) {
            Ok(latest) => latest,
            Err(build_error) => {
                return ArtifactOperationError::new(
                    code,
                    format!("{message}；同时无法生成最新成果快照：{build_error}"),
                )
            }
        };
        if reconciled {
            if let Err(error) = self.save_mutation_locked(data) {
                return ArtifactOperationError::new(
                    code,
                    format!("{message}；同时无法保存最新评审状态：{error}"),
                )
                .with_latest_snapshot(latest);
            }
        }
        ArtifactOperationError::new(code, message).with_latest_snapshot(latest)
    }

    fn worktree_commit_error_locked(
        &self,
        task_id: &str,
        workspace_path: &Path,
        baseline: &TaskBaseline,
        token_key: &ArtifactTokenKey,
        data: &mut TaskArtifactData,
        error: WorktreeCommitError,
    ) -> ArtifactOperationError {
        let (code, message) = classify_worktree_commit_error(&error);
        let captured = match capture_artifact_state_with_recovery(workspace_path, baseline) {
            Ok(captured) => captured,
            Err(refresh_error) => {
                return ArtifactOperationError::new(
                    code,
                    format!("{message}；同时无法刷新最新成果：{refresh_error}"),
                )
            }
        };
        let (accepted, reconciled) =
            reconcile_accepted_change_ids(data, task_id, baseline, token_key, &captured);
        let latest = match build_task_artifact_inspection(
            task_id,
            baseline.clone(),
            token_key,
            &captured,
            &accepted,
        ) {
            Ok(latest) => latest,
            Err(build_error) => {
                return ArtifactOperationError::new(
                    code,
                    format!("{message}；同时无法生成最新成果快照：{build_error}"),
                )
            }
        };
        if reconciled {
            if let Err(save_error) = self.save_mutation_locked(data) {
                return ArtifactOperationError::new(
                    code,
                    format!("{message}；同时无法保存最新评审状态：{save_error}"),
                )
                .with_latest_snapshot(latest);
            }
        }
        ArtifactOperationError::new(code, message).with_latest_snapshot(latest)
    }

    #[cfg(test)]
    fn mutate_accepted_change_ids(
        &self,
        task_id: &str,
        mutation: impl FnOnce(&mut BTreeSet<String>),
    ) -> Result<Vec<String>, String> {
        self.with_store_lock(|| {
            let mut data = self.load_locked()?;
            if !data.baselines.contains_key(task_id) {
                return Err("该任务没有本地成果基线，不能保存评审状态".into());
            }

            let current = data
                .accepted_change_ids
                .get(task_id)
                .cloned()
                .unwrap_or_default();
            let mut updated = current.clone();
            mutation(&mut updated);
            validate_change_ids(&updated)?;
            if updated == current {
                return Ok(updated.into_iter().collect());
            }

            if updated.is_empty() {
                data.accepted_change_ids.remove(task_id);
            } else {
                data.accepted_change_ids
                    .insert(task_id.to_string(), updated.clone());
            }
            self.save_mutation_locked(&mut data)?;
            Ok(updated.into_iter().collect())
        })
    }

    #[cfg(test)]
    fn baseline(&self, task_id: &str) -> Result<Option<TaskBaseline>, String> {
        self.with_store_lock(|| Ok(self.load_locked()?.baselines.get(task_id).cloned()))
    }

    fn with_store_lock<T, E>(&self, operation: impl FnOnce() -> Result<T, E>) -> Result<T, E>
    where
        E: From<String>,
    {
        let parent = self.parent_directory().map_err(E::from)?;
        fs::create_dir_all(parent)
            .map_err(|error| E::from(format!("无法创建任务成果目录：{error}")))?;

        let process_lock = IN_PROCESS_STORE_LOCK.get_or_init(|| Mutex::new(()));
        let _process_guard = process_lock
            .lock()
            .map_err(|_| E::from("任务成果基线进程内锁已损坏".to_string()))?;

        let lock_path = self.lock_path().map_err(E::from)?;
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| E::from(format!("无法打开任务成果基线锁：{error}")))?;
        fs2::FileExt::lock_exclusive(&lock_file)
            .map_err(|error| E::from(format!("无法锁定任务成果基线：{error}")))?;

        let result = operation();
        // The file descriptor's Drop releases the lock even when an explicit unlock fails. Once
        // an operation such as a Git ref update has succeeded, reporting that durable result as a
        // failure would invite an unsafe retry.
        let _ = fs2::FileExt::unlock(&lock_file);
        result
    }

    fn load_locked(&self) -> Result<TaskArtifactData, String> {
        match read_bounded_file(&self.config_path, MAX_STORE_BYTES) {
            Ok(contents) => match parse_data(&contents) {
                Ok(data) => Ok(self
                    .recover_temporary_data(false, Some(&data))?
                    .unwrap_or(data)),
                Err(StoreDataError::UnsupportedVersion(version)) => {
                    Err(StoreDataError::UnsupportedVersion(version).message())
                }
                Err(error) => self
                    .recover_temporary_data(true, None)?
                    .ok_or_else(|| error.message()),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(self
                .recover_temporary_data(true, None)?
                .unwrap_or_else(TaskArtifactData::default)),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => self
                .recover_temporary_data(true, None)?
                .ok_or_else(|| format!("无法读取任务成果基线：{error}")),
            Err(error) => Err(format!("无法读取任务成果基线：{error}")),
        }
    }

    fn save_locked(&self, data: &TaskArtifactData) -> Result<(), String> {
        validate_data(data)?;
        let parent = self.parent_directory()?;
        let contents = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
        if contents.len() as u64 > MAX_STORE_BYTES {
            return Err(format!(
                "任务成果基线不能超过 {} MiB",
                MAX_STORE_BYTES / (1024 * 1024)
            ));
        }
        let prefix = self.temporary_prefix()?;
        let mut temporary = TempFileBuilder::new()
            .prefix(&prefix)
            .suffix(TEMP_FILE_SUFFIX)
            .tempfile_in(parent)
            .map_err(|error| format!("无法创建任务成果临时文件：{error}"))?;

        temporary
            .write_all(&contents)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|error| format!("无法写入任务成果基线：{error}"))?;

        let persisted = persist_new_snapshot(temporary, &self.config_path)
            .map_err(|error| format!("无法原子保存任务成果基线：{error}"))?;
        persisted
            .sync_all()
            .map_err(|error| format!("无法同步任务成果基线：{error}"))?;
        self.cleanup_temporary_files();
        sync_directory(parent).map_err(|error| format!("无法同步任务成果目录：{error}"))
    }

    fn save_mutation_locked(&self, data: &mut TaskArtifactData) -> Result<(), String> {
        data.generation = data
            .generation
            .checked_add(1)
            .ok_or("任务成果 generation 已达到上限，不能继续写入")?;
        self.save_locked(data)
    }

    fn recover_temporary_data(
        &self,
        require_valid_snapshot: bool,
        current: Option<&TaskArtifactData>,
    ) -> Result<Option<TaskArtifactData>, String> {
        let candidates = match self.temporary_candidates() {
            Ok(candidates) => candidates,
            Err(_) if current.is_some() => return Ok(None),
            Err(error) => return Err(error),
        };
        if candidates.is_empty() {
            return Ok(None);
        }

        let mut valid = Vec::new();
        let mut damaged = Vec::new();
        let mut remaining_bytes = MAX_STORE_BYTES;
        for path in candidates {
            let contents = match read_bounded_file(&path, remaining_bytes) {
                Ok(contents) => contents,
                Err(error) if current.is_some() => {
                    damaged.push(format!("无法读取 {}：{error}", path.display()));
                    break;
                }
                Err(error) => {
                    return Err(format!(
                        "无法读取任务成果临时状态 {}：{error}",
                        path.display()
                    ));
                }
            };
            remaining_bytes = remaining_bytes.saturating_sub(contents.len() as u64);
            match parse_data(&contents) {
                Ok(data) => {
                    let sync_result = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .and_then(|file| file.sync_all());
                    if let Err(error) = sync_result {
                        if current.is_some() {
                            damaged.push(format!("无法同步 {}：{error}", path.display()));
                            continue;
                        }
                        return Err(format!(
                            "无法同步任务成果临时状态 {}：{error}",
                            path.display()
                        ));
                    }
                    valid.push(RecoverySnapshot { path, data });
                }
                Err(StoreDataError::UnsupportedVersion(version)) if current.is_some() => {
                    damaged.push(format!("临时状态版本 {version} 不受支持"));
                }
                Err(StoreDataError::UnsupportedVersion(version)) => {
                    return Err(format!("任务成果临时状态使用了不支持的版本 {version}"));
                }
                Err(StoreDataError::Damaged(detail)) => damaged.push(detail),
            }
        }

        if valid.is_empty() {
            if require_valid_snapshot {
                return Err(format!("任务成果临时状态已损坏：{}", damaged.join("；")));
            }
            self.cleanup_temporary_files();
            return Ok(None);
        }
        let Some(RecoverySnapshot { path, data }) = select_recovery_snapshot(valid, current)?
        else {
            self.cleanup_temporary_files();
            return Ok(None);
        };

        let temporary_path = TempPath::try_from_path(path)
            .map_err(|error| format!("无法恢复任务成果临时状态：{error}"))?;
        persist_recovery_snapshot(temporary_path, &self.config_path)
            .map_err(|error| format!("无法原子恢复任务成果临时状态：{error}"))?;
        File::open(&self.config_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("无法同步恢复后的任务成果基线：{error}"))?;
        self.cleanup_temporary_files();
        sync_directory(self.parent_directory()?)
            .map_err(|error| format!("无法同步任务成果目录：{error}"))?;
        Ok(Some(data))
    }

    fn temporary_candidates(&self) -> Result<Vec<PathBuf>, String> {
        let parent = self.parent_directory()?;
        let prefix = self.temporary_prefix()?;
        let mut paths = Vec::new();
        let entries =
            fs::read_dir(parent).map_err(|error| format!("无法扫描任务成果临时状态：{error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("无法读取任务成果目录：{error}"))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(prefix.as_str()) && name.ends_with(TEMP_FILE_SUFFIX) {
                let file_type = entry
                    .file_type()
                    .map_err(|error| format!("无法读取任务成果临时状态类型：{error}"))?;
                if file_type.is_file() {
                    if paths.len() >= MAX_TEMPORARY_CANDIDATES {
                        return Err(format!(
                            "任务成果临时状态不能超过 {MAX_TEMPORARY_CANDIDATES} 个"
                        ));
                    }
                    paths.push(entry.path());
                }
            }
        }
        Ok(paths)
    }

    fn cleanup_temporary_files(&self) {
        if let Ok(paths) = self.temporary_candidates() {
            for path in paths {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn parent_directory(&self) -> Result<&Path, String> {
        self.config_path
            .parent()
            .ok_or_else(|| "任务成果基线路径无效：必须包含父目录".to_string())
    }

    fn temporary_prefix(&self) -> Result<String, String> {
        let file_name = self
            .config_path
            .file_name()
            .ok_or("任务成果基线路径无效：缺少文件名")?;
        Ok(format!(".{}.joydsh-", file_name.to_string_lossy()))
    }

    fn lock_path(&self) -> Result<PathBuf, String> {
        let file_name = self
            .config_path
            .file_name()
            .ok_or("任务成果基线路径无效：缺少文件名")?;
        let mut lock_name = file_name.to_os_string();
        lock_name.push(".lock");
        Ok(self.parent_directory()?.join(lock_name))
    }
}

#[cfg(unix)]
fn recover_completed_worktree_commit(
    workspace_path: &Path,
    journal_id: &str,
) -> Option<WorktreeCommit> {
    recover_pending_worktree_commits(workspace_path)
        .ok()?
        .into_iter()
        .find(|recovery| recovery.journal_id == journal_id)
        .and_then(|recovery| recovery.revision)
        .map(|revision| WorktreeCommit {
            revision,
            recovery_journal_id: None,
            warning: None,
        })
}

impl CapturedArtifactState {
    fn change_ids(
        &self,
        task_id: &str,
        baseline: &TaskBaseline,
        token_key: &ArtifactTokenKey,
    ) -> Vec<String> {
        self.change_tokens
            .iter()
            .map(|token| {
                let digest = hmac_sha256(token_key, |hasher| {
                    hash_snapshot_field(hasher, b"schema", b"joydsh-change-id-v1");
                    hash_snapshot_field(hasher, b"task-id", task_id.as_bytes());
                    hash_snapshot_field(
                        hasher,
                        b"baseline-captured-at",
                        &baseline.captured_at.to_be_bytes(),
                    );
                    hash_snapshot_field(
                        hasher,
                        b"repository-root",
                        baseline.repository_root.to_string_lossy().as_bytes(),
                    );
                    hash_snapshot_field(hasher, b"baseline", baseline.revision.as_bytes());
                    hash_snapshot_field(hasher, b"change-token", token.as_bytes());
                });
                format!("change-v1-{}", hex_digest(digest))
            })
            .collect()
    }
}

fn ensure_token_key(data: &mut TaskArtifactData) -> Result<(ArtifactTokenKey, bool), String> {
    if let Some(encoded) = data.token_key.as_deref() {
        return decode_token_key(encoded).map(|key| (key, false));
    }

    let mut bytes = [0u8; TOKEN_KEY_BYTES];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法生成成果令牌密钥：{error}"))?;
    data.token_key = Some(hex_digest(bytes));
    Ok((ArtifactTokenKey(bytes), true))
}

fn decode_token_key(encoded: &str) -> Result<ArtifactTokenKey, String> {
    if encoded.len() != TOKEN_KEY_BYTES * 2 {
        return Err("成果令牌密钥长度无效".into());
    }
    let mut bytes = [0u8; TOKEN_KEY_BYTES];
    for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_value(pair[0]).ok_or("成果令牌密钥格式无效")?;
        let low = hex_value(pair[1]).ok_or("成果令牌密钥格式无效")?;
        bytes[index] = (high << 4) | low;
    }
    Ok(ArtifactTokenKey(bytes))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn capture_artifact_state_with_recovery(
    workspace_path: &Path,
    baseline: &TaskBaseline,
) -> Result<CapturedArtifactState, WorktreeMutationError> {
    #[cfg(unix)]
    recover_pending_worktree_commits(workspace_path).map_err(|error| {
        WorktreeMutationError::RecoveryRequired {
            detail: format!("无法恢复未完成的成果提交：{error}"),
        }
    })?;
    #[cfg(unix)]
    recover_pending_worktree_rollbacks(workspace_path, baseline)?;

    capture_artifact_state(workspace_path, baseline)
}

fn capture_artifact_state(
    workspace_path: &Path,
    baseline: &TaskBaseline,
) -> Result<CapturedArtifactState, WorktreeMutationError> {
    let preliminary = inspect_changes_from_task_baseline(workspace_path, baseline)?;
    if preliminary.head_revision.as_deref() != Some(preliminary.baseline_revision.as_str()) {
        let actual = preliminary
            .head_revision
            .clone()
            .unwrap_or_else(|| "无提交".into());
        return blocked_artifact_state(
            workspace_path,
            baseline,
            ArtifactMutationBlockedReason::HeadAdvanced,
            format!(
                "HEAD 已偏离任务基线（期望 {}，实际 {actual}）",
                baseline.revision
            ),
            ArtifactOperationErrorCode::HeadAdvanced,
        );
    }

    let conflicts = preliminary
        .changes
        .iter()
        .filter(|change| change.status == FileStatus::Unmerged)
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    if !conflicts.is_empty() {
        return blocked_artifact_state(
            workspace_path,
            baseline,
            ArtifactMutationBlockedReason::Conflicted,
            format!("工作区存在未解决冲突：{}", conflicts.join("、")),
            ArtifactOperationErrorCode::Conflicted,
        );
    }

    #[cfg(not(unix))]
    return blocked_artifact_state(
        workspace_path,
        baseline,
        ArtifactMutationBlockedReason::Unsupported,
        format!("当前 {} 构建尚不支持安全文件回滚", std::env::consts::OS),
        ArtifactOperationErrorCode::Unsupported,
    );

    #[cfg(unix)]
    match capture_task_change_snapshots(workspace_path, baseline) {
        Ok(snapshots) => {
            let changes = snapshots
                .iter()
                .map(|snapshot| snapshot.change.clone())
                .collect::<Vec<_>>();
            let change_tokens = snapshots
                .iter()
                .map(|snapshot| snapshot.snapshot_token.clone())
                .collect();
            Ok(CapturedArtifactState {
                inspection: WorktreeInspection {
                    repository_root: baseline.repository_root.clone(),
                    baseline_revision: baseline.revision.clone(),
                    head_revision: Some(baseline.revision.clone()),
                    clean: changes.is_empty(),
                    changes,
                },
                change_tokens,
                strong_snapshots: Some(snapshots),
                mutation: ArtifactMutationAvailability::Ready,
                blocked_error_code: None,
            })
        }
        Err(error @ WorktreeMutationError::OperationInProgress { .. }) => blocked_artifact_state(
            workspace_path,
            baseline,
            ArtifactMutationBlockedReason::Unsupported,
            error.to_string(),
            ArtifactOperationErrorCode::RepositoryBusy,
        ),
        Err(error @ WorktreeMutationError::UnsupportedSafeMutation { .. }) => {
            blocked_artifact_state(
                workspace_path,
                baseline,
                ArtifactMutationBlockedReason::Unsupported,
                error.to_string(),
                ArtifactOperationErrorCode::Unsupported,
            )
        }
        Err(error @ WorktreeMutationError::RecoveryRequired { .. }) => blocked_artifact_state(
            workspace_path,
            baseline,
            ArtifactMutationBlockedReason::Unsupported,
            error.to_string(),
            ArtifactOperationErrorCode::RepositoryBusy,
        ),
        Err(error) => Err(error),
    }
}

fn blocked_artifact_state(
    workspace_path: &Path,
    baseline: &TaskBaseline,
    reason: ArtifactMutationBlockedReason,
    message: String,
    error_code: ArtifactOperationErrorCode,
) -> Result<CapturedArtifactState, WorktreeMutationError> {
    let readonly = capture_task_readonly_change_snapshots(workspace_path, baseline)?;
    if reason == ArtifactMutationBlockedReason::HeadAdvanced
        && readonly.inspection.head_revision.as_deref() == Some(baseline.revision.as_str())
    {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: "<repository-head>".into(),
        });
    }
    if reason == ArtifactMutationBlockedReason::Conflicted
        && !readonly
            .inspection
            .changes
            .iter()
            .any(|change| change.status == FileStatus::Unmerged)
    {
        return Err(WorktreeMutationError::RepositoryChangedDuringSnapshot {
            path: "<repository-conflicts>".into(),
        });
    }
    let message = match reason {
        ArtifactMutationBlockedReason::HeadAdvanced => format!(
            "HEAD 已偏离任务基线（期望 {}，实际 {}）",
            baseline.revision,
            readonly
                .inspection
                .head_revision
                .as_deref()
                .unwrap_or("无提交")
        ),
        ArtifactMutationBlockedReason::Conflicted => {
            let conflicts = readonly
                .inspection
                .changes
                .iter()
                .filter(|change| change.status == FileStatus::Unmerged)
                .map(|change| change.path.as_str())
                .collect::<Vec<_>>();
            format!("工作区存在未解决冲突：{}", conflicts.join("、"))
        }
        _ => message,
    };
    let change_tokens = readonly
        .snapshots
        .iter()
        .map(|snapshot| snapshot.snapshot_token.clone())
        .collect();
    Ok(CapturedArtifactState {
        inspection: readonly.inspection,
        change_tokens,
        strong_snapshots: None,
        mutation: ArtifactMutationAvailability::Blocked { reason, message },
        blocked_error_code: Some(error_code),
    })
}

fn reconcile_accepted_change_ids(
    data: &mut TaskArtifactData,
    task_id: &str,
    baseline: &TaskBaseline,
    token_key: &ArtifactTokenKey,
    captured: &CapturedArtifactState,
) -> (BTreeSet<String>, bool) {
    let current = data
        .accepted_change_ids
        .get(task_id)
        .cloned()
        .unwrap_or_default();
    let valid = captured
        .change_ids(task_id, baseline, token_key)
        .into_iter()
        .collect::<BTreeSet<_>>();
    let accepted = current
        .intersection(&valid)
        .cloned()
        .collect::<BTreeSet<_>>();
    let changed = accepted != current;
    if changed {
        set_accepted_change_ids(data, task_id, accepted.clone());
    }
    (accepted, changed)
}

fn set_accepted_change_ids(data: &mut TaskArtifactData, task_id: &str, accepted: BTreeSet<String>) {
    if accepted.is_empty() {
        data.accepted_change_ids.remove(task_id);
    } else {
        data.accepted_change_ids
            .insert(task_id.to_string(), accepted);
    }
}

fn build_task_artifact_inspection(
    task_id: &str,
    baseline: TaskBaseline,
    token_key: &ArtifactTokenKey,
    captured: &CapturedArtifactState,
    accepted: &BTreeSet<String>,
) -> Result<TaskArtifactInspection, String> {
    if captured.inspection.changes.len() != captured.change_tokens.len() {
        return Err("成果快照中的文件变更与令牌数量不一致".into());
    }
    let change_ids = captured.change_ids(task_id, &baseline, token_key);
    let snapshot_token = artifact_snapshot_token(
        task_id,
        &baseline,
        token_key,
        captured,
        accepted,
        &change_ids,
    );
    let changes = captured
        .inspection
        .changes
        .iter()
        .zip(change_ids)
        .map(|(change, change_id)| TaskArtifactFileChange {
            review: if accepted.contains(&change_id) {
                ArtifactReviewState::Accepted
            } else {
                ArtifactReviewState::Pending
            },
            change_id,
            path: change.path.clone(),
            previous_path: change.previous_path.clone(),
            status: change.status,
            similarity: change.similarity,
            diff: change.diff.clone(),
        })
        .collect();
    Ok(TaskArtifactInspection {
        baseline,
        snapshot_token,
        mutation: captured.mutation.clone(),
        inspection: TaskArtifactWorktreeInspection {
            repository_root: captured.inspection.repository_root.clone(),
            baseline_revision: captured.inspection.baseline_revision.clone(),
            head_revision: captured.inspection.head_revision.clone(),
            clean: captured.inspection.clean,
            changes,
        },
    })
}

fn artifact_snapshot_token(
    task_id: &str,
    baseline: &TaskBaseline,
    token_key: &ArtifactTokenKey,
    captured: &CapturedArtifactState,
    accepted: &BTreeSet<String>,
    change_ids: &[String],
) -> String {
    let digest = hmac_sha256(token_key, |hasher| {
        hash_snapshot_field(hasher, b"schema", b"joydsh-task-artifact-snapshot-v1");
        hash_snapshot_field(hasher, b"task-id", task_id.as_bytes());
        hash_snapshot_field(
            hasher,
            b"repository-root",
            baseline.repository_root.to_string_lossy().as_bytes(),
        );
        hash_snapshot_field(hasher, b"baseline", baseline.revision.as_bytes());
        hash_snapshot_field(
            hasher,
            b"baseline-captured-at",
            &baseline.captured_at.to_be_bytes(),
        );
        hash_snapshot_field(
            hasher,
            b"inspection-baseline",
            captured.inspection.baseline_revision.as_bytes(),
        );
        hash_snapshot_field(
            hasher,
            b"head",
            captured
                .inspection
                .head_revision
                .as_deref()
                .unwrap_or("<no-head>")
                .as_bytes(),
        );
        hash_snapshot_field(
            hasher,
            b"change-count",
            &(change_ids.len() as u64).to_be_bytes(),
        );
        hash_mutation_availability(hasher, &captured.mutation);
        for (index, (change_id, change_token)) in
            change_ids.iter().zip(&captured.change_tokens).enumerate()
        {
            hash_snapshot_field(hasher, b"index", &(index as u64).to_be_bytes());
            hash_snapshot_field(hasher, b"change-id", change_id.as_bytes());
            hash_snapshot_field(hasher, b"change-token", change_token.as_bytes());
            hash_snapshot_field(
                hasher,
                b"review",
                if accepted.contains(change_id) {
                    b"accepted"
                } else {
                    b"pending"
                },
            );
        }
    });
    format!("snapshot-v1-{}", hex_digest(digest))
}

fn hash_mutation_availability(hasher: &mut Sha256, mutation: &ArtifactMutationAvailability) {
    match mutation {
        ArtifactMutationAvailability::Ready => {
            hash_snapshot_field(hasher, b"mutation-availability", b"ready");
        }
        ArtifactMutationAvailability::Blocked { reason, message } => {
            hash_snapshot_field(hasher, b"mutation-availability", b"blocked");
            let reason = match reason {
                ArtifactMutationBlockedReason::TaskRunning => b"task-running".as_slice(),
                ArtifactMutationBlockedReason::HeadAdvanced => b"head-advanced".as_slice(),
                ArtifactMutationBlockedReason::Conflicted => b"conflicted".as_slice(),
                ArtifactMutationBlockedReason::Unsupported => b"unsupported".as_slice(),
            };
            hash_snapshot_field(hasher, b"mutation-reason", reason);
            hash_snapshot_field(hasher, b"mutation-message", message.as_bytes());
        }
    }
}

fn hmac_sha256(token_key: &ArtifactTokenKey, update: impl FnOnce(&mut Sha256)) -> [u8; 32] {
    const BLOCK_BYTES: usize = 64;
    let mut inner_pad = [0x36; BLOCK_BYTES];
    let mut outer_pad = [0x5c; BLOCK_BYTES];
    for (index, byte) in token_key.0.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    update(&mut inner);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn hash_snapshot_field(hasher: &mut Sha256, name: &[u8], value: &[u8]) {
    hasher.update((name.len() as u64).to_be_bytes());
    hasher.update(name);
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    for (left, right) in left.iter().zip(right) {
        difference |= usize::from(left ^ right);
    }
    difference == 0
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let bytes = digest.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn mutation_blocked_message(mutation: &ArtifactMutationAvailability) -> String {
    match mutation {
        ArtifactMutationAvailability::Ready => "成果操作当前可用".into(),
        ArtifactMutationAvailability::Blocked { message, .. } => message.clone(),
    }
}

fn classify_worktree_operation_error(
    error: &WorktreeMutationError,
) -> (ArtifactOperationErrorCode, String) {
    let code = match error {
        WorktreeMutationError::HeadChanged { .. } => ArtifactOperationErrorCode::HeadAdvanced,
        WorktreeMutationError::UnmergedChanges { .. } => ArtifactOperationErrorCode::Conflicted,
        WorktreeMutationError::OperationInProgress { .. } => {
            ArtifactOperationErrorCode::RepositoryBusy
        }
        WorktreeMutationError::ExpectedChangeMissing { .. } => {
            ArtifactOperationErrorCode::ChangeNotFound
        }
        WorktreeMutationError::ExpectedChangeChanged { .. }
        | WorktreeMutationError::RepositoryChangedDuringSnapshot { .. }
        | WorktreeMutationError::UnexpectedOccupant { .. } => {
            ArtifactOperationErrorCode::StaleSnapshot
        }
        WorktreeMutationError::RecoveryRequired { .. } => {
            ArtifactOperationErrorCode::RepositoryBusy
        }
        WorktreeMutationError::UnsupportedSafeMutation { .. } => {
            ArtifactOperationErrorCode::Unsupported
        }
        _ => ArtifactOperationErrorCode::OperationFailed,
    };
    (code, error.to_string())
}

fn classify_worktree_commit_error(
    error: &WorktreeCommitError,
) -> (ArtifactOperationErrorCode, String) {
    let code = match error {
        WorktreeCommitError::HeadChanged { .. } => ArtifactOperationErrorCode::HeadAdvanced,
        WorktreeCommitError::UnmergedChanges { .. } => ArtifactOperationErrorCode::Conflicted,
        WorktreeCommitError::RepositoryBusy { .. }
        | WorktreeCommitError::OperationInProgress { .. }
        | WorktreeCommitError::RecoveryRequired { .. } => {
            ArtifactOperationErrorCode::RepositoryBusy
        }
        WorktreeCommitError::BranchChanged
        | WorktreeCommitError::IndexChanged
        | WorktreeCommitError::ExpectedChangeChanged { .. } => {
            ArtifactOperationErrorCode::StaleSnapshot
        }
        WorktreeCommitError::EmptySelection | WorktreeCommitError::NothingToCommit => {
            ArtifactOperationErrorCode::NothingToCommit
        }
        WorktreeCommitError::UnsupportedPlatform { .. }
        | WorktreeCommitError::UnsupportedFileType { .. } => {
            ArtifactOperationErrorCode::Unsupported
        }
        _ => ArtifactOperationErrorCode::OperationFailed,
    };
    (code, error.to_string())
}

#[cfg(not(windows))]
fn persist_new_snapshot(temporary: NamedTempFile, target: &Path) -> io::Result<File> {
    match temporary.persist(target) {
        Ok(file) => Ok(file),
        Err(error) => {
            let tempfile::PersistError { error, file } = error;
            let _ = file.close();
            Err(error)
        }
    }
}

#[cfg(windows)]
fn persist_new_snapshot(temporary: NamedTempFile, target: &Path) -> io::Result<File> {
    let (file, temporary_path) = temporary.into_parts();
    drop(file);
    persist_windows_snapshot(temporary_path, target, false)?;
    OpenOptions::new().read(true).write(true).open(target)
}

#[cfg(not(windows))]
fn persist_recovery_snapshot(temporary_path: TempPath, target: &Path) -> io::Result<()> {
    match temporary_path.persist(target) {
        Ok(()) => Ok(()),
        Err(error) => {
            let tempfile::PathPersistError { error, path } = error;
            let _ = path.keep();
            Err(error)
        }
    }
}

#[cfg(windows)]
fn persist_recovery_snapshot(temporary_path: TempPath, target: &Path) -> io::Result<()> {
    persist_windows_snapshot(temporary_path, target, true)
}

#[cfg(windows)]
fn persist_windows_snapshot(
    mut temporary_path: TempPath,
    target: &Path,
    preserve_on_failure: bool,
) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH,
    };

    let source = temporary_path
        .as_ref()
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        if SetFileAttributesW(source.as_ptr(), FILE_ATTRIBUTE_NORMAL) == 0 {
            0
        } else {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        let error = io::Error::last_os_error();
        if preserve_on_failure {
            let _ = temporary_path.keep();
        } else {
            let _ = temporary_path.close();
        }
        return Err(error);
    }

    temporary_path.disable_cleanup(true);
    Ok(())
}

fn parse_data(contents: &[u8]) -> Result<TaskArtifactData, StoreDataError> {
    let header = serde_json::from_slice::<TaskArtifactHeader>(contents)
        .map_err(|error| StoreDataError::Damaged(error.to_string()))?;
    if header.version != STORE_VERSION {
        return Err(StoreDataError::UnsupportedVersion(header.version));
    }
    let data = serde_json::from_slice::<TaskArtifactData>(contents)
        .map_err(|error| StoreDataError::Damaged(error.to_string()))?;
    validate_data(&data).map_err(StoreDataError::Damaged)?;
    Ok(data)
}

fn read_bounded_file(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let declared_bytes = file.metadata()?.len();
    if declared_bytes > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("文件大小 {declared_bytes} 字节超过读取上限 {max_bytes} 字节"),
        ));
    }

    let read_limit = max_bytes.saturating_add(1);
    let mut contents = Vec::with_capacity(declared_bytes.min(max_bytes) as usize);
    Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut contents)?;
    if contents.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("文件在读取期间超过读取上限 {max_bytes} 字节"),
        ));
    }
    Ok(contents)
}

fn select_recovery_snapshot(
    mut snapshots: Vec<RecoverySnapshot>,
    current: Option<&TaskArtifactData>,
) -> Result<Option<RecoverySnapshot>, String> {
    if let Some(current) = current {
        snapshots.retain(|snapshot| snapshot.data.generation >= current.generation);
    }
    if snapshots.is_empty() {
        return Ok(None);
    }
    snapshots.sort_by(|left, right| {
        left.data
            .generation
            .cmp(&right.data.generation)
            .then_with(|| left.path.cmp(&right.path))
    });

    let mut previous_candidate: Option<usize> = None;
    let mut group_start = 0;
    while group_start < snapshots.len() {
        let generation = snapshots[group_start].data.generation;
        let mut group_end = group_start + 1;
        while group_end < snapshots.len() && snapshots[group_end].data.generation == generation {
            if snapshots[group_end].data != snapshots[group_start].data {
                return Err(format!(
                    "任务成果临时状态在 generation {generation} 出现分叉"
                ));
            }
            group_end += 1;
        }

        let previous = previous_candidate
            .map(|index| &snapshots[index].data)
            .or(current);
        if let Some(previous) = previous {
            if generation == previous.generation {
                if snapshots[group_start].data != *previous {
                    return Err(format!(
                        "任务成果临时状态在 generation {generation} 与正式状态分叉"
                    ));
                }
            } else if !is_baseline_superset(&snapshots[group_start].data, previous) {
                return Err(format!(
                    "任务成果临时状态 generation {generation} 会倒退已有任务基线"
                ));
            }
        }
        previous_candidate = Some(group_start);
        group_start = group_end;
    }

    let selected_index = snapshots.len() - 1;
    if current
        .is_some_and(|current| snapshots[selected_index].data.generation == current.generation)
    {
        return Ok(None);
    }
    Ok(Some(snapshots.swap_remove(selected_index)))
}

fn is_baseline_superset(candidate: &TaskArtifactData, current: &TaskArtifactData) -> bool {
    current
        .token_key
        .as_ref()
        .is_none_or(|token_key| candidate.token_key.as_ref() == Some(token_key))
        && candidate.baselines.len() >= current.baselines.len()
        && current
            .baselines
            .iter()
            .all(|(task_id, baseline)| candidate.baselines.get(task_id) == Some(baseline))
}

fn validate_data(data: &TaskArtifactData) -> Result<(), String> {
    if let Some(token_key) = data.token_key.as_deref() {
        decode_token_key(token_key).map_err(|error| format!("成果令牌密钥无效：{error}"))?;
    }
    if data.baselines.len() > MAX_BASELINES {
        return Err(format!("任务成果基线不能超过 {MAX_BASELINES} 个"));
    }
    let mut total_task_id_bytes = 0usize;
    for (task_id, baseline) in &data.baselines {
        validate_task_id(task_id).map_err(|error| format!("{error}：{task_id:?}"))?;
        total_task_id_bytes = total_task_id_bytes
            .checked_add(task_id.len())
            .ok_or("任务 ID 总字节数超出范围")?;
        if total_task_id_bytes > MAX_TOTAL_TASK_ID_BYTES {
            return Err(format!(
                "任务 ID 总字节数不能超过 {MAX_TOTAL_TASK_ID_BYTES}"
            ));
        }
        if baseline.captured_at == 0 || baseline.captured_at > MAX_CAPTURED_AT_MS {
            return Err(format!(
                "任务 {task_id:?} 的 capturedAt 超出有效范围：{}",
                baseline.captured_at
            ));
        }
    }

    let mut total_accepted = 0usize;
    for (task_id, change_ids) in &data.accepted_change_ids {
        validate_task_id(task_id).map_err(|error| format!("{error}：{task_id:?}"))?;
        if !data.baselines.contains_key(task_id) {
            return Err(format!("任务 {task_id:?} 的评审状态没有对应的成果基线"));
        }
        validate_change_ids(change_ids)?;
        total_accepted = total_accepted
            .checked_add(change_ids.len())
            .ok_or("已接受变更 ID 总数超出范围")?;
        if total_accepted > MAX_TOTAL_ACCEPTED_CHANGE_IDS {
            return Err(format!(
                "已接受变更 ID 总数不能超过 {MAX_TOTAL_ACCEPTED_CHANGE_IDS}"
            ));
        }
    }
    Ok(())
}

fn normalize_change_ids(change_ids: Vec<String>) -> Result<BTreeSet<String>, String> {
    if change_ids.len() > MAX_ACCEPTED_CHANGE_IDS_PER_TASK {
        return Err(format!(
            "单个任务最多接受 {MAX_ACCEPTED_CHANGE_IDS_PER_TASK} 个变更"
        ));
    }
    for change_id in &change_ids {
        validate_change_id(change_id)?;
    }
    Ok(change_ids.into_iter().collect())
}

fn validate_change_ids(change_ids: &BTreeSet<String>) -> Result<(), String> {
    if change_ids.len() > MAX_ACCEPTED_CHANGE_IDS_PER_TASK {
        return Err(format!(
            "单个任务最多接受 {MAX_ACCEPTED_CHANGE_IDS_PER_TASK} 个变更"
        ));
    }
    for change_id in change_ids {
        validate_change_id(change_id)?;
    }
    Ok(())
}

fn validate_change_id(change_id: &str) -> Result<(), String> {
    let mut bytes = change_id.bytes();
    let first = bytes.next().ok_or("变更 ID 无效")?;
    if change_id.len() > MAX_CHANGE_ID_BYTES
        || !first.is_ascii_alphanumeric()
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("变更 ID 无效".into());
    }
    Ok(())
}

fn validate_task_id(task_id: &str) -> Result<(), String> {
    if task_id.is_empty() || task_id.len() > 512 || task_id.chars().any(char::is_control) {
        return Err("任务 ID 无效".into());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::recover_completed_worktree_commit;
    use super::{
        ensure_token_key, validate_data, ArtifactFileReviewAction, ArtifactMutationAvailability,
        ArtifactMutationBlockedReason, ArtifactOperationErrorCode, ArtifactReviewState,
        TaskArtifactData, TaskArtifactStore, MAX_ACCEPTED_CHANGE_IDS_PER_TASK, MAX_BASELINES,
        MAX_CAPTURED_AT_MS, MAX_CHANGE_ID_BYTES, MAX_STORE_BYTES, MAX_TEMPORARY_CANDIDATES,
        MAX_TOTAL_TASK_ID_BYTES, TEMP_FILE_SUFFIX,
    };
    use crate::worktree::{FileDiff, TaskBaseline};
    use crate::worktree_commits::WorktreeCommitError;
    #[cfg(unix)]
    use crate::worktree_commits::{commit_accepted_changes_with_faults, CommitFaults};
    use serde_json::Value;
    use std::{
        collections::BTreeSet,
        fs,
        io::Write,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Barrier,
        },
        thread,
        time::Duration,
    };
    use tempfile::Builder as TempFileBuilder;

    static TEST_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = TEST_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("joydsh-task-artifacts-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn persists_a_baseline_and_inspects_only_later_changes() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());

        let baseline = store
            .ensure_baseline("task-1", &repository)
            .expect("baseline should be captured");
        fs::write(repository.join("created.txt"), "task output\n").unwrap();

        let restored = TaskArtifactStore::new(store_path);
        assert_eq!(restored.baseline("task-1").unwrap(), Some(baseline.clone()));
        let result = restored.inspect("task-1", &repository).unwrap();
        assert_eq!(result.baseline, baseline);
        assert_eq!(result.inspection.changes.len(), 1);
        assert_eq!(result.inspection.changes[0].path, "created.txt");
        assert_eq!(
            result.inspection.changes[0].review,
            super::ArtifactReviewState::Pending
        );
    }

    #[test]
    fn keeps_strong_change_and_snapshot_tokens_stable_across_restarts() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "after\n").unwrap();

        let first = store.inspect("task-1", &repository).unwrap();
        assert!(first.snapshot_token.starts_with("snapshot-v1-"));
        assert_eq!(first.inspection.changes.len(), 1);
        assert!(first.inspection.changes[0]
            .change_id
            .starts_with("change-v1-"));
        assert_eq!(
            first.inspection.changes[0].review,
            ArtifactReviewState::Pending
        );
        let encoded = serde_json::to_value(&first).unwrap();
        assert_eq!(encoded["mutation"]["availability"], "ready");
        assert_eq!(encoded["inspection"]["changes"][0]["review"], "pending");
        assert!(encoded.get("acceptedChangeIds").is_none());
        assert!(encoded.get("tokenKey").is_none());

        let restored = TaskArtifactStore::new(store_path);
        let second = restored.inspect("task-1", &repository).unwrap();
        assert_eq!(second.snapshot_token, first.snapshot_token);
        assert_eq!(
            second.inspection.changes[0].change_id,
            first.inspection.changes[0].change_id
        );
        assert_eq!(second.mutation, ArtifactMutationAvailability::Ready);
    }

    #[test]
    fn runtime_mutation_block_is_bound_to_the_snapshot_token() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "task output\n").unwrap();

        let ready = store.inspect("task-1", &repository).unwrap();
        let blocked = store
            .inspect_with_mutation_block(
                "task-1",
                &repository,
                ArtifactMutationBlockedReason::TaskRunning,
                "任务仍在运行，成果暂时只读".into(),
            )
            .unwrap();
        let blocked_after_restart = TaskArtifactStore::new(store_path)
            .inspect_with_mutation_block(
                "task-1",
                &repository,
                ArtifactMutationBlockedReason::TaskRunning,
                "任务仍在运行，成果暂时只读".into(),
            )
            .unwrap();

        assert_ne!(blocked.snapshot_token, ready.snapshot_token);
        assert_eq!(blocked_after_restart.snapshot_token, blocked.snapshot_token);
        assert!(matches!(
            blocked.mutation,
            ArtifactMutationAvailability::Blocked {
                reason: ArtifactMutationBlockedReason::TaskRunning,
                ..
            }
        ));
    }

    #[test]
    fn blocked_inspection_is_readonly_but_idle_inspection_recovers_before_capture() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "partially restored\n").unwrap();
        fs::write(repository.join("remaining.txt"), "latest output\n").unwrap();
        let persisted_before = fs::read(&store_path).unwrap();
        let recovery_calls = AtomicU64::new(0);

        let blocked = store
            .inspect_with_capture_recovery(
                "task-1",
                &repository,
                Some((
                    ArtifactMutationBlockedReason::TaskRunning,
                    "任务仍在运行，成果暂时只读".into(),
                )),
                |workspace_path, baseline| {
                    recovery_calls.fetch_add(1, Ordering::Relaxed);
                    fs::write(workspace_path.join("tracked.txt"), "before\n").unwrap();
                    super::capture_artifact_state(workspace_path, baseline)
                },
            )
            .unwrap();

        assert_eq!(recovery_calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "partially restored\n"
        );
        assert_eq!(fs::read(&store_path).unwrap(), persisted_before);
        assert_eq!(blocked.inspection.changes.len(), 2);
        assert!(matches!(
            blocked.mutation,
            ArtifactMutationAvailability::Blocked {
                reason: ArtifactMutationBlockedReason::TaskRunning,
                ..
            }
        ));

        let recovered = store
            .inspect_with_capture_recovery(
                "task-1",
                &repository,
                None,
                |workspace_path, baseline| {
                    recovery_calls.fetch_add(1, Ordering::Relaxed);
                    fs::write(workspace_path.join("tracked.txt"), "before\n").unwrap();
                    super::capture_artifact_state(workspace_path, baseline)
                },
            )
            .unwrap();

        assert_eq!(recovery_calls.load(Ordering::Relaxed), 1);
        assert_eq!(recovered.mutation, ArtifactMutationAvailability::Ready);
        assert_eq!(
            recovered.inspection.head_revision.as_deref(),
            Some(recovered.baseline.revision.as_str())
        );
        assert_eq!(recovered.inspection.changes.len(), 1);
        assert_eq!(recovered.inspection.changes[0].path, "remaining.txt");
        assert!(matches!(
            &recovered.inspection.changes[0].diff,
            FileDiff::Text {
                additions: 1,
                deletions: 0,
                ..
            }
        ));
        assert!(recovered.snapshot_token.starts_with("snapshot-v1-"));
    }

    #[test]
    fn temporary_git_busy_preserves_acceptance_until_content_changes() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "accepted content\n").unwrap();

        let pending = store.inspect("task-1", &repository).unwrap();
        let accepted = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &pending.inspection.changes[0].change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap()
            .latest_snapshot;
        let accepted_change_id = accepted.inspection.changes[0].change_id.clone();
        let revision = git_output(&repository, ["rev-parse", "HEAD"]);
        fs::write(repository.join(".git/MERGE_HEAD"), format!("{revision}\n")).unwrap();

        let blocked = store.inspect("task-1", &repository).unwrap();
        assert_ne!(blocked.snapshot_token, accepted.snapshot_token);
        assert_eq!(blocked.inspection.changes[0].change_id, accepted_change_id);
        assert_eq!(
            blocked.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );

        fs::write(repository.join("tracked.txt"), b"changed\0binary\n").unwrap();
        let changed = store.inspect("task-1", &repository).unwrap();
        assert_ne!(changed.snapshot_token, blocked.snapshot_token);
        assert_ne!(changed.inspection.changes[0].change_id, accepted_change_id);
        assert_eq!(
            changed.inspection.changes[0].review,
            ArtifactReviewState::Pending
        );
    }

    #[test]
    fn binds_change_and_snapshot_tokens_to_the_task_and_store_secret() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        store.ensure_baseline("task-2", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "edited\n").unwrap();

        let first_task = store.inspect("task-1", &repository).unwrap();
        let second_task = store.inspect("task-2", &repository).unwrap();
        assert_ne!(first_task.snapshot_token, second_task.snapshot_token);
        assert_ne!(
            first_task.inspection.changes[0].change_id,
            second_task.inspection.changes[0].change_id
        );

        let persisted: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        let key = persisted["tokenKey"].as_str().unwrap();
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));

        let other_store_path = temporary.0.join("other-task-artifacts.json");
        let mut other_store_data = persisted;
        other_store_data["tokenKey"] = Value::String("00".repeat(32));
        fs::write(
            &other_store_path,
            serde_json::to_vec(&other_store_data).unwrap(),
        )
        .unwrap();
        let other_store = TaskArtifactStore::new(other_store_path);
        let other_secret = other_store.inspect("task-1", &repository).unwrap();
        assert_ne!(other_secret.snapshot_token, first_task.snapshot_token);
        assert_ne!(
            other_secret.inspection.changes[0].change_id,
            first_task.inspection.changes[0].change_id
        );
    }

    #[test]
    fn migrates_a_missing_token_key_once_and_rejects_an_invalid_key() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();

        let mut old_schema: Value =
            serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        old_schema.as_object_mut().unwrap().remove("tokenKey");
        fs::write(&store_path, serde_json::to_vec(&old_schema).unwrap()).unwrap();
        let before_generation = old_schema["generation"].as_u64().unwrap();

        let first = store.inspect("task-1", &repository).unwrap();
        let migrated: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        assert_eq!(migrated["generation"], before_generation + 1);
        assert_eq!(migrated["tokenKey"].as_str().unwrap().len(), 64);
        let second = store.inspect("task-1", &repository).unwrap();
        assert_eq!(second.snapshot_token, first.snapshot_token);
        let unchanged: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        assert_eq!(unchanged["generation"], migrated["generation"]);

        let mut invalid = unchanged;
        invalid["tokenKey"] = Value::String("not-a-valid-key".into());
        fs::write(&store_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(store
            .inspect("task-1", &repository)
            .unwrap_err()
            .contains("成果令牌密钥无效"));
    }

    #[test]
    fn keeps_durable_acceptance_while_git_is_temporarily_busy() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "edited\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        let change_id = pending.inspection.changes[0].change_id.clone();
        let accepted = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        assert_eq!(
            accepted.latest_snapshot.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );

        let revision = git_output(&repository, ["rev-parse", "HEAD"]);
        fs::write(repository.join(".git/MERGE_HEAD"), format!("{revision}\n")).unwrap();
        let blocked = store.inspect("task-1", &repository).unwrap();
        assert_eq!(blocked.inspection.changes[0].change_id, change_id);
        assert_eq!(
            blocked.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );
        assert!(store.load_locked().unwrap().accepted_change_ids["task-1"].contains(&change_id));

        fs::remove_file(repository.join(".git/MERGE_HEAD")).unwrap();
        let ready = store.inspect("task-1", &repository).unwrap();
        assert_eq!(ready.inspection.changes[0].change_id, change_id);
        assert_eq!(
            ready.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );
    }

    #[test]
    fn write_ahead_crash_keeps_an_identical_index_only_change_pending() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "staged only\n").unwrap();
        git(&repository, ["add", "tracked.txt"]);
        fs::write(repository.join("tracked.txt"), "before\n").unwrap();

        let pending = store.inspect("task-1", &repository).unwrap();
        let change_id = pending.inspection.changes[0].change_id.clone();
        let accepted = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        assert_eq!(
            accepted.latest_snapshot.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );

        // Simulate process exit immediately after the durable pre-mutation write.
        store
            .with_store_lock(|| {
                let mut data = store.load_locked()?;
                store.save_pending_before_mutation_locked(&mut data, "task-1", &BTreeSet::new())
            })
            .unwrap();
        let restored = TaskArtifactStore::new(store_path);
        let after_crash = restored.inspect("task-1", &repository).unwrap();
        assert_eq!(after_crash.inspection.changes[0].change_id, change_id);
        assert_eq!(
            after_crash.inspection.changes[0].review,
            ArtifactReviewState::Pending
        );
        assert!(!restored
            .load_locked()
            .unwrap()
            .accepted_change_ids
            .contains_key("task-1"));
    }

    #[test]
    fn accepts_a_file_and_resets_review_when_its_content_changes() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "first edit\n").unwrap();

        let pending = store.inspect("task-1", &repository).unwrap();
        let original_change_id = pending.inspection.changes[0].change_id.clone();
        let accepted = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &original_change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        assert_eq!(
            accepted.affected_change_ids,
            vec![original_change_id.clone()]
        );
        assert_eq!(
            accepted.latest_snapshot.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );
        assert_ne!(
            accepted.latest_snapshot.snapshot_token,
            pending.snapshot_token
        );

        let restored = TaskArtifactStore::new(store_path);
        let still_accepted = restored.inspect("task-1", &repository).unwrap();
        assert_eq!(
            still_accepted.inspection.changes[0].review,
            ArtifactReviewState::Accepted
        );
        fs::write(repository.join("tracked.txt"), "second edit\n").unwrap();
        let changed = restored.inspect("task-1", &repository).unwrap();
        assert_ne!(changed.inspection.changes[0].change_id, original_change_id);
        assert_eq!(
            changed.inspection.changes[0].review,
            ArtifactReviewState::Pending
        );
        assert!(!restored
            .load_locked()
            .unwrap()
            .accepted_change_ids
            .contains_key("task-1"));
    }

    #[test]
    fn rejects_a_stale_review_with_the_latest_strong_snapshot() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "first edit\n").unwrap();
        let stale = store.inspect("task-1", &repository).unwrap();
        let stale_change_id = stale.inspection.changes[0].change_id.clone();

        fs::write(repository.join("tracked.txt"), "newer edit\n").unwrap();
        let error = store
            .review_file(
                "task-1",
                &repository,
                &stale.snapshot_token,
                &stale_change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap_err();
        assert_eq!(error.code, ArtifactOperationErrorCode::StaleSnapshot);
        let latest = error
            .latest_snapshot
            .expect("stale errors need a refresh snapshot");
        assert_ne!(latest.snapshot_token, stale.snapshot_token);
        assert_ne!(latest.inspection.changes[0].change_id, stale_change_id);
        assert_eq!(
            latest.inspection.changes[0].review,
            ArtifactReviewState::Pending
        );
    }

    #[test]
    fn rejects_one_file_without_touching_other_task_changes() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "edited\n").unwrap();
        fs::write(repository.join("created.txt"), "created\n").unwrap();
        let snapshot = store.inspect("task-1", &repository).unwrap();
        let tracked_change_id = snapshot
            .inspection
            .changes
            .iter()
            .find(|change| change.path == "tracked.txt")
            .unwrap()
            .change_id
            .clone();

        let rejected = store
            .review_file(
                "task-1",
                &repository,
                &snapshot.snapshot_token,
                &tracked_change_id,
                ArtifactFileReviewAction::Reject,
            )
            .unwrap();
        assert_eq!(rejected.affected_change_ids, vec![tracked_change_id]);
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(repository.join("created.txt")).unwrap(),
            "created\n"
        );
        assert_eq!(rejected.latest_snapshot.inspection.changes.len(), 1);
        assert_eq!(
            rejected.latest_snapshot.inspection.changes[0].path,
            "created.txt"
        );
    }

    #[test]
    fn rolls_back_the_exact_snapshot_and_clears_reviews() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "edited\n").unwrap();
        fs::write(repository.join("created.txt"), "created\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        let accepted_change_id = pending.inspection.changes[0].change_id.clone();
        let accepted = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &accepted_change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();

        let rolled_back = store
            .rollback(
                "task-1",
                &repository,
                &accepted.latest_snapshot.snapshot_token,
            )
            .unwrap();
        assert_eq!(rolled_back.affected_change_ids.len(), 2);
        assert!(rolled_back.latest_snapshot.inspection.clean);
        assert!(rolled_back.latest_snapshot.inspection.changes.is_empty());
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "before\n"
        );
        assert!(!repository.join("created.txt").exists());
        assert!(!store
            .load_locked()
            .unwrap()
            .accepted_change_ids
            .contains_key("task-1"));
    }

    #[test]
    fn commit_bridge_commits_only_accepted_changes() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        let baseline_revision = git_output(&repository, ["rev-parse", "HEAD"]);

        fs::write(repository.join("tracked.txt"), "accepted edit\n").unwrap();
        fs::write(repository.join("pending.txt"), "not accepted\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        let accepted_change_id = pending
            .inspection
            .changes
            .iter()
            .find(|change| change.path == "tracked.txt")
            .unwrap()
            .change_id
            .clone();
        let reviewed = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &accepted_change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        let prepared = store
            .prepare_commit(
                "task-1",
                &repository,
                &reviewed.latest_snapshot.snapshot_token,
            )
            .unwrap();

        assert_eq!(prepared.accepted_change_ids, [accepted_change_id]);
        assert_eq!(prepared.accepted_paths.len(), 1);
        assert_eq!(prepared.accepted_paths[0].path, "tracked.txt");
        let committed = store
            .commit_prepared(
                "task-1",
                &repository,
                &prepared.snapshot_token,
                &prepared.accepted_change_ids,
                "feat: commit accepted result",
            )
            .unwrap();

        assert_ne!(committed.revision, baseline_revision);
        assert_eq!(
            git_output(&repository, ["show", "HEAD:tracked.txt"]),
            "accepted edit"
        );
        assert!(
            !git_output(&repository, ["ls-tree", "-r", "--name-only", "HEAD"])
                .lines()
                .any(|path| path == "pending.txt")
        );
        assert_eq!(
            fs::read_to_string(repository.join("pending.txt")).unwrap(),
            "not accepted\n"
        );
        assert!(git_output(
            &repository,
            ["status", "--porcelain", "--untracked-files=all"]
        )
        .lines()
        .any(|line| line == "?? pending.txt"));
    }

    #[test]
    fn commit_bridge_rejects_a_stale_snapshot_before_updating_head() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        let baseline_revision = git_output(&repository, ["rev-parse", "HEAD"]);

        fs::write(repository.join("tracked.txt"), "reviewed edit\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        let reviewed = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &pending.inspection.changes[0].change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        let prepared = store
            .prepare_commit(
                "task-1",
                &repository,
                &reviewed.latest_snapshot.snapshot_token,
            )
            .unwrap();
        fs::write(repository.join("tracked.txt"), "newer edit\n").unwrap();

        let error = store
            .commit_prepared(
                "task-1",
                &repository,
                &prepared.snapshot_token,
                &prepared.accepted_change_ids,
                "fix: stale result",
            )
            .unwrap_err();

        assert_eq!(error.code, ArtifactOperationErrorCode::StaleSnapshot);
        assert!(error.latest_snapshot.is_some());
        assert_eq!(
            git_output(&repository, ["rev-parse", "HEAD"]),
            baseline_revision
        );
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "newer edit\n"
        );
    }

    #[test]
    fn commit_error_refreshes_the_snapshot_and_reconciles_review_state() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();

        fs::write(repository.join("tracked.txt"), "reviewed edit\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        let reviewed = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &pending.inspection.changes[0].change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        let prepared = store
            .prepare_commit(
                "task-1",
                &repository,
                &reviewed.latest_snapshot.snapshot_token,
            )
            .unwrap();
        fs::write(repository.join("tracked.txt"), "changed during commit\n").unwrap();

        let error = store
            .with_store_lock(|| {
                let mut data = store.load_locked()?;
                let (token_key, token_key_created) = ensure_token_key(&mut data)?;
                assert!(!token_key_created);
                Ok::<_, String>(store.worktree_commit_error_locked(
                    "task-1",
                    &repository,
                    &prepared.baseline,
                    &token_key,
                    &mut data,
                    WorktreeCommitError::ExpectedChangeChanged {
                        path: "tracked.txt".into(),
                    },
                ))
            })
            .unwrap();

        assert_eq!(error.code, ArtifactOperationErrorCode::StaleSnapshot);
        let latest = error.latest_snapshot.unwrap();
        assert_ne!(
            latest.snapshot_token,
            prepared.latest_snapshot.snapshot_token
        );
        assert_eq!(
            latest.inspection.changes[0].review,
            ArtifactReviewState::Pending
        );
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "changed during commit\n"
        );
    }

    #[test]
    fn commit_bridge_commits_an_accepted_index_only_change() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();

        fs::write(repository.join("tracked.txt"), "staged result\n").unwrap();
        git(&repository, ["add", "tracked.txt"]);
        fs::write(repository.join("tracked.txt"), "before\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        assert_eq!(pending.inspection.changes.len(), 1);
        let reviewed = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &pending.inspection.changes[0].change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        let prepared = store
            .prepare_commit(
                "task-1",
                &repository,
                &reviewed.latest_snapshot.snapshot_token,
            )
            .unwrap();

        store
            .commit_prepared(
                "task-1",
                &repository,
                &prepared.snapshot_token,
                &prepared.accepted_change_ids,
                "feat: commit staged result",
            )
            .unwrap();

        assert_eq!(
            git_output(&repository, ["show", "HEAD:tracked.txt"]),
            "staged result"
        );
        assert_eq!(
            fs::read_to_string(repository.join("tracked.txt")).unwrap(),
            "before\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn recovered_ref_publication_is_reported_as_a_successful_commit() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();

        fs::write(repository.join("tracked.txt"), "accepted edit\n").unwrap();
        let pending = store.inspect("task-1", &repository).unwrap();
        let reviewed = store
            .review_file(
                "task-1",
                &repository,
                &pending.snapshot_token,
                &pending.inspection.changes[0].change_id,
                ArtifactFileReviewAction::Accept,
            )
            .unwrap();
        let prepared = store
            .prepare_commit(
                "task-1",
                &repository,
                &reviewed.latest_snapshot.snapshot_token,
            )
            .unwrap();
        let error = commit_accepted_changes_with_faults(
            &repository,
            &prepared.baseline,
            &prepared.accepted_paths,
            "feat: recover completed commit",
            CommitFaults {
                stop_after_ref_update: true,
                ..CommitFaults::default()
            },
        )
        .unwrap_err();
        let journal_id = match error {
            WorktreeCommitError::RecoveryRequired { journal_id, .. } => journal_id,
            other => panic!("expected recovery-required error, got {other}"),
        };

        let recovered = recover_completed_worktree_commit(&repository, &journal_id)
            .expect("published ref should recover to a completed commit");

        assert_eq!(
            git_output(&repository, ["rev-parse", "HEAD"]),
            recovered.revision
        );
        assert_eq!(recovered.recovery_journal_id, None);
        assert_eq!(
            git_output(&repository, ["show", "HEAD:tracked.txt"]),
            "accepted edit"
        );
    }

    #[test]
    fn blocks_mutation_after_head_advances_and_while_git_is_busy() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        fs::write(repository.join("tracked.txt"), "next revision\n").unwrap();
        git(&repository, ["add", "tracked.txt"]);
        git(&repository, ["commit", "--quiet", "-m", "advance"]);

        let advanced = store.inspect("task-1", &repository).unwrap();
        assert!(matches!(
            advanced.mutation,
            ArtifactMutationAvailability::Blocked {
                reason: ArtifactMutationBlockedReason::HeadAdvanced,
                ..
            }
        ));
        let advanced_error = store
            .rollback("task-1", &repository, &advanced.snapshot_token)
            .unwrap_err();
        assert_eq!(
            advanced_error.code,
            ArtifactOperationErrorCode::HeadAdvanced
        );
        assert!(advanced_error.latest_snapshot.is_some());

        let busy_repository = temporary.0.join("busy-repository");
        initialize_repository(&busy_repository);
        let busy_store = TaskArtifactStore::new(temporary.0.join("busy-artifacts.json"));
        busy_store
            .ensure_baseline("task-2", &busy_repository)
            .unwrap();
        fs::write(busy_repository.join("tracked.txt"), "edited\n").unwrap();
        let revision = git_output(&busy_repository, ["rev-parse", "HEAD"]);
        fs::write(
            busy_repository.join(".git/MERGE_HEAD"),
            format!("{revision}\n"),
        )
        .unwrap();
        let busy = busy_store.inspect("task-2", &busy_repository).unwrap();
        let busy_error = busy_store
            .rollback("task-2", &busy_repository, &busy.snapshot_token)
            .unwrap_err();
        assert_eq!(busy_error.code, ArtifactOperationErrorCode::RepositoryBusy);
        assert!(busy_error.latest_snapshot.is_some());
    }

    #[test]
    fn blocks_mutation_when_the_worktree_is_conflicted() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let base_branch = git_output(&repository, ["branch", "--show-current"]);
        git(&repository, ["checkout", "--quiet", "-b", "other"]);
        fs::write(repository.join("tracked.txt"), "other\n").unwrap();
        git(&repository, ["add", "tracked.txt"]);
        git(&repository, ["commit", "--quiet", "-m", "other"]);
        git(&repository, ["checkout", "--quiet", base_branch.as_str()]);
        fs::write(repository.join("tracked.txt"), "ours\n").unwrap();
        git(&repository, ["add", "tracked.txt"]);
        git(&repository, ["commit", "--quiet", "-m", "ours"]);

        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        store.ensure_baseline("task-1", &repository).unwrap();
        git_expect_failure(&repository, ["merge", "other"]);
        let conflicted = store.inspect("task-1", &repository).unwrap();
        assert!(matches!(
            conflicted.mutation,
            ArtifactMutationAvailability::Blocked {
                reason: ArtifactMutationBlockedReason::Conflicted,
                ..
            }
        ));
        let error = store
            .rollback("task-1", &repository, &conflicted.snapshot_token)
            .unwrap_err();
        assert_eq!(error.code, ArtifactOperationErrorCode::Conflicted);
        assert!(error.latest_snapshot.is_some());
    }

    #[test]
    fn atomically_replaces_an_existing_store_for_a_second_task() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());

        store.ensure_baseline("task-1", &repository).unwrap();
        store.ensure_baseline("task-2", &repository).unwrap();

        let restored = TaskArtifactStore::new(store_path);
        assert!(restored.baseline("task-1").unwrap().is_some());
        assert!(restored.baseline("task-2").unwrap().is_some());
        assert_eq!(restored.load_locked().unwrap().generation, 2);
    }

    #[test]
    fn serializes_concurrent_updates_without_losing_tasks() {
        const TASK_COUNT: usize = 8;
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let barrier = Arc::new(Barrier::new(TASK_COUNT));

        let threads = (0..TASK_COUNT)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                let repository = repository.clone();
                let store_path = store_path.clone();
                thread::spawn(move || {
                    barrier.wait();
                    TaskArtifactStore::new(store_path)
                        .ensure_baseline(&format!("task-{index}"), &repository)
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in threads {
            handle.join().unwrap();
        }

        let restored = TaskArtifactStore::new(store_path);
        for index in 0..TASK_COUNT {
            assert!(restored
                .baseline(&format!("task-{index}"))
                .unwrap()
                .is_some());
        }
        assert_eq!(
            restored.load_locked().unwrap().generation,
            TASK_COUNT as u64
        );
    }

    #[test]
    fn serializes_cross_process_updates_without_losing_tasks() {
        const TASK_COUNT: usize = 4;
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let start_path = temporary.0.join("start-cross-process-writers");
        let executable = std::env::current_exe().unwrap();

        let children = (0..TASK_COUNT)
            .map(|index| {
                Command::new(&executable)
                    .args([
                        "--exact",
                        "task_artifacts::tests::cross_process_writer_helper",
                        "--nocapture",
                    ])
                    .env("JOYDSH_ARTIFACT_TEST_CHILD", "1")
                    .env("JOYDSH_ARTIFACT_TEST_STORE", &store_path)
                    .env("JOYDSH_ARTIFACT_TEST_REPOSITORY", &repository)
                    .env("JOYDSH_ARTIFACT_TEST_START", &start_path)
                    .env("JOYDSH_ARTIFACT_TEST_TASK", format!("task-{index}"))
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        fs::write(&start_path, b"start").unwrap();

        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "child failed:\nstdout: {}\nstderr: {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let restored = TaskArtifactStore::new(store_path);
        for index in 0..TASK_COUNT {
            assert!(restored
                .baseline(&format!("task-{index}"))
                .unwrap()
                .is_some());
        }
        assert_eq!(
            restored.load_locked().unwrap().generation,
            TASK_COUNT as u64
        );
    }

    #[test]
    fn cross_process_writer_helper() {
        if std::env::var_os("JOYDSH_ARTIFACT_TEST_CHILD").is_none() {
            return;
        }
        let store_path = PathBuf::from(std::env::var_os("JOYDSH_ARTIFACT_TEST_STORE").unwrap());
        let repository =
            PathBuf::from(std::env::var_os("JOYDSH_ARTIFACT_TEST_REPOSITORY").unwrap());
        let start_path = PathBuf::from(std::env::var_os("JOYDSH_ARTIFACT_TEST_START").unwrap());
        let task_id = std::env::var("JOYDSH_ARTIFACT_TEST_TASK").unwrap();

        let started = (0..500).any(|_| match fs::metadata(&start_path) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                thread::sleep(Duration::from_millis(10));
                false
            }
            Err(error) => panic!("cannot read start signal: {error}"),
        });
        assert!(started, "cross-process start signal timed out");
        TaskArtifactStore::new(store_path)
            .ensure_baseline(&task_id, &repository)
            .unwrap();
    }

    #[test]
    fn rejects_a_damaged_or_unknown_store_version() {
        let temporary = TestDirectory::new();
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());

        fs::write(&store_path, b"{not json").unwrap();
        assert!(store
            .baseline("task-1")
            .unwrap_err()
            .starts_with("任务成果基线已损坏："));

        fs::write(&store_path, br#"{"version":1}"#).unwrap();
        let missing_baselines = store.baseline("task-1").unwrap_err();
        assert!(missing_baselines.starts_with("任务成果基线已损坏："));
        assert!(missing_baselines.contains("baselines"));

        fs::write(
            &store_path,
            br#"{"version":999,"baselines":"future schema"}"#,
        )
        .unwrap();
        assert_eq!(
            store.baseline("task-1").unwrap_err(),
            "不支持的任务成果基线版本：999"
        );
    }

    #[test]
    fn migrates_the_old_schema_in_memory_and_writes_new_fields_on_mutation() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();

        let mut old_schema: Value =
            serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        let object = old_schema.as_object_mut().unwrap();
        object.remove("generation");
        object.remove("acceptedChangeIds");
        fs::write(&store_path, serde_json::to_vec(&old_schema).unwrap()).unwrap();

        let restored = TaskArtifactStore::new(store_path.clone());
        let inspection = restored.inspect("task-1", &repository).unwrap();
        assert!(inspection.inspection.changes.is_empty());
        assert_eq!(restored.load_locked().unwrap().generation, 0);

        restored
            .update_accepted_change_id("task-1", "change-a", true)
            .unwrap();
        let migrated: Value = serde_json::from_slice(&fs::read(store_path).unwrap()).unwrap();
        assert_eq!(migrated["generation"], 1);
        assert_eq!(migrated["acceptedChangeIds"]["task-1"][0], "change-a");
    }

    #[test]
    fn persists_replaces_and_removes_accepted_change_ids_across_restarts() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();

        assert_eq!(
            store
                .replace_accepted_change_ids(
                    "task-1",
                    vec!["change-b".into(), "change-a".into(), "change-b".into()],
                )
                .unwrap(),
            vec!["change-a", "change-b"]
        );
        assert_eq!(store.load_locked().unwrap().generation, 2);

        let restored = TaskArtifactStore::new(store_path.clone());
        assert_eq!(
            restored.load_locked().unwrap().accepted_change_ids["task-1"],
            ["change-a".to_string(), "change-b".to_string()]
                .into_iter()
                .collect()
        );
        assert_eq!(restored.load_locked().unwrap().generation, 2);
        assert_eq!(
            restored
                .update_accepted_change_id("task-1", "change-a", false)
                .unwrap(),
            vec!["change-b"]
        );
        assert_eq!(restored.load_locked().unwrap().generation, 3);

        restored
            .replace_accepted_change_ids("task-1", vec!["change-b".into()])
            .unwrap();
        assert_eq!(restored.load_locked().unwrap().generation, 3);
    }

    #[test]
    fn serializes_concurrent_review_updates_without_losing_change_ids() {
        const CHANGE_COUNT: usize = 8;
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        TaskArtifactStore::new(store_path.clone())
            .ensure_baseline("task-1", &repository)
            .unwrap();
        let barrier = Arc::new(Barrier::new(CHANGE_COUNT));

        let threads = (0..CHANGE_COUNT)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                let store_path = store_path.clone();
                thread::spawn(move || {
                    barrier.wait();
                    TaskArtifactStore::new(store_path)
                        .update_accepted_change_id("task-1", &format!("change-{index}"), true)
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in threads {
            handle.join().unwrap();
        }

        let restored = TaskArtifactStore::new(store_path);
        let data = restored.load_locked().unwrap();
        assert_eq!(data.generation, 1 + CHANGE_COUNT as u64);
        assert_eq!(data.accepted_change_ids["task-1"].len(), CHANGE_COUNT);
    }

    #[test]
    fn validates_review_association_change_ids_and_generation_overflow() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();

        assert_eq!(
            store
                .update_accepted_change_id("missing-task", "change-a", true)
                .unwrap_err(),
            "该任务没有本地成果基线，不能保存评审状态"
        );
        assert_eq!(
            store
                .update_accepted_change_id("task-1", "bad change", true)
                .unwrap_err(),
            "变更 ID 无效"
        );
        assert_eq!(
            store
                .update_accepted_change_id(
                    "task-1",
                    &format!("a{}", "x".repeat(MAX_CHANGE_ID_BYTES)),
                    true,
                )
                .unwrap_err(),
            "变更 ID 无效"
        );
        assert!(store
            .replace_accepted_change_ids(
                "task-1",
                (0..=MAX_ACCEPTED_CHANGE_IDS_PER_TASK)
                    .map(|index| format!("change-{index}"))
                    .collect(),
            )
            .unwrap_err()
            .contains("最多接受"));

        let mut invalid_association: Value =
            serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        invalid_association["acceptedChangeIds"]["missing-task"] = serde_json::json!(["change-a"]);
        fs::write(
            &store_path,
            serde_json::to_vec(&invalid_association).unwrap(),
        )
        .unwrap();
        assert!(store
            .baseline("task-1")
            .unwrap_err()
            .contains("没有对应的成果基线"));

        invalid_association["acceptedChangeIds"] = serde_json::json!({});
        invalid_association["generation"] = Value::from(u64::MAX);
        fs::write(
            &store_path,
            serde_json::to_vec(&invalid_association).unwrap(),
        )
        .unwrap();
        assert!(store
            .update_accepted_change_id("task-1", "change-a", true)
            .unwrap_err()
            .contains("generation 已达到上限"));
        assert!(store
            .ensure_baseline("task-2", &repository)
            .unwrap_err()
            .contains("generation 已达到上限"));
    }

    #[test]
    fn keeps_generation_monotonic_when_a_save_is_reported_as_failed() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        let mut data = store.load_locked().unwrap();
        let previous_generation = data.generation;
        fs::remove_file(&store_path).unwrap();
        fs::create_dir(&store_path).unwrap();

        assert!(store
            .save_mutation_locked(&mut data)
            .unwrap_err()
            .starts_with("无法原子保存任务成果基线："));
        assert_eq!(data.generation, previous_generation + 1);
        assert!(store.temporary_candidates().unwrap().is_empty());
    }

    #[test]
    fn rejects_zero_and_out_of_range_capture_timestamps() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();

        let mut value: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        value["baselines"]["task-1"]["capturedAt"] = Value::from(0);
        fs::write(&store_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(store.baseline("task-1").unwrap_err().contains("capturedAt"));

        value["baselines"]["task-1"]["capturedAt"] = Value::from(MAX_CAPTURED_AT_MS + 1);
        fs::write(&store_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(store.baseline("task-1").unwrap_err().contains("capturedAt"));
    }

    #[test]
    fn recovers_a_valid_crash_snapshot_over_a_damaged_target() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        let baseline = store.ensure_baseline("task-1", &repository).unwrap();
        let snapshot = fs::read(&store_path).unwrap();
        leave_crash_snapshot(&store, &temporary.0, &snapshot);
        fs::write(&store_path, b"{truncated").unwrap();

        assert_eq!(store.baseline("task-1").unwrap(), Some(baseline));
        let restored: Value = serde_json::from_slice(&fs::read(store_path).unwrap()).unwrap();
        assert_eq!(restored["version"], 1);
    }

    #[test]
    fn recovers_a_valid_crash_snapshot_over_an_older_valid_target() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        let baseline = store.ensure_baseline("task-1", &repository).unwrap();
        let mut snapshot: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        let task_two = snapshot["baselines"]["task-1"].clone();
        snapshot["baselines"]["task-2"] = task_two;
        snapshot["generation"] = Value::from(2);
        leave_crash_snapshot(
            &store,
            &temporary.0,
            &serde_json::to_vec(&snapshot).unwrap(),
        );

        assert_eq!(store.baseline("task-2").unwrap(), Some(baseline));
        let restored: Value = serde_json::from_slice(&fs::read(store_path).unwrap()).unwrap();
        assert!(restored["baselines"]["task-2"].is_object());
    }

    #[test]
    fn recovers_the_highest_generation_regardless_of_candidate_creation_order() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        let base: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        let mut generation_two = base.clone();
        generation_two["generation"] = Value::from(2);
        generation_two["acceptedChangeIds"] = serde_json::json!({"task-1": ["change-two"]});
        let mut generation_three = generation_two.clone();
        generation_three["generation"] = Value::from(3);
        generation_three["acceptedChangeIds"] = serde_json::json!({"task-1": ["change-three"]});

        leave_crash_snapshot(
            &store,
            &temporary.0,
            &serde_json::to_vec(&generation_three).unwrap(),
        );
        leave_crash_snapshot(
            &store,
            &temporary.0,
            &serde_json::to_vec(&generation_two).unwrap(),
        );

        assert!(store.baseline("task-1").unwrap().is_some());
        assert_eq!(
            store.load_locked().unwrap().accepted_change_ids["task-1"],
            ["change-three".to_string()].into_iter().collect()
        );
        assert_eq!(store.load_locked().unwrap().generation, 3);
    }

    #[test]
    fn rejects_a_same_generation_fork() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        let mut fork: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        fork["acceptedChangeIds"] = serde_json::json!({"task-1": ["change-a"]});
        leave_crash_snapshot(&store, &temporary.0, &serde_json::to_vec(&fork).unwrap());

        assert!(store.baseline("task-1").unwrap_err().contains("分叉"));
        let current: Value = serde_json::from_slice(&fs::read(store_path).unwrap()).unwrap();
        assert_eq!(current["acceptedChangeIds"], serde_json::json!({}));
    }

    #[test]
    fn rejects_a_higher_generation_candidate_that_drops_a_baseline() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        store.ensure_baseline("task-2", &repository).unwrap();
        let mut rollback: Value = serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
        rollback["generation"] = Value::from(3);
        rollback["baselines"]
            .as_object_mut()
            .unwrap()
            .remove("task-2");
        leave_crash_snapshot(
            &store,
            &temporary.0,
            &serde_json::to_vec(&rollback).unwrap(),
        );

        assert!(store
            .baseline("task-2")
            .unwrap_err()
            .contains("倒退已有任务基线"));
    }

    #[test]
    fn ignores_a_stale_crash_snapshot_instead_of_rolling_back_the_store() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path.clone());
        store.ensure_baseline("task-1", &repository).unwrap();
        let stale_snapshot = fs::read(&store_path).unwrap();
        store.ensure_baseline("task-2", &repository).unwrap();
        leave_crash_snapshot(&store, &temporary.0, &stale_snapshot);

        assert!(store.baseline("task-2").unwrap().is_some());
        let restored: Value = serde_json::from_slice(&fs::read(store_path).unwrap()).unwrap();
        assert!(restored["baselines"]["task-2"].is_object());
    }

    #[test]
    fn ignores_orphaned_unknown_and_damaged_snapshots_when_the_store_is_valid() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store_path = temporary.0.join("task-artifacts.json");
        let store = TaskArtifactStore::new(store_path);
        let baseline = store.ensure_baseline("task-1", &repository).unwrap();

        leave_crash_snapshot(
            &store,
            &temporary.0,
            br#"{"version":999,"baselines":"future schema"}"#,
        );
        assert_eq!(store.baseline("task-1").unwrap(), Some(baseline.clone()));
        assert!(store.temporary_candidates().unwrap().is_empty());

        leave_crash_snapshot(&store, &temporary.0, b"{truncated");
        assert_eq!(store.baseline("task-1").unwrap(), Some(baseline));
        assert!(store.temporary_candidates().unwrap().is_empty());
    }

    #[test]
    fn does_not_rebind_an_existing_task_to_another_repository() {
        let temporary = TestDirectory::new();
        let first = temporary.0.join("first");
        let second = temporary.0.join("second");
        initialize_repository(&first);
        initialize_repository(&second);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));

        store.ensure_baseline("task-1", &first).unwrap();

        assert_eq!(
            store.ensure_baseline("task-1", &second).unwrap_err(),
            "该任务已经绑定到另一个 Git 工作区"
        );
    }

    #[test]
    fn rejects_an_oversized_primary_store_before_parsing_it() {
        let temporary = TestDirectory::new();
        let store_path = temporary.0.join("task-artifacts.json");
        fs::File::create(&store_path)
            .unwrap()
            .set_len(MAX_STORE_BYTES + 1)
            .unwrap();
        let store = TaskArtifactStore::new(store_path);

        let error = store.load_locked().unwrap_err();

        assert!(error.contains("超过读取上限"), "{error}");
    }

    #[test]
    fn caps_the_number_of_recovery_candidates() {
        let temporary = TestDirectory::new();
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));
        for _ in 0..=MAX_TEMPORARY_CANDIDATES {
            leave_crash_snapshot(&store, &temporary.0, b"{}");
        }

        let error = store.temporary_candidates().unwrap_err();

        assert!(error.contains(&MAX_TEMPORARY_CANDIDATES.to_string()));
    }

    #[test]
    fn caps_baseline_and_task_id_cardinality() {
        let baseline = TaskBaseline {
            repository_root: PathBuf::from("/repository"),
            revision: "a".repeat(40),
            captured_at: 1,
        };
        let mut too_many_baselines = TaskArtifactData::default();
        for index in 0..=MAX_BASELINES {
            too_many_baselines
                .baselines
                .insert(format!("task-{index}"), baseline.clone());
        }
        assert!(validate_data(&too_many_baselines)
            .unwrap_err()
            .contains(&MAX_BASELINES.to_string()));

        let mut oversized_ids = TaskArtifactData::default();
        let task_id_tail = "x".repeat(500);
        for index in 0..MAX_BASELINES {
            oversized_ids
                .baselines
                .insert(format!("{index:04}-{task_id_tail}"), baseline.clone());
            if oversized_ids
                .baselines
                .keys()
                .map(String::len)
                .sum::<usize>()
                > MAX_TOTAL_TASK_ID_BYTES
            {
                break;
            }
        }
        let error = validate_data(&oversized_ids).unwrap_err();
        assert!(
            error.contains(&MAX_TOTAL_TASK_ID_BYTES.to_string()),
            "{error}"
        );
    }

    #[test]
    fn refuses_to_invent_a_baseline_for_a_restored_task() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));

        assert_eq!(
            store.inspect("older-task", &repository).unwrap_err(),
            "该任务没有本地成果基线，不能安全计算或回滚变更"
        );
        assert_eq!(store.baseline("older-task").unwrap(), None);
    }

    #[test]
    fn ensure_baseline_captures_head_on_dirty_workspace() {
        let temporary = TestDirectory::new();
        let repository = temporary.0.join("repository");
        initialize_repository(&repository);
        let store = TaskArtifactStore::new(temporary.0.join("task-artifacts.json"));

        // Create dirty files before establishing baseline
        fs::write(repository.join("tracked.txt"), "modified after initial\n").unwrap();
        fs::write(repository.join("untracked.txt"), "new file\n").unwrap();

        // ensure_baseline should succeed by binding to HEAD
        let baseline = store.ensure_baseline("dirty-task", &repository).unwrap();
        assert_eq!(baseline.repository_root, fs::canonicalize(&repository).unwrap());
        assert!(!baseline.revision.is_empty());

        // inspect should now work and detect the 2 changes
        let inspection = store.inspect("dirty-task", &repository).unwrap();
        assert_eq!(inspection.inspection.changes.len(), 2);
    }

    fn initialize_repository(path: &Path) {
        fs::create_dir_all(path).unwrap();
        git(path, ["init", "--quiet"]);
        git(path, ["config", "user.email", "joydsh@example.invalid"]);
        git(path, ["config", "user.name", "JoyDSH Test"]);
        fs::write(path.join("tracked.txt"), "before\n").unwrap();
        git(path, ["add", "tracked.txt"]);
        git(path, ["commit", "--quiet", "-m", "initial"]);
    }

    fn leave_crash_snapshot(store: &TaskArtifactStore, directory: &Path, contents: &[u8]) {
        let prefix = store.temporary_prefix().unwrap();
        let mut crash_file = TempFileBuilder::new()
            .prefix(&prefix)
            .suffix(TEMP_FILE_SUFFIX)
            .tempfile_in(directory)
            .unwrap();
        crash_file.write_all(contents).unwrap();
        crash_file.flush().unwrap();
        crash_file.as_file().sync_all().unwrap();
        crash_file.keep().unwrap();
    }

    fn git<const N: usize>(path: &Path, args: [&str; N]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output<const N: usize>(path: &Path, args: [&str; N]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn git_expect_failure<const N: usize>(path: &Path, args: [&str; N]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(!output.status.success(), "git unexpectedly succeeded");
    }
}
