import type { MessageImageItem, TaskApproval, TaskEvent, TaskPermissionMode } from '@joydsh/domain'

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

export interface TaskProjectionMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  time: number
  status?: ('streaming' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'interrupted' | 'waiting-approval' | 'blocked' | 'max-tokens') | undefined
  isSystemInjection?: boolean | undefined
  isCommand?: boolean | undefined
  failure?: TaskFailure | undefined
  images?: readonly MessageImageItem[] | undefined
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
  messages: readonly TaskProjectionMessage[]
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
    messages: [],
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
  let messages = state.messages

  if (isTurnStartEvent(event.type)) {
    output = ''
    failure = undefined
  }

  // Handle user messages
  if (event.type === 'user/message') {
    const userText = extractUserMessage(event.data) ?? ''
    const userImages = extractMessageImages(event.data, event.id)
    if (userText.trim() !== '' || (userImages !== undefined && userImages.length > 0)) {
      const isSystemInjection = isSystemContextInjection(userText)
      const isCommand = isCommandPrompt(userText)
      const existingIdx = messages.findIndex(msg =>
        msg.id === event.id || (msg.role === 'user' && msg.id.startsWith('user-input-') && (msg.content === userText || (userText === '' && userImages !== undefined)))
      )
      const newMsg: TaskProjectionMessage = {
        id: event.id,
        role: isSystemInjection ? 'system' : 'user',
        content: userText,
        time: event.time,
        isSystemInjection,
        isCommand,
        ...(userImages !== undefined && userImages.length > 0 ? { images: userImages } : {}),
      }
      if (existingIdx >= 0) {
        messages = messages.map((m, idx) => idx === existingIdx ? { ...m, ...newMsg, images: userImages ?? m.images } : m)
      } else {
        messages = [...messages, newMsg]
      }
    }
  }

  // Handle turn/start -> initiate a new assistant turn bubble
  if (event.type === 'turn/start') {
    const assistantId = `assistant:${event.id || event.sequence || event.time}`
    const lastMsg = messages.at(-1)
    if (lastMsg === undefined || lastMsg.role !== 'assistant' || lastMsg.status !== 'streaming') {
      messages = [
        ...messages,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          time: event.time,
          status: 'streaming',
        },
      ]
    }
  }

  const delta = extractTextDelta(event.data)
  if (delta !== undefined) {
    output += delta
    const lastMsg = messages.at(-1)
    if (lastMsg !== undefined && lastMsg.role === 'assistant') {
      const updated: TaskProjectionMessage = {
        ...lastMsg,
        content: lastMsg.content + delta,
        status: 'streaming',
      }
      messages = [...messages.slice(0, -1), updated]
    } else {
      messages = [
        ...messages,
        {
          id: `assistant:${event.id || event.sequence || event.time}`,
          role: 'assistant',
          content: delta,
          time: event.time,
          status: 'streaming',
        },
      ]
    }
  }

  const message = extractAssistantMessage(event.data)
  const assistantImages = extractMessageImages(event.data, event.id)
  if (event.type === 'assistant/message' && (message !== undefined || (assistantImages !== undefined && assistantImages.length > 0))) {
    output = message ?? ''
    const lastMsg = messages.at(-1)
    if (lastMsg !== undefined && lastMsg.role === 'assistant') {
      const updated: TaskProjectionMessage = {
        ...lastMsg,
        content: message ?? lastMsg.content,
        ...(assistantImages !== undefined && assistantImages.length > 0 ? { images: assistantImages } : {}),
      }
      messages = [...messages.slice(0, -1), updated]
    } else {
      messages = [
        ...messages,
        {
          id: `assistant:${event.id || event.sequence || event.time}`,
          role: 'assistant',
          content: message ?? '',
          time: event.time,
          status: 'streaming',
          ...(assistantImages !== undefined && assistantImages.length > 0 ? { images: assistantImages } : {}),
        },
      ]
    }
  }

  const todoSnapshot = extractTodoSnapshot(event.data)
  if (event.type === 'todo/write' && todoSnapshot !== undefined) plan = todoSnapshot
  const nextPermissionMode = extractPermissionMode(event.data)
  if ((event.type === 'permission/preset' || event.type === 'permission/update' || event.type === 'user/message') && nextPermissionMode !== undefined) {
    permissionMode = nextPermissionMode
  }
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

  if (eventFailure !== undefined) {
    failure = eventFailure
    const lastMsg = messages.at(-1)
    if (lastMsg !== undefined && lastMsg.role === 'assistant') {
      const updated: TaskProjectionMessage = {
        ...lastMsg,
        status: 'failed',
        failure: eventFailure,
      }
      messages = [...messages.slice(0, -1), updated]
    }
  }

  if (event.type === 'turn/end') {
    const endStatus = extractTurnEndStatus(event.data) ?? 'idle'
    status = endStatus
    const lastMsg = messages.at(-1)
    if (lastMsg !== undefined && lastMsg.role === 'assistant') {
      const updated: TaskProjectionMessage = {
        ...lastMsg,
        status: endStatus === 'idle' || endStatus === 'completed' ? 'completed' : endStatus,
      }
      messages = [...messages.slice(0, -1), updated]
    }
  }

  if (event.kind === 'error' || eventFailure !== undefined) status = 'failed'
  else if (pendingApprovals.length > 0) status = 'waiting-approval'
  else if (event.type === 'approval/resolved' && state.status === 'waiting-approval') status = 'running'
  else if (isTurnStartEvent(event.type) || isTurnActiveEvent(event.type) || (event.type === 'host/session-status' && isRunning(event.data))) status = 'running'
  else if (event.type === 'turn/end') status = extractTurnEndStatus(event.data) ?? 'idle'
  else if (event.type === 'host/session-status' && status === 'running') status = 'idle'

  const projected: TaskProjection = {
    ...state,
    status,
    lastSequence: event.sequence ?? state.lastSequence,
    events: [...state.events, event],
    output,
    plan,
    permissionMode,
    pendingApprovals,
    messages,
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
  if (preset === 'workspace-write' || preset === 'standard') return 'standard'
  if (preset === 'danger-full-access' || preset === 'danger:full-access' || preset === 'full-access') return 'full-access'
  const text = record(data)?.text
  if (typeof text === 'string') {
    const trimmed = text.trim()
    if (trimmed.startsWith('/permission')) {
      if (trimmed.includes('danger-full-access') || trimmed.includes('danger:full-access') || trimmed.includes('full-access')) {
        return 'full-access'
      }
      if (trimmed.includes('workspace-write') || trimmed.includes('standard')) {
        return 'standard'
      }
    }
  }
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

function extractUserMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.message === 'string') return rec.message
    if (typeof rec.content === 'string') return rec.content
    if (Array.isArray(rec.content)) {
      const texts = rec.content
        .map(b => (typeof b === 'object' && b !== null && 'text' in b ? String((b as Record<string, unknown>).text) : ''))
        .join('')
      if (texts) return texts
    }
  }
  return undefined
}

function isSystemContextInjection(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>')
    || trimmed.startsWith('Current runtime context')
    || trimmed.startsWith('instructions from: AGENTS.md')
    || trimmed.includes('<system-reminder>')
}

function isCommandPrompt(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('/')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function extractMessageImages(data: unknown, eventId: string): MessageImageItem[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const rec = data as Record<string, unknown>
  const content = Array.isArray(rec.content)
    ? rec.content
    : Array.isArray(record(rec.message)?.content)
      ? (record(rec.message)?.content as unknown[])
      : undefined
  if (!content || !Array.isArray(content)) return undefined

  const images: MessageImageItem[] = []
  for (let i = 0; i < content.length; i++) {
    const block = record(content[i])
    if (block && block.type === 'image') {
      const att = record(block.attachment)
      const attachmentId = typeof att?.attachmentId === 'string' ? att.attachmentId : undefined
      const mediaType = (typeof att?.mediaType === 'string' ? att.mediaType : typeof block.mediaType === 'string' ? block.mediaType : 'image/png') as MessageImageItem['mediaType']
      const name = typeof att?.name === 'string' ? att.name : typeof block.name === 'string' ? block.name : undefined
      const bytes = typeof att?.bytes === 'number' ? att.bytes : typeof block.bytes === 'number' ? block.bytes : undefined
      const width = typeof att?.width === 'number' ? att.width : typeof block.width === 'number' ? block.width : undefined
      const height = typeof att?.height === 'number' ? att.height : typeof block.height === 'number' ? block.height : undefined
      const rawData = typeof block.data === 'string' ? block.data : undefined
      const dataUrl = rawData
        ? (rawData.startsWith('data:') ? rawData : `data:${mediaType};base64,${rawData}`)
        : undefined
      images.push({
        id: attachmentId ?? `${eventId}:image-${i}`,
        ...(attachmentId ? { attachmentId } : {}),
        ...(dataUrl ? { dataUrl } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(name ? { name } : {}),
        ...(bytes ? { bytes } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      })
    }
  }
  return images.length > 0 ? images : undefined
}
