import type {
  ArtifactMutationResult,
  ArtifactMutationAvailability,
  ArtifactOperationError,
  FileDiff,
  FileDiffUnavailableReason,
  FileReviewAction,
  TaskArtifactBaseline,
  TaskArtifactSnapshot,
  TaskArtifactUnavailableReason,
  TaskFileChange,
  TaskFileChangeKind,
  TaskFileReviewState,
  TextDiffLineKind,
} from '@joydsh/domain'
import { isTauri } from './runtime-control.ts'

interface RawTaskBaseline {
  repositoryRoot: string
  revision: string
  capturedAt: number
}

type RawFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unmerged'
  | 'untracked'

type RawDiffLineKind = 'context' | 'addition' | 'deletion' | 'no-newline-marker'

interface RawDiffLine {
  kind: RawDiffLineKind
  content: string
  oldLine?: number
  newLine?: number
}

interface RawDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  heading: string
  lines: RawDiffLine[]
}

type RawFileDiff =
  | { kind: 'text'; additions: number; deletions: number; hunks: RawDiffHunk[] }
  | { kind: 'binary' }
  | { kind: 'too-large'; maxBytes: number }
  | { kind: 'unavailable'; reason: string }

interface RawFileChange {
  changeId: string
  review: TaskFileReviewState
  path: string
  previousPath?: string
  status: RawFileStatus
  similarity?: number
  diff: RawFileDiff
}

interface RawWorktreeInspection {
  repositoryRoot: string
  baselineRevision: string
  headRevision?: string
  clean: boolean
  changes: RawFileChange[]
}

interface RawTaskArtifactInspection {
  baseline: RawTaskBaseline
  snapshotToken: string
  mutation: ArtifactMutationAvailability
  inspection: RawWorktreeInspection
}

interface RawArtifactMutationResult {
  affectedChangeIds: string[]
  latestSnapshot: RawTaskArtifactInspection
}

interface RawArtifactOperationError {
  code: ArtifactOperationError['code']
  message: string
  latestSnapshot?: RawTaskArtifactInspection
}

export interface TaskCommitProposal {
  proposalId: string
  message: string
  taskId?: string
  workspacePath?: string
  snapshotToken?: string
  acceptedChangeIds?: readonly string[]
  additions?: number
  deletions?: number
}

export type TaskCommitProposalResolution =
  | { status: 'generating' }
  | { status: 'ready'; proposal: TaskCommitProposal }
  | { status: 'failed'; message: string; latestSnapshot?: TaskArtifactSnapshot }
  | { status: 'completed'; revision: string }

export interface TaskArtifactCommitResult {
  revision: string
  warning?: string
  latestSnapshot?: TaskArtifactSnapshot
}

interface ArtifactOperationContext {
  taskId: string
  workspacePath: string
}

const ARTIFACT_OPERATION_ERROR_CODES = new Set<ArtifactOperationError['code']>([
  'stale-snapshot',
  'head-advanced',
  'repository-busy',
  'conflicted',
  'change-not-found',
  'unreviewed-changes',
  'nothing-to-commit',
  'unsupported',
  'operation-failed',
])

export class ArtifactOperationException extends Error {
  readonly code: ArtifactOperationError['code']
  readonly latestSnapshot?: TaskArtifactSnapshot

  constructor(
    code: ArtifactOperationError['code'],
    message: string,
    latestSnapshot?: TaskArtifactSnapshot,
  ) {
    super(message)
    this.name = 'ArtifactOperationException'
    this.code = code
    if (latestSnapshot !== undefined) this.latestSnapshot = latestSnapshot
  }
}

export async function ensureTaskArtifactBaseline(
  taskId: string,
  workspacePath: string,
): Promise<TaskArtifactBaseline> {
  if (!isTauri()) throw new Error('任务成果检查需要在 JoyDSH 桌面应用中使用')
  const { invoke } = await import('@tauri-apps/api/core')
  const baseline = await invoke<RawTaskBaseline>('ensure_task_artifact_baseline', {
    taskId,
    workspacePath,
  })
  return mapBaseline(baseline)
}

export async function inspectTaskArtifacts(
  taskId: string,
  workspacePath: string,
): Promise<TaskArtifactSnapshot> {
  const inspectedAt = Date.now()
  if (!isTauri()) {
    return unavailableSnapshot(
      taskId,
      workspacePath,
      inspectedAt,
      'unsupported-workspace',
      '任务成果检查需要在 JoyDSH 桌面应用中使用',
    )
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<RawTaskArtifactInspection>('inspect_task_artifacts', {
      taskId,
      workspacePath,
    })
    return mapInspection(taskId, workspacePath, inspectedAt, result)
  } catch (cause) {
    const message = errorMessage(cause)
    return unavailableSnapshot(
      taskId,
      workspacePath,
      inspectedAt,
      artifactUnavailableReason(message),
      message,
    )
  }
}

export async function reviewTaskArtifactFile(
  taskId: string,
  workspacePath: string,
  snapshotToken: string,
  changeId: string,
  action: FileReviewAction,
): Promise<ArtifactMutationResult> {
  if (!isTauri()) throw new ArtifactOperationException('unsupported', '任务成果评审需要在 JoyDSH 桌面应用中使用')
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<RawArtifactMutationResult>('review_task_artifact_file', {
      taskId,
      workspacePath,
      snapshotToken,
      changeId,
      action,
    })
    return mapMutationResult(taskId, workspacePath, result)
  } catch (cause) {
    throw mapArtifactOperationFailure(cause, taskId, workspacePath, Date.now())
  }
}

export async function rollbackTaskArtifacts(
  taskId: string,
  workspacePath: string,
  snapshotToken: string,
): Promise<ArtifactMutationResult> {
  if (!isTauri()) throw new ArtifactOperationException('unsupported', '任务成果回滚需要在 JoyDSH 桌面应用中使用')
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<RawArtifactMutationResult>('rollback_task_artifacts', {
      taskId,
      workspacePath,
      snapshotToken,
    })
    return mapMutationResult(taskId, workspacePath, result)
  } catch (cause) {
    throw mapArtifactOperationFailure(cause, taskId, workspacePath, Date.now())
  }
}

export async function requestTaskCommitProposal(
  taskId: string,
  workspacePath: string,
  snapshotToken: string,
): Promise<{ proposalId: string }> {
  if (!isTauri()) throw new ArtifactOperationException('unsupported', '任务成果提交需要在 JoyDSH 桌面应用中使用')
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<unknown>('request_task_commit_proposal', {
      taskId,
      workspacePath,
      snapshotToken,
    })
    const value = recordValue(result)
    if (value === undefined || typeof value.proposalId !== 'string' || value.proposalId === '') {
      throw invalidCommitResponse('提交说明提案没有返回有效标识')
    }
    return { proposalId: value.proposalId }
  } catch (cause) {
    if (cause instanceof ArtifactOperationException) throw cause
    throw mapArtifactOperationFailure(cause, taskId, workspacePath, Date.now())
  }
}

export async function resolveTaskCommitProposal(
  proposalId: string,
  context: ArtifactOperationContext,
): Promise<TaskCommitProposalResolution> {
  if (!isTauri()) throw new ArtifactOperationException('unsupported', '任务成果提交需要在 JoyDSH 桌面应用中使用')
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<unknown>('resolve_task_commit_proposal', { proposalId })
    return mapTaskCommitProposalResolution(result, context)
  } catch (cause) {
    if (cause instanceof ArtifactOperationException) throw cause
    throw mapArtifactOperationFailure(cause, context.taskId, context.workspacePath, Date.now())
  }
}

export async function commitTaskArtifacts(
  proposalId: string,
  message: string,
  context: ArtifactOperationContext,
): Promise<TaskArtifactCommitResult> {
  if (!isTauri()) throw new ArtifactOperationException('unsupported', '任务成果提交需要在 JoyDSH 桌面应用中使用')
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<unknown>('commit_task_artifacts', { proposalId, message })
    return mapTaskArtifactCommitResult(result, context)
  } catch (cause) {
    if (cause instanceof ArtifactOperationException) throw cause
    throw mapArtifactOperationFailure(cause, context.taskId, context.workspacePath, Date.now())
  }
}

export function mapTaskCommitProposalResolution(
  result: unknown,
  context?: ArtifactOperationContext,
): TaskCommitProposalResolution {
  const value = recordValue(result)
  if (value === undefined || typeof value.status !== 'string') {
    throw invalidCommitResponse('提交说明提案返回格式无效')
  }
  switch (value.status) {
    case 'generating':
      return { status: 'generating' }
    case 'ready': {
      const proposalValue = recordValue(value.proposal) ?? value
      return { status: 'ready', proposal: mapTaskCommitProposal(proposalValue) }
    }
    case 'failed': {
      if (typeof value.message !== 'string' || value.message.trim() === '') {
        throw invalidCommitResponse('提交说明提案失败但没有返回原因')
      }
      const latestSnapshot = mapOptionalLatestSnapshot(value.latestSnapshot, context)
      return {
        status: 'failed',
        message: value.message,
        ...(latestSnapshot === undefined ? {} : { latestSnapshot }),
      }
    }
    case 'completed':
      return { status: 'completed', revision: requiredRevision(value.revision) }
    default:
      throw invalidCommitResponse(`未知的提交说明提案状态：${value.status}`)
  }
}

export function mapTaskArtifactCommitResult(
  result: unknown,
  context?: ArtifactOperationContext,
): TaskArtifactCommitResult {
  const value = recordValue(result)
  if (value === undefined || (value.status !== undefined && value.status !== 'completed')) {
    throw invalidCommitResponse('提交成果没有返回完成状态')
  }
  const latestSnapshot = mapOptionalLatestSnapshot(value.latestSnapshot, context)
  const warning = value.warning
  if (warning !== undefined && (typeof warning !== 'string' || warning.trim() === '')) {
    throw invalidCommitResponse('提交成果警告格式无效')
  }
  return {
    revision: requiredRevision(value.revision),
    ...(typeof warning === 'string' ? { warning: warning.trim() } : {}),
    ...(latestSnapshot === undefined ? {} : { latestSnapshot }),
  }
}

export function mapInspection(
  taskId: string,
  workspacePath: string,
  inspectedAt: number,
  result: RawTaskArtifactInspection,
): TaskArtifactSnapshot {
  const { inspection } = result
  const changes = inspection.changes.map(mapFileChange)
  let additions = 0
  let deletions = 0
  for (const change of changes) {
    if (change.diff.kind !== 'text') continue
    additions += change.diff.additions
    deletions += change.diff.deletions
  }
  return {
    availability: 'ready',
    taskId,
    workspacePath,
    baseline: mapBaseline(result.baseline),
    snapshotToken: result.snapshotToken,
    mutation: result.mutation,
    inspectedAt,
    ...(inspection.headRevision === undefined ? {} : { currentVersion: inspection.headRevision }),
    clean: inspection.clean,
    additions,
    deletions,
    changes,
  }
}

export function artifactUnavailableReason(message: string): TaskArtifactUnavailableReason {
  if (message.includes('没有本地成果基线')) return 'baseline-missing'
  if (message.includes('路径不可用') || message.includes('不是目录')) return 'workspace-unavailable'
  if (message.includes('不是 Git 工作区') || message.includes('无法运行 Git')) return 'unsupported-workspace'
  if (message.includes('属于其他 Git 工作区') || message.includes('绑定到另一个 Git 工作区')) return 'baseline-mismatch'
  if (message.includes('HEAD 发生变化') || message.includes('检查变更期间 Git 工作区发生变化')) return 'workspace-changed'
  if (message.includes('Git 基线无效') || message.includes('未提交变更')) return 'invalid-baseline'
  return 'inspection-failed'
}

function mapBaseline(baseline: RawTaskBaseline): TaskArtifactBaseline {
  return {
    version: baseline.revision,
    capturedAt: baseline.capturedAt,
  }
}

function mapFileChange(change: RawFileChange): TaskFileChange {
  return {
    changeId: change.changeId,
    path: change.path,
    ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
    kind: mapFileChangeKind(change.status),
    review: change.review,
    diff: mapFileDiff(change.diff, change.status),
  }
}

function mapFileChangeKind(status: RawFileStatus): TaskFileChangeKind {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'created'
    case 'modified':
      return 'modified'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'moved'
    case 'copied':
      return 'copied'
    case 'type-changed':
      return 'type-changed'
    case 'unmerged':
      return 'conflicted'
  }
}

function mapFileDiff(diff: RawFileDiff, status: RawFileStatus): FileDiff {
  switch (diff.kind) {
    case 'text':
      return {
        kind: 'text',
        additions: diff.additions,
        deletions: diff.deletions,
        hunks: diff.hunks.map(hunk => ({
          before: { start: hunk.oldStart, lines: hunk.oldLines },
          after: { start: hunk.newStart, lines: hunk.newLines },
          heading: hunk.heading,
          lines: hunk.lines.map(line => ({
            kind: mapDiffLineKind(line.kind),
            content: line.content,
            ...(line.oldLine === undefined ? {} : { beforeLine: line.oldLine }),
            ...(line.newLine === undefined ? {} : { afterLine: line.newLine }),
          })),
        })),
      }
    case 'binary':
      return { kind: 'binary' }
    case 'too-large':
      return { kind: 'too-large', limitBytes: diff.maxBytes }
    case 'unavailable':
      return {
        kind: 'unavailable',
        reason: fileDiffUnavailableReason(status, diff.reason),
        message: diff.reason,
      }
  }
}

function mapDiffLineKind(kind: RawDiffLineKind): TextDiffLineKind {
  switch (kind) {
    case 'context': return 'context'
    case 'addition': return 'added'
    case 'deletion': return 'removed'
    case 'no-newline-marker': return 'note'
  }
}

function fileDiffUnavailableReason(
  status: RawFileStatus,
  message: string,
): FileDiffUnavailableReason {
  if (status === 'unmerged') return 'conflicted'
  if (message.includes('不存在') || message.includes('missing')) return 'missing'
  if (message.includes('不支持') || message.includes('unsupported')) return 'unsupported'
  return 'inspection-failed'
}

function unavailableSnapshot(
  taskId: string,
  workspacePath: string,
  inspectedAt: number,
  reason: TaskArtifactUnavailableReason,
  message: string,
  baseline?: TaskArtifactBaseline,
): TaskArtifactSnapshot {
  return {
    availability: 'unavailable',
    taskId,
    workspacePath,
    ...(baseline === undefined ? {} : { baseline }),
    inspectedAt,
    changes: [],
    reason,
    message,
  }
}

function mapMutationResult(
  taskId: string,
  workspacePath: string,
  result: RawArtifactMutationResult,
): ArtifactMutationResult {
  const latestSnapshot = mapInspection(taskId, workspacePath, Date.now(), result.latestSnapshot)
  if (latestSnapshot.availability !== 'ready') {
    throw new ArtifactOperationException('operation-failed', '成果操作没有返回可用的最新快照', latestSnapshot)
  }
  return {
    affectedChangeIds: result.affectedChangeIds,
    latestSnapshot,
  }
}

function mapTaskCommitProposal(value: Record<string, unknown>): TaskCommitProposal {
  if (typeof value.proposalId !== 'string' || value.proposalId === '') {
    throw invalidCommitResponse('提交说明提案没有返回有效标识')
  }
  if (typeof value.message !== 'string') {
    throw invalidCommitResponse('提交说明提案没有返回提交说明')
  }
  const taskId = optionalString(value.taskId, 'taskId')
  const workspacePath = optionalString(value.workspacePath, 'workspacePath')
  const snapshotToken = optionalString(value.snapshotToken, 'snapshotToken')
  const acceptedChangeIds = optionalStringArray(value.acceptedChangeIds, 'acceptedChangeIds')
  const additions = optionalNonNegativeNumber(value.additions, 'additions')
  const deletions = optionalNonNegativeNumber(value.deletions, 'deletions')
  return {
    proposalId: value.proposalId,
    message: value.message,
    ...(taskId === undefined ? {} : { taskId }),
    ...(workspacePath === undefined ? {} : { workspacePath }),
    ...(snapshotToken === undefined ? {} : { snapshotToken }),
    ...(acceptedChangeIds === undefined ? {} : { acceptedChangeIds }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
  }
}

function mapOptionalLatestSnapshot(
  value: unknown,
  context?: ArtifactOperationContext,
): TaskArtifactSnapshot | undefined {
  if (value === undefined) return undefined
  if (context === undefined) throw invalidCommitResponse('提交响应包含快照但缺少任务上下文')
  if (recordValue(value) === undefined) throw invalidCommitResponse('提交响应中的最新快照格式无效')
  return mapInspection(context.taskId, context.workspacePath, Date.now(), value as RawTaskArtifactInspection)
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidCommitResponse(`提交说明提案字段 ${field} 格式无效`)
  return value
}

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw invalidCommitResponse(`提交说明提案字段 ${field} 格式无效`)
  }
  return value
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalidCommitResponse(`提交说明提案字段 ${field} 格式无效`)
  }
  return value
}

function requiredRevision(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw invalidCommitResponse('提交成果没有返回有效版本')
  return value
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalidCommitResponse(message: string): ArtifactOperationException {
  return new ArtifactOperationException('operation-failed', message)
}

export function mapArtifactOperationFailure(
  cause: unknown,
  taskId: string,
  workspacePath: string,
  inspectedAt: number,
): ArtifactOperationException {
  const value = artifactErrorValue(cause)
  if (value === undefined) {
    return new ArtifactOperationException('operation-failed', errorMessage(cause))
  }
  const latestSnapshot = value.latestSnapshot === undefined
    ? undefined
    : mapInspection(taskId, workspacePath, inspectedAt, value.latestSnapshot)
  return new ArtifactOperationException(value.code, value.message, latestSnapshot)
}

function artifactErrorValue(cause: unknown): RawArtifactOperationError | undefined {
  let candidate = cause
  if (cause instanceof Error) candidate = cause.message
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return undefined
    }
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const value = candidate as Partial<RawArtifactOperationError>
  if (typeof value.code !== 'string' || !ARTIFACT_OPERATION_ERROR_CODES.has(value.code as ArtifactOperationError['code'])) return undefined
  if (typeof value.message !== 'string') return undefined
  return value as RawArtifactOperationError
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
