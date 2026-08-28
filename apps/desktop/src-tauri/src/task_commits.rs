use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_PROPOSALS: usize = 128;
const PROPOSAL_TTL: Duration = Duration::from_secs(30 * 60);
const PROPOSAL_ID_BYTES: usize = 32;

const MAX_TASK_ID_BYTES: usize = 512;
const MAX_WORKSPACE_PATH_BYTES: usize = 16 * 1_024;
const MAX_SNAPSHOT_TOKEN_BYTES: usize = 1_024;
const MAX_PROMPT_RPC_ID_BYTES: usize = 512;
const MAX_ACCEPTED_CHANGE_IDS: usize = 1_000;
const MAX_CHANGE_ID_BYTES: usize = 512;
const MAX_TOTAL_CHANGE_ID_BYTES: usize = 256 * 1_024;
const MAX_REVISION_BYTES: usize = 512;
const MAX_MESSAGE_BYTES: usize = 8 * 1_024;
const MAX_TITLE_BYTES: usize = 512;

const MAX_HISTORY_PAGES: usize = 1_024;
const MAX_HISTORY_EVENTS: usize = 100_000;
const MAX_HISTORY_EVENT_BYTES: usize = 1024 * 1_024;
const MAX_HISTORY_BYTES: usize = 32 * 1_024 * 1_024;
const MAX_EVENT_TYPE_BYTES: usize = 128;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitProposalSeed {
    pub(crate) task_id: String,
    pub(crate) workspace_path: String,
    pub(crate) snapshot_token: String,
    pub(crate) accepted_change_ids: Vec<String>,
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
    pub(crate) prompt_rpc_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartCommitProposalResponse {
    pub(crate) proposal_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadyCommitProposal {
    pub(crate) proposal_id: String,
    pub(crate) task_id: String,
    pub(crate) workspace_path: String,
    pub(crate) snapshot_token: String,
    pub(crate) accepted_change_ids: Vec<String>,
    pub(crate) additions: u64,
    pub(crate) deletions: u64,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub(crate) enum ResolveCommitProposalResponse {
    Generating,
    Ready { proposal: ReadyCommitProposal },
    Failed { message: String },
    Completed { revision: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CommitProposalState {
    Generating,
    ResolvingHistory,
    Ready { message: String },
    Failed { message: String },
    Committing,
    Completed { revision: String },
    Invalid { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CommitProposalEntry {
    seed: CommitProposalSeed,
    state: CommitProposalState,
    updated_at: Instant,
}

pub(crate) struct CommitProposalManager(Mutex<HashMap<String, CommitProposalEntry>>);

impl Default for CommitProposalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl CommitProposalManager {
    pub(crate) fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    pub(crate) fn start(
        &self,
        seed: CommitProposalSeed,
    ) -> Result<StartCommitProposalResponse, String> {
        validate_seed(&seed)?;
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        evict_terminal_for_capacity(&mut proposals);
        if proposals.len() >= MAX_PROPOSALS {
            return Err(format!(
                "同时存在的提交说明提案已达到上限（{MAX_PROPOSALS} 个），请稍后重试"
            ));
        }

        let proposal_id = generate_unique_proposal_id(&proposals)?;
        proposals.insert(
            proposal_id.clone(),
            CommitProposalEntry {
                seed,
                state: CommitProposalState::Generating,
                updated_at: now,
            },
        );
        Ok(StartCommitProposalResponse { proposal_id })
    }

    pub(crate) fn resolve(
        &self,
        proposal_id: &str,
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        Ok(resolve_response(proposal_id, entry))
    }

    pub(crate) fn seed(&self, proposal_id: &str) -> Result<CommitProposalSeed, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        proposals
            .get(proposal_id)
            .map(|entry| entry.seed.clone())
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())
    }

    /// Atomically elects one history-fetch leader for a generating proposal.
    pub(crate) fn begin_history_resolution(&self, proposal_id: &str) -> Result<bool, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        if matches!(entry.state, CommitProposalState::Generating) {
            entry.state = CommitProposalState::ResolvingHistory;
            entry.updated_at = now;
            return Ok(true);
        }
        Ok(false)
    }

    /// Releases the history-fetch leader after a transport or other transient fetch failure.
    pub(crate) fn release_history_resolution(
        &self,
        proposal_id: &str,
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        if matches!(entry.state, CommitProposalState::ResolvingHistory) {
            entry.state = CommitProposalState::Generating;
            entry.updated_at = now;
        }
        Ok(resolve_response(proposal_id, entry))
    }

    /// Persists a deterministic history-fetch failure for the elected resolution leader.
    pub(crate) fn fail_history_resolution(
        &self,
        proposal_id: &str,
        message: String,
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let message = sanitize_status_message(message, "无法读取 DSH 提交说明历史");
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        if matches!(entry.state, CommitProposalState::ResolvingHistory) {
            entry.state = CommitProposalState::Failed { message };
            entry.updated_at = now;
        } else if !matches!(
            entry.state,
            CommitProposalState::Failed { .. } | CommitProposalState::Invalid { .. }
        ) {
            return Err("只有历史解析 leader 才能标记提交说明历史失败".into());
        }
        Ok(resolve_response(proposal_id, entry))
    }

    /// Reconciles one proposal with complete `session.history` response envelopes.
    /// Parsing happens outside the manager lock; the resulting transition is applied atomically.
    pub(crate) fn mark_ready(
        &self,
        proposal_id: &str,
        history_pages: &[Value],
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let prompt_rpc_id = {
            let now = Instant::now();
            let mut proposals = self.lock()?;
            evict_expired(&mut proposals, now);
            let entry = proposals
                .get(proposal_id)
                .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
            if !matches!(entry.state, CommitProposalState::ResolvingHistory) {
                return Err("只有历史解析 leader 才能收口提交说明提案".into());
            }
            entry.seed.prompt_rpc_id.clone()
        };
        let history_resolution = match resolve_commit_message(history_pages, &prompt_rpc_id) {
            Ok(resolution) => resolution,
            Err(message) => CommitMessageResolution::Failed {
                message: sanitize_status_message(message, "无法解析 DSH 提交说明历史"),
            },
        };

        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        if matches!(entry.state, CommitProposalState::ResolvingHistory) {
            match history_resolution {
                CommitMessageResolution::Generating => {
                    entry.state = CommitProposalState::Generating;
                    entry.updated_at = now;
                }
                CommitMessageResolution::Ready { message } => {
                    entry.state = CommitProposalState::Ready { message };
                    entry.updated_at = now;
                }
                CommitMessageResolution::Failed { message } => {
                    entry.state = CommitProposalState::Failed { message };
                    entry.updated_at = now;
                }
            }
        }
        Ok(resolve_response(proposal_id, entry))
    }

    /// Atomically consumes a ready proposal. A proposal cannot enter committing twice.
    pub(crate) fn begin_commit(&self, proposal_id: &str) -> Result<ReadyCommitProposal, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;

        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        let message = match &entry.state {
            CommitProposalState::Ready { message } => message.clone(),
            CommitProposalState::Generating | CommitProposalState::ResolvingHistory => {
                return Err("提交说明仍在生成".into())
            }
            CommitProposalState::Failed { message } | CommitProposalState::Invalid { message } => {
                return Err(message.clone())
            }
            CommitProposalState::Committing => {
                return Err("提交说明提案已在提交，不能重复使用".into())
            }
            CommitProposalState::Completed { .. } => {
                return Err("提交说明提案已完成，不能重复使用".into())
            }
        };
        let ready = ready_proposal(proposal_id, &entry.seed, message.clone());
        entry.state = CommitProposalState::Committing;
        entry.updated_at = now;
        Ok(ready)
    }

    pub(crate) fn finish_commit(
        &self,
        proposal_id: &str,
        revision: String,
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let revision = sanitize_bounded_status_message(
            revision,
            "提交已经完成，版本标识不可用",
            MAX_REVISION_BYTES,
        );
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        if !matches!(entry.state, CommitProposalState::Committing) {
            return Err("只有正在提交的提案才能标记为完成".into());
        }
        entry.state = CommitProposalState::Completed {
            revision: revision.clone(),
        };
        entry.updated_at = now;
        Ok(ResolveCommitProposalResponse::Completed { revision })
    }

    pub(crate) fn abort_commit(
        &self,
        proposal_id: &str,
        message: String,
    ) -> Result<ResolveCommitProposalResponse, String> {
        self.transition_committing_to_failure(proposal_id, message)
    }

    pub(crate) fn invalidate(
        &self,
        proposal_id: &str,
        message: String,
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let message = sanitize_status_message(message, "提交说明提案已经失效");
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        match entry.state {
            CommitProposalState::Generating
            | CommitProposalState::ResolvingHistory
            | CommitProposalState::Ready { .. }
            | CommitProposalState::Committing => {
                entry.state = CommitProposalState::Invalid {
                    message: message.clone(),
                };
                entry.updated_at = now;
                Ok(ResolveCommitProposalResponse::Failed { message })
            }
            CommitProposalState::Failed { .. } | CommitProposalState::Invalid { .. } => {
                Ok(resolve_response(proposal_id, entry))
            }
            CommitProposalState::Completed { .. } => Err("已完成的提交说明提案不能再失效".into()),
        }
    }

    fn transition_committing_to_failure(
        &self,
        proposal_id: &str,
        message: String,
    ) -> Result<ResolveCommitProposalResponse, String> {
        validate_identifier("proposalId", proposal_id, PROPOSAL_ID_BYTES * 2)?;
        let message = sanitize_status_message(message, "提交失败");
        let now = Instant::now();
        let mut proposals = self.lock()?;
        evict_expired(&mut proposals, now);
        let entry = proposals
            .get_mut(proposal_id)
            .ok_or_else(|| "提交说明提案不存在或已过期".to_owned())?;
        if !matches!(entry.state, CommitProposalState::Committing) {
            return Err("只有正在提交的提案才能中止提交".into());
        }
        entry.state = CommitProposalState::Failed {
            message: message.clone(),
        };
        entry.updated_at = now;
        Ok(ResolveCommitProposalResponse::Failed { message })
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, CommitProposalEntry>>, String> {
        self.0
            .lock()
            .map_err(|_| "提交说明提案状态锁已损坏".to_owned())
    }
}

fn ready_proposal(
    proposal_id: &str,
    seed: &CommitProposalSeed,
    message: String,
) -> ReadyCommitProposal {
    ReadyCommitProposal {
        proposal_id: proposal_id.to_owned(),
        task_id: seed.task_id.clone(),
        workspace_path: seed.workspace_path.clone(),
        snapshot_token: seed.snapshot_token.clone(),
        accepted_change_ids: seed.accepted_change_ids.clone(),
        additions: seed.additions,
        deletions: seed.deletions,
        message,
    }
}

fn resolve_response(
    proposal_id: &str,
    entry: &CommitProposalEntry,
) -> ResolveCommitProposalResponse {
    match &entry.state {
        CommitProposalState::Generating
        | CommitProposalState::ResolvingHistory
        | CommitProposalState::Committing => ResolveCommitProposalResponse::Generating,
        CommitProposalState::Ready { message } => ResolveCommitProposalResponse::Ready {
            proposal: ready_proposal(proposal_id, &entry.seed, message.clone()),
        },
        CommitProposalState::Failed { message } | CommitProposalState::Invalid { message } => {
            ResolveCommitProposalResponse::Failed {
                message: message.clone(),
            }
        }
        CommitProposalState::Completed { revision } => ResolveCommitProposalResponse::Completed {
            revision: revision.clone(),
        },
    }
}

fn generate_unique_proposal_id(
    proposals: &HashMap<String, CommitProposalEntry>,
) -> Result<String, String> {
    for _ in 0..8 {
        let mut bytes = [0_u8; PROPOSAL_ID_BYTES];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("无法生成提交说明提案标识：{error}"))?;
        let proposal_id = encode_hex(&bytes);
        if !proposals.contains_key(&proposal_id) {
            return Ok(proposal_id);
        }
    }
    Err("无法生成唯一的提交说明提案标识".into())
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn evict_expired(proposals: &mut HashMap<String, CommitProposalEntry>, now: Instant) {
    proposals.retain(|_, proposal| {
        matches!(proposal.state, CommitProposalState::Committing)
            || now.saturating_duration_since(proposal.updated_at) <= PROPOSAL_TTL
    });
}

fn evict_terminal_for_capacity(proposals: &mut HashMap<String, CommitProposalEntry>) {
    if proposals.len() < MAX_PROPOSALS {
        return;
    }
    let oldest_terminal = proposals
        .iter()
        .filter(|(_, proposal)| {
            matches!(
                proposal.state,
                CommitProposalState::Failed { .. }
                    | CommitProposalState::Completed { .. }
                    | CommitProposalState::Invalid { .. }
            )
        })
        .min_by_key(|(_, proposal)| proposal.updated_at)
        .map(|(proposal_id, _)| proposal_id.clone());
    if let Some(proposal_id) = oldest_terminal {
        proposals.remove(&proposal_id);
    }
}

fn validate_seed(seed: &CommitProposalSeed) -> Result<(), String> {
    validate_identifier("taskId", &seed.task_id, MAX_TASK_ID_BYTES)?;
    validate_identifier(
        "workspacePath",
        &seed.workspace_path,
        MAX_WORKSPACE_PATH_BYTES,
    )?;
    validate_identifier(
        "snapshotToken",
        &seed.snapshot_token,
        MAX_SNAPSHOT_TOKEN_BYTES,
    )?;
    validate_identifier("promptRpcId", &seed.prompt_rpc_id, MAX_PROMPT_RPC_ID_BYTES)?;
    if seed.accepted_change_ids.is_empty() {
        return Err("提交说明提案至少需要一个已接受成果".into());
    }
    if seed.accepted_change_ids.len() > MAX_ACCEPTED_CHANGE_IDS {
        return Err(format!(
            "已接受成果数量超过上限（{MAX_ACCEPTED_CHANGE_IDS} 个）"
        ));
    }
    let mut seen = HashSet::with_capacity(seed.accepted_change_ids.len());
    let mut total_bytes = 0_usize;
    for change_id in &seed.accepted_change_ids {
        validate_identifier("acceptedChangeId", change_id, MAX_CHANGE_ID_BYTES)?;
        total_bytes = total_bytes
            .checked_add(change_id.len())
            .ok_or("已接受成果标识总长度溢出")?;
        if total_bytes > MAX_TOTAL_CHANGE_ID_BYTES {
            return Err(format!(
                "已接受成果标识总长度超过上限（{MAX_TOTAL_CHANGE_ID_BYTES} 字节）"
            ));
        }
        if !seen.insert(change_id) {
            return Err("已接受成果标识不能重复".into());
        }
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} 不能为空"));
    }
    if value.len() > max_bytes {
        return Err(format!("{label} 超过长度上限（{max_bytes} 字节）"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} 包含控制字符"));
    }
    Ok(())
}

fn sanitize_status_message(message: String, fallback: &str) -> String {
    sanitize_bounded_status_message(message, fallback, MAX_MESSAGE_BYTES)
}

fn sanitize_bounded_status_message(message: String, fallback: &str, max_bytes: usize) -> String {
    let printable = message
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let normalized = printable.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = if normalized.is_empty() {
        fallback
    } else {
        &normalized
    };
    truncate_utf8(normalized, max_bytes)
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum CommitMessageResolution {
    Generating,
    Ready { message: String },
    Failed { message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HistoryEvent {
    sequence: u64,
    event_type: String,
    data: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HistoryWindow {
    events: Vec<HistoryEvent>,
    has_earlier_events: bool,
    reached_session_start: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PromptTurnAssociation {
    Missing,
    NeedsEarlierContext,
    Pending,
    Cancelled,
    Turn(Value),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct InboxReplay {
    exact_length: Option<usize>,
    known_messages: BTreeMap<usize, Value>,
}

impl InboxReplay {
    fn new(has_earlier_events: bool) -> Self {
        Self {
            exact_length: (!has_earlier_events).then_some(0),
            known_messages: BTreeMap::new(),
        }
    }

    fn contains_message_id_outside(
        &self,
        message_id: &str,
        removed_start: usize,
        removed_end: usize,
    ) -> bool {
        self.known_messages.iter().any(|(index, message)| {
            (*index < removed_start || *index >= removed_end)
                && inbox_message_id(message).ok() == Some(message_id)
        })
    }

    fn contains_message_id(&self, message_id: &str) -> bool {
        self.known_messages
            .values()
            .any(|message| inbox_message_id(message).ok() == Some(message_id))
    }

    fn splice(
        &mut self,
        start: usize,
        removed_count: usize,
        inserted: &[Value],
    ) -> Result<Vec<Value>, String> {
        let removed_end = start
            .checked_add(removed_count)
            .ok_or("DSH agent/inbox/spliced 边界溢出")?;
        let new_exact_length = match self.exact_length {
            Some(length) => {
                if start > length || removed_end > length {
                    return Err("DSH agent/inbox/spliced 超出 inbox 边界".into());
                }
                Some(
                    length
                        .checked_sub(removed_count)
                        .and_then(|length| length.checked_add(inserted.len()))
                        .ok_or("DSH agent/inbox/spliced 长度溢出")?,
                )
            }
            None => None,
        };
        start
            .checked_add(inserted.len())
            .ok_or("DSH agent/inbox/spliced 插入边界溢出")?;
        for index in self.known_messages.keys().copied() {
            if index < removed_end {
                continue;
            }
            if inserted.len() >= removed_count {
                index
                    .checked_add(inserted.len() - removed_count)
                    .ok_or("DSH agent/inbox/spliced 已知消息位置溢出")?;
            } else {
                index
                    .checked_sub(removed_count - inserted.len())
                    .ok_or("DSH agent/inbox/spliced 已知消息位置无效")?;
            }
        }

        let mut removed = Vec::new();
        let mut shifted = BTreeMap::new();
        for (index, message) in std::mem::take(&mut self.known_messages) {
            if index < start {
                shifted.insert(index, message);
            } else if index < removed_end {
                removed.push(message);
            } else {
                let shifted_index = if inserted.len() >= removed_count {
                    index + (inserted.len() - removed_count)
                } else {
                    index - (removed_count - inserted.len())
                };
                shifted.insert(shifted_index, message);
            }
        }
        for (offset, message) in inserted.iter().cloned().enumerate() {
            shifted.insert(start + offset, message);
        }
        self.exact_length = new_exact_length;
        self.known_messages = shifted;
        Ok(removed)
    }
}

fn resolve_commit_message(
    history_pages: &[Value],
    prompt_rpc_id: &str,
) -> Result<CommitMessageResolution, String> {
    validate_identifier("promptRpcId", prompt_rpc_id, MAX_PROMPT_RPC_ID_BYTES)?;
    let history = merge_history_pages(history_pages)?;
    let events = &history.events;
    let association = associate_prompt_turn(events, prompt_rpc_id, history.has_earlier_events)?;
    let turn = match association {
        PromptTurnAssociation::Missing if history.reached_session_start => {
            return Ok(CommitMessageResolution::Failed {
                message: "DSH 完整历史中不存在提交说明请求".into(),
            })
        }
        PromptTurnAssociation::Missing
        | PromptTurnAssociation::NeedsEarlierContext
        | PromptTurnAssociation::Pending => return Ok(CommitMessageResolution::Generating),
        PromptTurnAssociation::Cancelled => {
            return Ok(CommitMessageResolution::Failed {
                message: "提交说明生成已取消".into(),
            })
        }
        PromptTurnAssociation::Turn(turn) => turn,
    };
    let turn_starts = events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            (event.event_type == "turn/start" && event.data.get("turn") == Some(&turn))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    let turn_start_index = match turn_starts.as_slice() {
        [index] => *index,
        [] => return Err("DSH 历史中的提交说明请求缺少回合起点".into()),
        _ => return Err("DSH 历史中的提交说明请求存在重复回合起点".into()),
    };
    let next_turn_start = events[turn_start_index + 1..]
        .iter()
        .position(|event| event.event_type == "turn/start")
        .map(|offset| turn_start_index + 1 + offset);
    let boundary = next_turn_start.unwrap_or(events.len());
    let turn_end_index = events[turn_start_index + 1..boundary]
        .iter()
        .position(|event| event.event_type == "turn/end" && event.data.get("turn") == Some(&turn))
        .map(|offset| turn_start_index + 1 + offset);
    let Some(turn_end_index) = turn_end_index else {
        if next_turn_start.is_some() {
            return Ok(CommitMessageResolution::Failed {
                message: "提交说明生成回合缺少结束事件".into(),
            });
        }
        return Ok(CommitMessageResolution::Generating);
    };

    let reason = events[turn_end_index]
        .data
        .get("reason")
        .and_then(Value::as_object)
        .ok_or("DSH 提交说明回合缺少结束原因")?;
    let reason_kind = reason
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("DSH 提交说明回合的结束原因无效")?;
    if reason_kind != "completed" {
        return Ok(CommitMessageResolution::Failed {
            message: turn_failure_message(reason_kind, reason),
        });
    }

    let mut last_text = None;
    for event in &events[turn_start_index + 1..turn_end_index] {
        if event.event_type != "assistant/message" || event.data.get("turn") != Some(&turn) {
            continue;
        }
        if let Some(text) = assistant_text_blocks(&event.data)? {
            last_text = Some(text);
        }
    }
    let Some(text) = last_text else {
        return Ok(CommitMessageResolution::Failed {
            message: "智能体没有生成可用的提交说明".into(),
        });
    };
    match normalize_commit_message(&text) {
        Ok(message) => Ok(CommitMessageResolution::Ready { message }),
        Err(message) => Ok(CommitMessageResolution::Failed { message }),
    }
}

pub(crate) fn commit_history_has_sufficient_context(
    history_pages: &[Value],
    prompt_rpc_id: &str,
) -> Result<bool, String> {
    validate_identifier("promptRpcId", prompt_rpc_id, MAX_PROMPT_RPC_ID_BYTES)?;
    let association = match merge_history_pages(history_pages).and_then(|history| {
        associate_prompt_turn(&history.events, prompt_rpc_id, history.has_earlier_events)
    }) {
        Ok(association) => association,
        // Protocol and resource failures are deterministic for these pages. Stop pagination so
        // `mark_ready` can persist the diagnostic instead of releasing the proposal for retries.
        Err(_) => return Ok(true),
    };
    Ok(!matches!(
        association,
        PromptTurnAssociation::Missing | PromptTurnAssociation::NeedsEarlierContext
    ))
}

fn associate_prompt_turn(
    events: &[HistoryEvent],
    prompt_rpc_id: &str,
    has_earlier_events: bool,
) -> Result<PromptTurnAssociation, String> {
    let mut next_turn = InboxReplay::new(has_earlier_events);
    let mut next_step = InboxReplay::new(has_earlier_events);
    let mut open_turn = None::<Value>;
    let mut inbox_association = PromptTurnAssociation::Missing;
    let mut user_turn = None::<Value>;
    let mut user_needs_earlier_context = false;

    for event in events {
        match event.event_type.as_str() {
            "turn/start" => {
                let turn = event
                    .data
                    .get("turn")
                    .filter(|turn| valid_turn_id(turn))
                    .cloned()
                    .ok_or_else(|| format!("DSH turn/start {} 缺少有效 turn", event.sequence))?;
                open_turn = Some(turn);
            }
            "turn/end" => {
                if open_turn.as_ref() == event.data.get("turn") {
                    open_turn = None;
                }
            }
            "user/message" if message_rpc_id(&event.data) == Some(prompt_rpc_id) => {
                if user_turn.is_some() || user_needs_earlier_context {
                    return Err("DSH 历史中存在多个相同 rpcId 的用户消息".into());
                }
                match &open_turn {
                    Some(turn) => user_turn = Some(turn.clone()),
                    None if has_earlier_events => user_needs_earlier_context = true,
                    None => return Err("DSH 历史中的提交说明用户消息不属于有效回合".into()),
                }
            }
            "agent/inbox/spliced" => {
                let splice = event
                    .data
                    .as_object()
                    .ok_or("DSH agent/inbox/spliced 数据不是对象")?;
                let target = splice
                    .get("target")
                    .and_then(Value::as_str)
                    .ok_or("DSH agent/inbox/spliced 缺少 target")?;
                let (inbox, other_inbox) = match target {
                    "next-turn" => (&mut next_turn, &next_step),
                    "next-step" => (&mut next_step, &next_turn),
                    _ => return Err("DSH agent/inbox/spliced target 无效".into()),
                };
                let start = splice
                    .get("start")
                    .and_then(Value::as_u64)
                    .and_then(|start| usize::try_from(start).ok())
                    .ok_or("DSH agent/inbox/spliced start 无效")?;
                let removed_count = match splice.get("removedCount") {
                    Some(value) => value
                        .as_u64()
                        .and_then(|count| usize::try_from(count).ok())
                        .ok_or("DSH agent/inbox/spliced removedCount 无效")?,
                    None => 0,
                };
                let inserted = splice
                    .get("inserted")
                    .and_then(Value::as_array)
                    .ok_or("DSH agent/inbox/spliced 缺少 inserted")?;
                let removed_end = start
                    .checked_add(removed_count)
                    .ok_or("DSH agent/inbox/spliced 边界溢出")?;
                let outcome = match splice.get("outcome") {
                    Some(Value::String(outcome)) if outcome == "canceled" => Some("canceled"),
                    Some(_) => return Err("DSH agent/inbox/spliced outcome 无效".into()),
                    None => None,
                };
                if outcome.is_some() && removed_count == 0 {
                    return Err("DSH agent/inbox/spliced outcome 缺少被移除消息".into());
                }
                let mut inserted_message_ids = HashSet::with_capacity(inserted.len());
                for message in inserted {
                    validate_inbox_message(message)?;
                    let message_id = inbox_message_id(message)?;
                    if !inserted_message_ids.insert(message_id)
                        || inbox.contains_message_id_outside(message_id, start, removed_end)
                        || other_inbox.contains_message_id(message_id)
                    {
                        return Err("DSH inbox 插入了重复 messageId".into());
                    }
                }
                let removed = inbox.splice(start, removed_count, inserted)?;
                let removed_prompt_count = removed
                    .iter()
                    .filter(|message| message_rpc_id(message) == Some(prompt_rpc_id))
                    .count();
                if removed_prompt_count > 1 {
                    return Err("DSH inbox 一次移除了多个相同 rpcId 的消息".into());
                }
                if removed_prompt_count == 1 {
                    match outcome {
                        Some("canceled") => inbox_association = PromptTurnAssociation::Cancelled,
                        None => {
                            let Some(turn) = open_turn.clone() else {
                                if has_earlier_events {
                                    inbox_association = PromptTurnAssociation::NeedsEarlierContext;
                                    continue;
                                }
                                return Err("DSH inbox 在有效回合之外认领了提交说明请求".into());
                            };
                            if matches!(inbox_association, PromptTurnAssociation::Turn(_)) {
                                return Err("DSH inbox 重复认领了提交说明请求".into());
                            }
                            inbox_association = PromptTurnAssociation::Turn(turn);
                        }
                        Some(_) => unreachable!(),
                    }
                }
                let inserted_prompt_count = inserted
                    .iter()
                    .filter(|message| message_rpc_id(message) == Some(prompt_rpc_id))
                    .count();
                if inserted_prompt_count > 1 {
                    return Err("DSH inbox 插入了多个相同 rpcId 的消息".into());
                }
                if inserted_prompt_count == 1 {
                    let replaces_prompt = removed_prompt_count == 1;
                    if !matches!(inbox_association, PromptTurnAssociation::Missing)
                        && !replaces_prompt
                    {
                        return Err("DSH inbox 重复插入提交说明请求".into());
                    }
                    inbox_association = PromptTurnAssociation::Pending;
                }
            }
            _ => {}
        }
    }

    if user_needs_earlier_context {
        return Ok(PromptTurnAssociation::NeedsEarlierContext);
    }
    match (inbox_association, user_turn) {
        (PromptTurnAssociation::Turn(inbox_turn), Some(user_turn)) => {
            if inbox_turn != user_turn {
                return Err("DSH inbox 与用户消息关联到不同回合".into());
            }
            Ok(PromptTurnAssociation::Turn(inbox_turn))
        }
        (PromptTurnAssociation::Turn(turn), None) => Ok(PromptTurnAssociation::Turn(turn)),
        (_, Some(turn)) => Ok(PromptTurnAssociation::Turn(turn)),
        (association, None) => Ok(association),
    }
}

fn validate_inbox_message(message: &Value) -> Result<(), String> {
    validate_identifier(
        "DSH inbox messageId",
        inbox_message_id(message)?,
        MAX_CHANGE_ID_BYTES,
    )
}

fn inbox_message_id(message: &Value) -> Result<&str, String> {
    message
        .as_object()
        .ok_or_else(|| "DSH inbox 消息不是对象".to_owned())?
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "DSH inbox 消息缺少 id".to_owned())
}

fn message_rpc_id(message: &Value) -> Option<&str> {
    message
        .get("source")
        .and_then(Value::as_object)
        .filter(|source| source.get("kind").and_then(Value::as_str) == Some("user"))
        .and_then(|source| source.get("rpcId"))
        .and_then(Value::as_str)
}

fn merge_history_pages(history_pages: &[Value]) -> Result<HistoryWindow, String> {
    if history_pages.len() > MAX_HISTORY_PAGES {
        return Err(format!(
            "DSH 历史分页数量超过上限（{MAX_HISTORY_PAGES} 页）"
        ));
    }
    let mut events = BTreeMap::<u64, HistoryEvent>::new();
    let mut total_bytes = 0_usize;
    let mut has_earlier_events = false;
    for (page_index, page) in history_pages.iter().enumerate() {
        let envelope = page.as_object().ok_or("DSH session.history 响应不是对象")?;
        if envelope.get("type").and_then(Value::as_str) != Some("server-response") {
            return Err("DSH session.history 响应类型无效".into());
        }
        let result = envelope
            .get("result")
            .and_then(Value::as_object)
            .ok_or("DSH session.history 响应缺少 result")?;
        match result.get("ok").and_then(Value::as_bool) {
            Some(true) => {}
            Some(false) => {
                let message = result
                    .get("error")
                    .and_then(Value::as_object)
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误");
                return Err(format!(
                    "DSH session.history 失败：{}",
                    truncate_utf8(message, MAX_MESSAGE_BYTES)
                ));
            }
            None => return Err("DSH session.history 响应缺少有效 ok 状态".into()),
        }
        let history = result
            .get("value")
            .and_then(Value::as_object)
            .ok_or("DSH session.history 响应缺少 value")?;
        let has_more = history
            .get("hasMore")
            .and_then(Value::as_bool)
            .ok_or("DSH session.history 响应缺少 hasMore")?;
        if page_index + 1 == history_pages.len() {
            has_earlier_events = has_more;
        }
        let page_events = history
            .get("events")
            .and_then(Value::as_array)
            .ok_or("DSH session.history 响应缺少 events")?;
        for wrapped_event in page_events {
            if events.len() >= MAX_HISTORY_EVENTS {
                return Err(format!(
                    "DSH 历史事件数量超过上限（{MAX_HISTORY_EVENTS} 条）"
                ));
            }
            let event = wrapped_event
                .get("event")
                .and_then(Value::as_object)
                .ok_or("DSH session.history 包含无效事件")?;
            let event_bytes = serde_json::to_vec(event)
                .map_err(|error| format!("无法检查 DSH 历史事件大小：{error}"))?
                .len();
            if event_bytes > MAX_HISTORY_EVENT_BYTES {
                return Err(format!(
                    "DSH 单条历史事件超过上限（{MAX_HISTORY_EVENT_BYTES} 字节）"
                ));
            }
            total_bytes = total_bytes
                .checked_add(event_bytes)
                .ok_or("DSH 历史事件总大小溢出")?;
            if total_bytes > MAX_HISTORY_BYTES {
                return Err(format!(
                    "DSH 历史事件总大小超过上限（{MAX_HISTORY_BYTES} 字节）"
                ));
            }
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .ok_or("DSH 历史事件缺少 type")?;
            if event_type.is_empty() || event_type.len() > MAX_EVENT_TYPE_BYTES {
                return Err("DSH 历史事件 type 无效".into());
            }
            let sequence = event
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or("DSH 历史事件缺少有效 seq")?;
            let normalized = HistoryEvent {
                sequence,
                event_type: event_type.to_owned(),
                data: event.get("data").cloned().unwrap_or(Value::Null),
            };
            match events.get(&sequence) {
                Some(existing) if existing != &normalized => {
                    return Err(format!("DSH 历史事件序号 {sequence} 存在冲突"));
                }
                Some(_) => {}
                None => {
                    events.insert(sequence, normalized);
                }
            }
        }
    }
    Ok(HistoryWindow {
        events: events.into_values().collect(),
        has_earlier_events,
        reached_session_start: !history_pages.is_empty() && !has_earlier_events,
    })
}

fn valid_turn_id(value: &Value) -> bool {
    matches!(value, Value::Number(_) | Value::String(_))
}

fn assistant_text_blocks(data: &Value) -> Result<Option<String>, String> {
    let Some(message) = data.get("message").and_then(Value::as_object) else {
        return Ok(None);
    };
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return Ok(None);
    }
    let Some(content) = message.get("content").and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let block_text = block
            .get("text")
            .and_then(Value::as_str)
            .ok_or("DSH assistant/message 包含无效文本块")?;
        let next_len = text
            .len()
            .checked_add(block_text.len())
            .ok_or("DSH 提交说明文本长度溢出")?;
        if next_len > MAX_HISTORY_EVENT_BYTES {
            return Err(format!(
                "DSH 提交说明候选文本超过上限（{MAX_HISTORY_EVENT_BYTES} 字节）"
            ));
        }
        text.push_str(block_text);
    }
    Ok((!text.trim().is_empty()).then_some(text))
}

fn normalize_commit_message(raw: &str) -> Result<String, String> {
    if raw.chars().any(|character| {
        character.is_control() && character != '\n' && character != '\r' && character != '\t'
    }) {
        return Err("智能体生成的提交说明包含不支持的控制字符".into());
    }
    let normalized_newlines = raw.replace("\r\n", "\n").replace('\r', "\n");
    let lines = normalized_newlines.lines().collect::<Vec<_>>();
    let Some(title_index) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return Err("智能体没有生成可用的提交说明".into());
    };
    let title = lines[title_index]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.len() > MAX_TITLE_BYTES {
        return Err(format!(
            "智能体生成的提交标题超过上限（{MAX_TITLE_BYTES} 字节）"
        ));
    }

    let body_lines = lines[title_index + 1..]
        .iter()
        .map(|line| line.trim_end())
        .collect::<Vec<_>>();
    let body_start = body_lines
        .iter()
        .position(|line| !line.trim().is_empty())
        .unwrap_or(body_lines.len());
    let body_end = body_lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map_or(body_start, |index| index + 1);
    let body_lines = &body_lines[body_start..body_end];
    let message = if body_lines.is_empty() {
        title
    } else {
        format!("{title}\n\n{}", body_lines.join("\n"))
    };
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!(
            "智能体生成的提交说明超过上限（{MAX_MESSAGE_BYTES} 字节）"
        ));
    }
    Ok(message)
}

fn turn_failure_message(reason_kind: &str, reason: &serde_json::Map<String, Value>) -> String {
    let detail = reason
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("message"))
        .or_else(|| reason.get("message"))
        .and_then(Value::as_str)
        .map(|message| truncate_utf8(message.trim(), MAX_MESSAGE_BYTES));
    if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
        return detail;
    }
    match reason_kind {
        "blocked" => "提交说明生成被阻塞".into(),
        "error" => "智能体生成提交说明失败".into(),
        "aborted" => "提交说明生成已取消".into(),
        "max-tokens" | "max_tokens" => "智能体输出达到上限，未生成可用的提交说明".into(),
        "interrupted" => "提交说明生成被中断".into(),
        kind => format!(
            "智能体未完成提交说明生成（{}）",
            truncate_utf8(kind, MAX_EVENT_TYPE_BYTES)
        ),
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

impl fmt::Debug for CommitProposalManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommitProposalManager")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::{Arc, Barrier},
        thread,
    };

    fn seed(prompt_rpc_id: &str) -> CommitProposalSeed {
        CommitProposalSeed {
            task_id: "task-1".into(),
            workspace_path: "/tmp/workspace".into(),
            snapshot_token: "snapshot-1".into(),
            accepted_change_ids: vec!["change-1".into(), "change-2".into()],
            additions: 12,
            deletions: 3,
            prompt_rpc_id: prompt_rpc_id.into(),
        }
    }

    fn event(event_type: &str, sequence: u64, data: Value) -> Value {
        json!({
            "event": {
                "type": event_type,
                "seq": sequence,
                "time": sequence * 10,
                "data": data,
            }
        })
    }

    fn page(events: Vec<Value>, has_more: bool) -> Value {
        json!({
            "type": "server-response",
            "rpcId": "history-rpc",
            "result": {
                "ok": true,
                "value": { "events": events, "hasMore": has_more },
            },
        })
    }

    fn prompt(sequence: u64, rpc_id: &str) -> Value {
        event(
            "user/message",
            sequence,
            json!({
                "content": [{ "type": "text", "text": "生成提交说明" }],
                "source": { "kind": "user", "rpcId": rpc_id },
                "role": "user",
            }),
        )
    }

    fn assistant(sequence: u64, turn: u64, blocks: Value) -> Value {
        event(
            "assistant/message",
            sequence,
            json!({
                "turn": turn,
                "step": 1,
                "message": {
                    "role": "assistant",
                    "content": blocks,
                },
            }),
        )
    }

    fn inbox_insert_at(sequence: u64, start: usize, rpc_id: &str) -> Value {
        event(
            "agent/inbox/spliced",
            sequence,
            json!({
                "target": "next-turn",
                "start": start,
                "inserted": [{
                    "id": format!("message-{sequence}"),
                    "role": "user",
                    "content": [{ "type": "text", "text": "生成提交说明" }],
                    "source": { "kind": "user", "rpcId": rpc_id },
                }],
            }),
        )
    }

    fn inbox_insert(sequence: u64, rpc_id: &str) -> Value {
        inbox_insert_at(sequence, 0, rpc_id)
    }

    fn inbox_remove_at(sequence: u64, start: usize, outcome: Option<&str>) -> Value {
        let mut data = json!({
            "target": "next-turn",
            "start": start,
            "removedCount": 1,
            "inserted": [],
        });
        if let Some(outcome) = outcome {
            data["outcome"] = Value::String(outcome.into());
        }
        event("agent/inbox/spliced", sequence, data)
    }

    fn inbox_remove(sequence: u64, outcome: Option<&str>) -> Value {
        inbox_remove_at(sequence, 0, outcome)
    }

    fn completed_history(rpc_id: &str, message: &str) -> Vec<Value> {
        vec![page(
            vec![
                event("turn/start", 1, json!({ "turn": 7 })),
                prompt(2, rpc_id),
                assistant(3, 7, json!([{ "type": "text", "text": message }])),
                event(
                    "turn/end",
                    4,
                    json!({ "turn": 7, "reason": { "kind": "completed" } }),
                ),
            ],
            false,
        )]
    }

    #[test]
    fn start_and_resolve_wire_contracts_are_stable() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert_eq!(
            serde_json::to_value(&started).unwrap(),
            json!({ "proposalId": started.proposal_id })
        );
        assert_eq!(
            serde_json::to_value(manager.resolve(&started.proposal_id).unwrap()).unwrap(),
            json!({ "status": "generating" })
        );
    }

    #[test]
    fn complete_turn_uses_last_non_empty_text_message_and_normalizes_it() {
        let pages = vec![page(
            vec![
                event("turn/start", 1, json!({ "turn": 7 })),
                prompt(2, "prompt-1"),
                assistant(3, 7, json!([{ "type": "text", "text": "draft" }])),
                assistant(4, 7, json!([{ "type": "reasoning", "text": "hidden" }])),
                assistant(
                    5,
                    7,
                    json!([
                        { "type": "text", "text": "  feat:   add commits  \r\n" },
                        { "type": "text", "text": "\r\nExplain the change.  \r\n" }
                    ]),
                ),
                event(
                    "turn/end",
                    6,
                    json!({ "turn": 7, "reason": { "kind": "completed" } }),
                ),
            ],
            false,
        )];

        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Ready {
                message: "feat: add commits\n\nExplain the change.".into(),
            }
        );
    }

    #[test]
    fn response_never_uses_a_later_turn() {
        let pages = vec![page(
            vec![
                event("turn/start", 1, json!({ "turn": 1 })),
                prompt(2, "prompt-1"),
                assistant(3, 1, json!([{ "type": "text", "text": "   " }])),
                event(
                    "turn/end",
                    4,
                    json!({ "turn": 1, "reason": { "kind": "completed" } }),
                ),
                event("turn/start", 5, json!({ "turn": 2 })),
                prompt(6, "another-prompt"),
                assistant(
                    7,
                    2,
                    json!([{ "type": "text", "text": "feat: wrong turn" }]),
                ),
                event(
                    "turn/end",
                    8,
                    json!({ "turn": 2, "reason": { "kind": "completed" } }),
                ),
            ],
            false,
        )];

        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Failed {
                message: "智能体没有生成可用的提交说明".into(),
            }
        );
    }

    #[test]
    fn open_or_not_yet_visible_turn_is_generating() {
        assert_eq!(
            resolve_commit_message(&[], "prompt-1").unwrap(),
            CommitMessageResolution::Generating
        );
        let pages = vec![page(
            vec![
                event("turn/start", 1, json!({ "turn": 1 })),
                prompt(2, "prompt-1"),
                assistant(3, 1, json!([{ "type": "text", "text": "feat: partial" }])),
            ],
            false,
        )];
        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Generating
        );
    }

    #[test]
    fn unsuccessful_turn_reasons_are_failed() {
        for (reason, expected) in [
            ("blocked", "提交说明生成被阻塞"),
            ("error", "智能体生成提交说明失败"),
            ("aborted", "提交说明生成已取消"),
            ("max-tokens", "智能体输出达到上限，未生成可用的提交说明"),
            ("interrupted", "提交说明生成被中断"),
        ] {
            let pages = vec![page(
                vec![
                    event("turn/start", 1, json!({ "turn": 1 })),
                    prompt(2, "prompt-1"),
                    assistant(3, 1, json!([{ "type": "text", "text": "feat: ignored" }])),
                    event(
                        "turn/end",
                        4,
                        json!({ "turn": 1, "reason": { "kind": reason } }),
                    ),
                ],
                false,
            )];
            assert_eq!(
                resolve_commit_message(&pages, "prompt-1").unwrap(),
                CommitMessageResolution::Failed {
                    message: expected.into(),
                }
            );
        }
    }

    #[test]
    fn pre_step_failure_is_correlated_through_the_durable_inbox() {
        let pages = vec![page(
            vec![
                inbox_insert(1, "prompt-1"),
                event("turn/start", 2, json!({ "turn": 7 })),
                inbox_remove(3, None),
                event(
                    "turn/end",
                    4,
                    json!({ "turn": 7, "reason": { "kind": "blocked" } }),
                ),
            ],
            false,
        )];

        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Failed {
                message: "提交说明生成被阻塞".into(),
            }
        );
    }

    #[test]
    fn a_cancelled_pending_prompt_is_not_left_generating_forever() {
        let pending = vec![page(vec![inbox_insert(1, "prompt-1")], false)];
        assert!(commit_history_has_sufficient_context(&pending, "prompt-1").unwrap());
        assert_eq!(
            resolve_commit_message(&pending, "prompt-1").unwrap(),
            CommitMessageResolution::Generating
        );

        let pages = vec![page(
            vec![
                inbox_insert(1, "prompt-1"),
                inbox_remove(2, Some("canceled")),
            ],
            false,
        )];

        assert!(commit_history_has_sufficient_context(&pages, "prompt-1").unwrap());
        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Failed {
                message: "提交说明生成已取消".into(),
            }
        );
    }

    #[test]
    fn pagination_is_merged_by_sequence_and_exact_duplicates_are_deduplicated() {
        let start = event("turn/start", 10, json!({ "turn": 4 }));
        let user = prompt(11, "prompt-1");
        let answer = assistant(
            12,
            4,
            json!([{ "type": "text", "text": "fix: page order" }]),
        );
        let end = event(
            "turn/end",
            13,
            json!({ "turn": 4, "reason": { "kind": "completed" } }),
        );
        let pages = vec![
            page(vec![answer, end], true),
            page(vec![start, user.clone(), user], false),
        ];

        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Ready {
                message: "fix: page order".into(),
            }
        );
    }

    #[test]
    fn pagination_waits_for_the_prompt_turn_start_from_an_older_page() {
        let recent_page = page(
            vec![
                prompt(11, "prompt-1"),
                assistant(
                    12,
                    4,
                    json!([{ "type": "text", "text": "fix: complete context" }]),
                ),
                event(
                    "turn/end",
                    13,
                    json!({ "turn": 4, "reason": { "kind": "completed" } }),
                ),
            ],
            true,
        );
        assert!(!commit_history_has_sufficient_context(
            std::slice::from_ref(&recent_page),
            "prompt-1"
        )
        .unwrap());

        let pages = vec![
            recent_page,
            page(vec![event("turn/start", 10, json!({ "turn": 4 }))], false),
        ];
        assert!(commit_history_has_sufficient_context(&pages, "prompt-1").unwrap());
        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Ready {
                message: "fix: complete context".into(),
            }
        );
    }

    #[test]
    fn partial_inbox_prefix_tracks_a_nonzero_prompt_insert_until_claim() {
        let pages = vec![page(
            vec![
                inbox_insert_at(10, 1, "prompt-1"),
                event("turn/start", 11, json!({ "turn": 6 })),
                inbox_remove_at(12, 0, None),
                event(
                    "turn/end",
                    13,
                    json!({ "turn": 6, "reason": { "kind": "completed" } }),
                ),
                event("turn/start", 14, json!({ "turn": 7 })),
                inbox_remove_at(15, 0, None),
                event(
                    "turn/end",
                    16,
                    json!({ "turn": 7, "reason": { "kind": "blocked" } }),
                ),
            ],
            true,
        )];

        assert!(commit_history_has_sufficient_context(&pages, "prompt-1").unwrap());
        assert_eq!(
            resolve_commit_message(&pages, "prompt-1").unwrap(),
            CommitMessageResolution::Failed {
                message: "提交说明生成被阻塞".into(),
            }
        );
    }

    #[test]
    fn missing_prompt_identity_fails_only_after_the_complete_history_is_visible() {
        let partial = vec![page(
            vec![
                event("turn/start", 1, json!({ "turn": 7 })),
                prompt(2, "prompt-10"),
            ],
            true,
        )];
        assert_eq!(
            resolve_commit_message(&partial, "prompt-1").unwrap(),
            CommitMessageResolution::Generating
        );

        let complete = completed_history("prompt-10", "feat: unrelated");
        assert_eq!(
            resolve_commit_message(&complete, "prompt-1").unwrap(),
            CommitMessageResolution::Failed {
                message: "DSH 完整历史中不存在提交说明请求".into(),
            }
        );
    }

    #[test]
    fn manager_transitions_ready_committing_completed_once() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        let ready = manager
            .mark_ready(
                &started.proposal_id,
                &completed_history("prompt-1", "feat: commit flow"),
            )
            .unwrap();
        let ResolveCommitProposalResponse::Ready { proposal } = ready else {
            panic!("expected ready proposal");
        };
        assert_eq!(proposal.message, "feat: commit flow");
        assert_eq!(proposal.accepted_change_ids, ["change-1", "change-2"]);

        let consumed = manager.begin_commit(&started.proposal_id).unwrap();
        assert_eq!(consumed, proposal);
        assert!(manager
            .begin_commit(&started.proposal_id)
            .unwrap_err()
            .contains("不能重复使用"));
        assert_eq!(
            manager
                .finish_commit(&started.proposal_id, "abc123".into())
                .unwrap(),
            ResolveCommitProposalResponse::Completed {
                revision: "abc123".into(),
            }
        );
        assert_eq!(
            serde_json::to_value(manager.resolve(&started.proposal_id).unwrap()).unwrap(),
            json!({ "status": "completed", "revision": "abc123" })
        );
    }

    #[test]
    fn history_resolution_is_single_flight_and_transport_failure_releases_the_leader() {
        let manager = Arc::new(CommitProposalManager::new());
        let started = manager.start(seed("prompt-1")).unwrap();
        let barrier = Arc::new(Barrier::new(9));
        let attempts = (0..8)
            .map(|_| {
                let manager = Arc::clone(&manager);
                let barrier = Arc::clone(&barrier);
                let proposal_id = started.proposal_id.clone();
                thread::spawn(move || {
                    barrier.wait();
                    manager.begin_history_resolution(&proposal_id)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|is_leader| **is_leader).count(), 1);
        assert_eq!(
            manager.resolve(&started.proposal_id).unwrap(),
            ResolveCommitProposalResponse::Generating
        );

        assert_eq!(
            manager
                .release_history_resolution(&started.proposal_id)
                .unwrap(),
            ResolveCommitProposalResponse::Generating
        );
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
    }

    #[test]
    fn incomplete_history_releases_the_leader_for_a_later_poll() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        assert_eq!(
            manager.mark_ready(&started.proposal_id, &[]).unwrap(),
            ResolveCommitProposalResponse::Generating
        );
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
    }

    #[test]
    fn history_fetch_failure_is_sanitized_and_persisted_as_terminal() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        let unsafe_message = format!("\0{}\u{7}", "失败".repeat(MAX_MESSAGE_BYTES));

        let failed = manager
            .fail_history_resolution(&started.proposal_id, unsafe_message)
            .unwrap();
        let ResolveCommitProposalResponse::Failed { message } = &failed else {
            panic!("history failure should be terminal");
        };
        assert!(message.len() <= MAX_MESSAGE_BYTES);
        assert!(!message.chars().any(char::is_control));
        assert_eq!(manager.resolve(&started.proposal_id).unwrap(), failed);
    }

    #[test]
    fn history_fetch_failure_is_idempotent_after_a_terminal_failure() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        let first = manager
            .fail_history_resolution(&started.proposal_id, "历史协议无效".into())
            .unwrap();

        assert_eq!(
            manager
                .fail_history_resolution(&started.proposal_id, "迟到的不同错误".into())
                .unwrap(),
            first
        );
    }

    #[test]
    fn history_fetch_failure_rejects_a_non_leader_without_changing_state() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();

        assert!(manager
            .fail_history_resolution(&started.proposal_id, "迟到的错误".into())
            .unwrap_err()
            .contains("历史解析 leader"));
        assert_eq!(
            manager.resolve(&started.proposal_id).unwrap(),
            ResolveCommitProposalResponse::Generating
        );
    }

    #[test]
    fn begin_commit_is_one_shot_under_concurrency() {
        let manager = Arc::new(CommitProposalManager::new());
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        manager
            .mark_ready(
                &started.proposal_id,
                &completed_history("prompt-1", "feat: only once"),
            )
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let attempts = (0..2)
            .map(|_| {
                let manager = Arc::clone(&manager);
                let barrier = Arc::clone(&barrier);
                let proposal_id = started.proposal_id.clone();
                thread::spawn(move || {
                    barrier.wait();
                    manager.begin_commit(&proposal_id)
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    }

    #[test]
    fn abort_and_invalidate_are_terminal_failures() {
        let manager = CommitProposalManager::new();
        let invalid = manager.start(seed("prompt-invalid")).unwrap();
        assert_eq!(
            manager
                .invalidate(&invalid.proposal_id, "快照已经变化".into())
                .unwrap(),
            ResolveCommitProposalResponse::Failed {
                message: "快照已经变化".into(),
            }
        );

        let abort = manager.start(seed("prompt-abort")).unwrap();
        assert!(manager
            .begin_history_resolution(&abort.proposal_id)
            .unwrap());
        manager
            .mark_ready(
                &abort.proposal_id,
                &completed_history("prompt-abort", "fix: abort"),
            )
            .unwrap();
        manager.begin_commit(&abort.proposal_id).unwrap();
        assert_eq!(
            manager
                .abort_commit(&abort.proposal_id, "Git 提交失败".into())
                .unwrap(),
            ResolveCommitProposalResponse::Failed {
                message: "Git 提交失败".into(),
            }
        );
    }

    #[test]
    fn invalidation_message_is_sanitized_without_blocking_the_transition() {
        let manager = CommitProposalManager::new();
        let invalid = manager.start(seed("prompt-invalid")).unwrap();
        let oversized = format!("\0{}\u{7}", "错误".repeat(MAX_MESSAGE_BYTES));
        let invalidated = manager.invalidate(&invalid.proposal_id, oversized).unwrap();
        let ResolveCommitProposalResponse::Failed { message } = invalidated else {
            panic!("invalidated proposal should be terminal");
        };
        assert!(message.len() <= MAX_MESSAGE_BYTES);
        assert!(!message.chars().any(char::is_control));
    }

    #[test]
    fn abort_message_is_sanitized_without_blocking_the_transition() {
        let manager = CommitProposalManager::new();
        let abort = manager.start(seed("prompt-abort")).unwrap();
        assert!(manager
            .begin_history_resolution(&abort.proposal_id)
            .unwrap());
        manager
            .mark_ready(
                &abort.proposal_id,
                &completed_history("prompt-abort", "fix: abort"),
            )
            .unwrap();
        manager.begin_commit(&abort.proposal_id).unwrap();
        assert_eq!(
            manager.abort_commit(&abort.proposal_id, "\0\u{7}".into()),
            Ok(ResolveCommitProposalResponse::Failed {
                message: "提交失败".into(),
            })
        );
    }

    #[test]
    fn completion_state_is_sanitized_without_blocking_the_transition() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-complete")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        manager
            .mark_ready(
                &started.proposal_id,
                &completed_history("prompt-complete", "fix: complete"),
            )
            .unwrap();
        manager.begin_commit(&started.proposal_id).unwrap();

        let unsafe_revision = format!("\0{}\u{7}", "界".repeat(MAX_REVISION_BYTES));
        let completed = manager
            .finish_commit(&started.proposal_id, unsafe_revision)
            .unwrap();
        let ResolveCommitProposalResponse::Completed { revision } = &completed else {
            panic!("completed proposal should stay terminal");
        };
        assert!(revision.len() <= MAX_REVISION_BYTES);
        assert!(!revision.chars().any(char::is_control));
        assert_eq!(manager.resolve(&started.proposal_id).unwrap(), completed);
    }

    #[test]
    fn seed_limits_and_duplicate_change_ids_are_rejected() {
        let manager = CommitProposalManager::new();
        let mut duplicate = seed("prompt-1");
        duplicate.accepted_change_ids = vec!["same".into(), "same".into()];
        assert!(manager.start(duplicate).unwrap_err().contains("不能重复"));

        let mut oversized = seed("prompt-2");
        oversized.task_id = "x".repeat(MAX_TASK_ID_BYTES + 1);
        assert!(manager.start(oversized).unwrap_err().contains("长度上限"));
    }

    #[test]
    fn expired_entries_are_evicted_before_enforcing_capacity() {
        let manager = CommitProposalManager::new();
        for index in 0..MAX_PROPOSALS {
            manager.start(seed(&format!("prompt-{index}"))).unwrap();
        }
        assert!(manager.start(seed("overflow")).is_err());
        {
            let mut proposals = manager.0.lock().unwrap();
            let entry = proposals.values_mut().next().unwrap();
            entry.updated_at = Instant::now()
                .checked_sub(PROPOSAL_TTL + Duration::from_secs(1))
                .unwrap();
        }
        assert!(manager.start(seed("after-expiry")).is_ok());
    }

    #[test]
    fn committing_entries_survive_ttl_until_the_transaction_finishes() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("slow-commit")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        manager
            .mark_ready(
                &started.proposal_id,
                &completed_history("slow-commit", "feat: slow commit"),
            )
            .unwrap();
        manager.begin_commit(&started.proposal_id).unwrap();
        {
            let mut proposals = manager.0.lock().unwrap();
            proposals.get_mut(&started.proposal_id).unwrap().updated_at = Instant::now()
                .checked_sub(PROPOSAL_TTL + Duration::from_secs(1))
                .unwrap();
        }

        assert_eq!(
            manager.resolve(&started.proposal_id).unwrap(),
            ResolveCommitProposalResponse::Generating
        );
        assert_eq!(
            manager
                .finish_commit(&started.proposal_id, "abc123".into())
                .unwrap(),
            ResolveCommitProposalResponse::Completed {
                revision: "abc123".into()
            }
        );
    }

    #[test]
    fn terminal_entries_are_reclaimed_when_capacity_is_full() {
        let manager = CommitProposalManager::new();
        let mut proposal_ids = Vec::new();
        for index in 0..MAX_PROPOSALS {
            proposal_ids.push(
                manager
                    .start(seed(&format!("prompt-{index}")))
                    .unwrap()
                    .proposal_id,
            );
        }
        manager
            .invalidate(&proposal_ids[0], "已失效".into())
            .unwrap();

        assert!(manager.start(seed("replacement")).is_ok());
        assert!(manager.resolve(&proposal_ids[0]).is_err());
    }

    #[test]
    fn oversized_or_empty_generated_messages_fail_closed() {
        assert!(normalize_commit_message(" \n\t ").is_err());
        assert!(
            normalize_commit_message(&format!("title\n\n{}", "x".repeat(MAX_MESSAGE_BYTES)))
                .is_err()
        );
        assert!(
            normalize_commit_message(&format!("{}\nbody", "x".repeat(MAX_TITLE_BYTES + 1)))
                .is_err()
        );
    }

    #[test]
    fn malformed_or_conflicting_history_fails_closed() {
        let conflicting = vec![page(
            vec![
                event("turn/start", 1, json!({ "turn": 1 })),
                event("turn/start", 1, json!({ "turn": 2 })),
            ],
            false,
        )];
        assert!(merge_history_pages(&conflicting)
            .unwrap_err()
            .contains("存在冲突"));

        let wrong_envelope = vec![json!({ "type": "server-request" })];
        assert!(merge_history_pages(&wrong_envelope)
            .unwrap_err()
            .contains("响应类型无效"));
    }

    #[test]
    fn malformed_inbox_history_still_fails_closed() {
        let out_of_bounds = vec![page(vec![inbox_insert_at(1, 1, "prompt-1")], false)];
        assert!(resolve_commit_message(&out_of_bounds, "prompt-1")
            .unwrap_err()
            .contains("超出 inbox 边界"));

        let duplicate = vec![page(
            vec![
                inbox_insert_at(1, 0, "prompt-1"),
                inbox_insert_at(2, 1, "prompt-1"),
            ],
            false,
        )];
        assert!(resolve_commit_message(&duplicate, "prompt-1")
            .unwrap_err()
            .contains("重复插入"));
    }

    #[test]
    fn malformed_history_stops_pagination_and_becomes_a_terminal_failure() {
        let malformed = vec![page(
            vec![json!({ "event": { "seq": 1, "data": null } })],
            true,
        )];
        assert!(commit_history_has_sufficient_context(&malformed, "prompt-1").unwrap());

        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        let failed = manager
            .mark_ready(&started.proposal_id, &malformed)
            .unwrap();
        assert!(matches!(
            failed,
            ResolveCommitProposalResponse::Failed { .. }
        ));
        assert_eq!(manager.resolve(&started.proposal_id).unwrap(), failed);
    }

    #[test]
    fn oversized_history_event_stops_pagination_and_becomes_a_terminal_failure() {
        let oversized = vec![page(
            vec![event(
                "assistant/message",
                1,
                json!({ "payload": "x".repeat(MAX_HISTORY_EVENT_BYTES + 1) }),
            )],
            true,
        )];
        assert!(commit_history_has_sufficient_context(&oversized, "prompt-1").unwrap());

        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        let failed = manager
            .mark_ready(&started.proposal_id, &oversized)
            .unwrap();
        let ResolveCommitProposalResponse::Failed { message } = &failed else {
            panic!("oversized history should be terminal");
        };
        assert!(message.contains("单条历史事件超过上限"));
        assert_eq!(manager.resolve(&started.proposal_id).unwrap(), failed);
    }

    #[test]
    fn manager_persists_history_parse_failures_as_terminal_failures() {
        let manager = CommitProposalManager::new();
        let started = manager.start(seed("prompt-1")).unwrap();
        let malformed = vec![json!({ "type": "server-request" })];

        assert!(manager
            .begin_history_resolution(&started.proposal_id)
            .unwrap());
        let failed = manager
            .mark_ready(&started.proposal_id, &malformed)
            .unwrap();
        let ResolveCommitProposalResponse::Failed { message } = &failed else {
            panic!("expected failed proposal, got {failed:?}");
        };
        assert!(message.contains("响应类型无效"));
        assert_eq!(manager.resolve(&started.proposal_id).unwrap(), failed);
    }
}
