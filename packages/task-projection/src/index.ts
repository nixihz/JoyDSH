import type { TaskApproval, TaskEvent, TaskPermissionMode } from '@joydsh/domain'

export type TaskProjectionStatus =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'blocked'
  | 'max-tokens'
  | 'interrupted'
  | 'failed'

export interface TaskFailure {
  code?: string
  message: string
}

export interface TaskPlanItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface TaskProjection {
  taskId: string
  status: TaskProjectionStatus
  lastSequence: number
  events: readonly TaskEvent[]
  output: string
  plan: readonly TaskPlanItem[]
  permissionMode: TaskPermissionMode
  pendingApprovals: readonly TaskApproval[]
  failure?: TaskFailure
}

export function createTaskProjection(taskId: string): TaskProjection {
  return {
    taskId,
    status: 'idle',
    lastSequence: -1,
    events: [],
    output: '',
    plan: [],
    permissionMode: 'standard',
    pendingApprovals: [],
  }
}

export function synchronizeTaskRunning(
  state: TaskProjection,
  running: boolean,
): TaskProjection {
  if (running) {
    return state.status === 'waiting-approval' || state.status === 'running'
      ? state
      : { ...state, status: 'running' }
  }
  return state.status === 'running' ? { ...state, status: 'idle' } : state
}

export function projectTaskEvent(state: TaskProjection, event: TaskEvent): TaskProjection {
  if (event.taskId !== undefined && event.taskId !== state.taskId) return state
  if (event.sequence !== undefined && event.sequence <= state.lastSequence) return state

  const eventFailure = extractFailure(event.data)
  let status = state.status
  let output = state.output
  let plan = state.plan
  let permissionMode = state.permissionMode
  let pendingApprovals = state.pendingApprovals
  let failure = state.failure

  if (isTurnStartEvent(event.type)) {
    output = ''
    failure = undefined
  }

  const delta = extractTextDelta(event.data)
  if (delta !== undefined) output += delta
  const message = extractAssistantMessage(event.data)
  if (event.type === 'assistant/message' && message !== undefined) output = message
  const todoSnapshot = extractTodoSnapshot(event.data)
  if (event.type === 'todo/write' && todoSnapshot !== undefined) plan = todoSnapshot
  const nextPermissionMode = extractPermissionMode(event.data)
  if (event.type === 'permission/preset' && nextPermissionMode !== undefined) permissionMode = nextPermissionMode
  const requestedApproval = extractRequestedApproval(event)
  if (event.type === 'approval/requested' && requestedApproval !== undefined) {
    pendingApprovals = [
      ...pendingApprovals.filter(approval => approval.approvalId !== requestedApproval.approvalId),
      requestedApproval,
    ]
  }
  const resolvedApprovalId = extractResolvedApprovalId(event.data)
  if (event.type === 'approval/resolved' && resolvedApprovalId !== undefined) {
    pendingApprovals = pendingApprovals.filter(approval => approval.approvalId !== resolvedApprovalId)
  }

  if (eventFailure !== undefined) failure = eventFailure
  if (event.kind === 'error' || eventFailure !== undefined) status = 'failed'
  else if (pendingApprovals.length > 0) status = 'waiting-approval'
  else if (event.type === 'approval/resolved' && state.status === 'waiting-approval') status = 'running'
  else if (isTurnStartEvent(event.type) || isTurnActiveEvent(event.type) || (event.type === 'host/session-status' && isRunning(event.data))) status = 'running'
  else if (event.type === 'turn/end') status = extractTurnEndStatus(event.data) ?? 'idle'
  else if (event.type === 'host/session-status' && status === 'running') status = 'idle'

  const projected = {
    ...state,
    status,
    lastSequence: event.sequence ?? state.lastSequence,
    events: [...state.events, event],
    output,
    plan,
    permissionMode,
    pendingApprovals,
  }
  if (failure !== undefined) return { ...projected, failure }
  const { failure: _previousFailure, ...withoutFailure } = projected
  return withoutFailure
}

function isTurnStartEvent(type: string): boolean {
  return type === 'turn/start' || type === 'request/header' || type === 'user/message'
}

function isTurnActiveEvent(type: string): boolean {
  return type === 'assistant/chunk'
    || type === 'step/start'
    || type === 'tool/call'
    || type === 'tool/result'
    || type === 'request/context'
}

function isRunning(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'running' in data && data.running === true
}

function extractTurnEndStatus(data: unknown): Exclude<TaskProjectionStatus, 'idle' | 'running' | 'failed'> | undefined {
  const reason = record(record(data)?.reason)
  const kind = reason?.kind
  if (kind === 'completed') return 'completed'
  if (kind === 'aborted') return record(reason?.reason)?.kind === 'user' ? 'paused' : 'cancelled'
  if (kind === 'blocked') return 'blocked'
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'interrupted') return 'interrupted'
  return undefined
}

function extractTextDelta(data: unknown): string | undefined {
  const chunk = record(record(data)?.chunk)
  return chunk?.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : undefined
}

function extractPermissionMode(data: unknown): TaskPermissionMode | undefined {
  const preset = record(data)?.preset
  if (preset === 'workspace-write') return 'standard'
  if (preset === 'danger-full-access') return 'full-access'
  return undefined
}

function extractRequestedApproval(event: TaskEvent): TaskApproval | undefined {
  const value = record(event.data)
  if (value === undefined || typeof value.approvalId !== 'string' || typeof value.toolName !== 'string') return undefined
  return {
    requestId: event.id,
    approvalId: value.approvalId,
    toolName: value.toolName,
    ...(typeof value.callId === 'string' ? { callId: value.callId } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  }
}

function extractResolvedApprovalId(data: unknown): string | undefined {
  const approvalId = record(data)?.approvalId
  return typeof approvalId === 'string' ? approvalId : undefined
}

function extractTodoSnapshot(data: unknown): TaskPlanItem[] | undefined {
  const todos = record(data)?.todos
  if (!Array.isArray(todos)) return undefined
  const items: TaskPlanItem[] = []
  for (const value of todos) {
    const item = record(value)
    if (item === undefined || typeof item.content !== 'string' || !isPlanStatus(item.status)) return undefined
    items.push({ content: item.content, status: item.status })
  }
  return items
}

function isPlanStatus(value: unknown): value is TaskPlanItem['status'] {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

function extractAssistantMessage(data: unknown): string | undefined {
  const message = record(record(data)?.message)
  if (message === undefined || !Array.isArray(message.content)) return undefined
  const text = message.content
    .map(block => record(block))
    .filter((block): block is Record<string, unknown> => block?.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text))
    .join('')
  return text === '' ? undefined : text
}

function extractFailure(data: unknown): TaskFailure | undefined {
  const value = record(data)
  if (value === undefined) return undefined

  const chunkReason = record(record(value.chunk)?.reason)
  const turnReason = record(value.reason)
  const candidate = record(chunkReason?.failure) ?? record(turnReason?.error) ?? record(value.error)
  if (candidate !== undefined && typeof candidate.message === 'string') {
    return {
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      message: candidate.message,
    }
  }
  if (typeof value.message === 'string') {
    return {
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      message: value.message,
    }
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
