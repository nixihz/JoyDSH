export type RuntimeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface RuntimeHealth {
  state: RuntimeConnectionState
  version: string
  capabilities: readonly string[]
}

export interface TaskSession {
  id: string
  title?: string
  workspacePath?: string
  running: boolean
  blank: boolean
  updatedAt: number
}

export type TaskPermissionMode = 'standard' | 'full-access'

export interface TaskApproval {
  requestId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export type TaskApprovalOutcome = 'allowed-once' | 'rejected'

export interface TaskQuestionOption {
  label: string
  description?: string
}

export interface TaskQuestionIntent {
  kind: 'plan-review'
  approve: string
}

export interface TaskQuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: readonly TaskQuestionOption[]
  multiSelect?: boolean
  intent?: TaskQuestionIntent
}

export interface TaskQuestionRequest {
  requestId: string
  questions: readonly TaskQuestionItem[]
}

export interface TaskPlanReview {
  requestId: string
  id: string
  question: string
  plan: string
  approve: TaskQuestionOption
  decline?: TaskQuestionOption
}

export interface TaskQuestionAnswerItem {
  id: string
  selected: readonly string[]
  custom?: string
}

export interface TaskQuestionAnswer {
  answers: readonly TaskQuestionAnswerItem[]
}

export type TaskEventKind = 'session' | 'host' | 'control' | 'error'

export interface TaskEvent {
  id: string
  taskId?: string
  kind: TaskEventKind
  type: string
  sequence?: number
  time: number
  data: unknown
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface ImageAttachmentInput {
  id: string
  mediaType: ImageMediaType
  /** Base64 encoded image data (raw or data URL) */
  data: string
  name?: string | undefined
  size?: number | undefined
}

export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string | undefined
  originalDimensions?: {
    width: number
    height: number
  } | undefined
}

export interface MessageImageItem {
  id: string
  attachmentId?: string | undefined
  dataUrl?: string | undefined
  mediaType?: ImageMediaType | undefined
  name?: string | undefined
  width?: number | undefined
  height?: number | undefined
  bytes?: number | undefined
}

/** A task-scoped, opaque boundary token understood by the workspace provider. */
export interface TaskArtifactBaseline {
  version: string
  capturedAt: number
}

export type TaskFileChangeKind =
  | 'created'
  | 'modified'
  | 'deleted'
  | 'moved'
  | 'copied'
  | 'type-changed'
  | 'conflicted'

export type TaskFileReviewState = 'pending' | 'accepted'

export type TextDiffLineKind = 'context' | 'added' | 'removed' | 'note'

export interface TextDiffLine {
  kind: TextDiffLineKind
  content: string
  beforeLine?: number
  afterLine?: number
}

export interface TextDiffRange {
  start: number
  lines: number
}

export interface TextDiffHunk {
  before: TextDiffRange
  after: TextDiffRange
  heading: string
  lines: readonly TextDiffLine[]
}

export interface TextFileDiff {
  kind: 'text'
  additions: number
  deletions: number
  hunks: readonly TextDiffHunk[]
}

export interface BinaryFileDiff {
  kind: 'binary'
}

export interface TooLargeFileDiff {
  kind: 'too-large'
  limitBytes: number
}

export type FileDiffUnavailableReason =
  | 'conflicted'
  | 'missing'
  | 'unsupported'
  | 'inspection-failed'

export interface UnavailableFileDiff {
  kind: 'unavailable'
  reason: FileDiffUnavailableReason
  message: string
}

export type FileDiff = TextFileDiff | BinaryFileDiff | TooLargeFileDiff | UnavailableFileDiff

export interface TaskFileChange {
  /** Stable within the task boundary and opaque to domain consumers. */
  changeId: string
  path: string
  previousPath?: string
  kind: TaskFileChangeKind
  review: TaskFileReviewState
  diff: FileDiff
}

export type ArtifactMutationBlockedReason =
  | 'task-running'
  | 'head-advanced'
  | 'conflicted'
  | 'unsupported'

export interface ReadyArtifactMutationAvailability {
  availability: 'ready'
}

export interface BlockedArtifactMutationAvailability {
  availability: 'blocked'
  reason: ArtifactMutationBlockedReason
  message: string
}

export type ArtifactMutationAvailability =
  | ReadyArtifactMutationAvailability
  | BlockedArtifactMutationAvailability

export type TaskArtifactUnavailableReason =
  | 'workspace-unavailable'
  | 'unsupported-workspace'
  | 'invalid-baseline'
  | 'baseline-missing'
  | 'baseline-mismatch'
  | 'workspace-changed'
  | 'inspection-failed'

interface TaskArtifactSnapshotBase {
  taskId: string
  workspacePath: string
  inspectedAt: number
  changes: readonly TaskFileChange[]
}

export interface ReadyTaskArtifactSnapshot extends TaskArtifactSnapshotBase {
  availability: 'ready'
  baseline: TaskArtifactBaseline
  /** Opaque concurrency token required by every operation that changes task artifacts. */
  snapshotToken: string
  mutation: ArtifactMutationAvailability
  currentVersion?: string
  clean: boolean
  additions: number
  deletions: number
}

export interface UnavailableTaskArtifactSnapshot extends TaskArtifactSnapshotBase {
  availability: 'unavailable'
  baseline?: TaskArtifactBaseline
  reason: TaskArtifactUnavailableReason
  message: string
}

export type TaskArtifactSnapshot = ReadyTaskArtifactSnapshot | UnavailableTaskArtifactSnapshot

export type FileReviewAction = 'accept' | 'reject'

export interface ArtifactMutationResult {
  affectedChangeIds: readonly string[]
  latestSnapshot: ReadyTaskArtifactSnapshot
}

/** The exact reviewed task snapshot and generated message selected for a commit. */
export interface TaskCommitContext {
  taskId: string
  workspacePath: string
  snapshotToken: string
  acceptedChangeIds: readonly string[]
  additions: number
  deletions: number
  message: string
}

export interface TaskCommitResult {
  revision: string
  message: string
  committedAt: number
  committedChangeIds: readonly string[]
  latestSnapshot: ReadyTaskArtifactSnapshot
}

export type RefreshableArtifactOperationErrorCode =
  | 'stale-snapshot'
  | 'head-advanced'
  | 'repository-busy'
  | 'conflicted'
  | 'change-not-found'
  | 'unreviewed-changes'
  | 'nothing-to-commit'

export interface RefreshableArtifactOperationError {
  code: RefreshableArtifactOperationErrorCode
  message: string
  latestSnapshot: TaskArtifactSnapshot
}

export type FailedArtifactOperationErrorCode = 'unsupported' | 'operation-failed'

export interface FailedArtifactOperationError {
  code: FailedArtifactOperationErrorCode
  message: string
  latestSnapshot?: TaskArtifactSnapshot
}

export type ArtifactOperationError =
  | RefreshableArtifactOperationError
  | FailedArtifactOperationError
