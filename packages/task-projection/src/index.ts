import type {
  MessageImageItem,
  TaskApproval,
  TaskEvent,
  TaskPermissionMode,
  TaskPlanReview,
  TaskQuestionItem,
  TaskQuestionRequest,
} from '@joydsh/domain'

export type TaskProjectionStatus =
  | 'idle'
  | 'running'
  | 'waiting-approval'
  | 'waiting-response'
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
  status?: ('streaming' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'interrupted' | 'waiting-approval' | 'waiting-response' | 'blocked' | 'max-tokens') | undefined
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
  pendingQuestions: readonly TaskQuestionRequest[]
  pendingPlanReviews: readonly TaskPlanReview[]
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
    pendingQuestions: [],
    pendingPlanReviews: [],
    messages: [],
  }
}

export function synchronizeTaskRunning(
  state: TaskProjection,
  running: boolean,
): TaskProjection {
  if (running) {
    return state.status === 'waiting-approval' || state.status === 'waiting-response' || state.status === 'running'
      ? state
      : { ...state, status: 'running' }
  }
  if (state.status === 'running') {
    return {
      ...state,
      status: 'idle',
      messages: cleanPendingAssistantMessages(state.messages, 'completed'),
    }
  }
  return state
}

function cleanPendingAssistantMessages(
  messages: readonly TaskProjectionMessage[],
  finalizedStatus: TaskProjectionMessage['status'] = 'completed',
): readonly TaskProjectionMessage[] {
  return messages
    .filter(msg => {
      if (msg.role === 'assistant' && msg.status === 'streaming') {
        const hasContent = msg.content.trim() !== ''
        const hasImages = msg.images !== undefined && msg.images.length > 0
        const hasFailure = msg.failure !== undefined
        return hasContent || hasImages || hasFailure
      }
      return true
    })
    .map(msg => {
      if (msg.role === 'assistant' && msg.status === 'streaming') {
        return { ...msg, status: finalizedStatus }
      }
      return msg
    })
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
  let pendingQuestions = state.pendingQuestions
  let pendingPlanReviews = state.pendingPlanReviews
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
      messages = cleanPendingAssistantMessages(messages)
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
    messages = cleanPendingAssistantMessages(messages)
    const assistantId = `assistant:${event.id || event.sequence || event.time}`
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
  if ((event.type === 'permission/preset' || event.type === 'permission/update') && nextPermissionMode !== undefined) {
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
  const requestedQuestions = extractQuestionRequest(event)
  if (event.type === 'question/requested' && requestedQuestions !== undefined) {
    const planReview = planReviewOf(requestedQuestions)
    if (planReview === undefined) {
      pendingQuestions = [
        ...pendingQuestions.filter(request => request.requestId !== requestedQuestions.requestId),
        requestedQuestions,
      ]
    } else {
      pendingQuestions = pendingQuestions.filter(request => request.requestId !== requestedQuestions.requestId)
      pendingPlanReviews = [
        ...pendingPlanReviews.filter(review => review.requestId !== planReview.requestId),
        planReview,
      ]
    }
  }
  const resolvedQuestionId = extractResolvedQuestionId(event.data)
  if (event.type === 'question/resolved' && resolvedQuestionId !== undefined) {
    pendingQuestions = pendingQuestions.filter(request => request.requestId !== resolvedQuestionId)
    pendingPlanReviews = pendingPlanReviews.filter(review => review.requestId !== resolvedQuestionId)
  }

  if (eventFailure !== undefined) {
    failure = eventFailure
    messages = cleanPendingAssistantMessages(messages, 'failed').map(m =>
      m.status === 'failed' ? { ...m, failure: m.failure ?? eventFailure } : m
    )
  }

  if (event.type === 'turn/end') {
    const endStatus = extractTurnEndStatus(event.data) ?? 'idle'
    status = endStatus
    const targetStatus = endStatus === 'idle' || endStatus === 'completed' ? 'completed' : endStatus
    messages = cleanPendingAssistantMessages(messages, targetStatus)
  }

  if (event.kind === 'error' || eventFailure !== undefined) status = 'failed'
  else if (pendingApprovals.length > 0) status = 'waiting-approval'
  else if (pendingQuestions.length > 0 || pendingPlanReviews.length > 0) status = 'waiting-response'
  else if (event.type === 'approval/resolved' && state.status === 'waiting-approval') status = 'running'
  else if (event.type === 'question/resolved' && state.status === 'waiting-response') status = 'running'
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
    pendingQuestions,
    pendingPlanReviews,
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
  const value = record(data)
  const preset = value?.preset ?? value?.sandboxPolicy ?? value?.sandbox_policy
  if (preset === 'workspace-write' || preset === 'standard') return 'standard'
  if (preset === 'danger-full-access' || preset === 'danger:full-access' || preset === 'full-access') return 'full-access'
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

function extractQuestionRequest(event: TaskEvent): TaskQuestionRequest | undefined {
  const value = record(event.data)
  if (value === undefined || !Array.isArray(value.questions) || value.questions.length === 0) return undefined
  const questions: TaskQuestionItem[] = []
  for (const candidate of value.questions) {
    const question = record(candidate)
    if (question === undefined || typeof question.id !== 'string' || typeof question.question !== 'string') return undefined
    let options: TaskQuestionItem['options']
    if (Array.isArray(question.options)) {
      const parsedOptions = []
      for (const option of question.options) {
        const value = record(option)
        if (value === undefined || typeof value.label !== 'string') return undefined
        parsedOptions.push({
          label: value.label,
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
        })
      }
      options = parsedOptions
    }
    const intentValue = record(question.intent)
    const intent = intentValue?.kind === 'plan-review' && typeof intentValue.approve === 'string'
      ? { kind: 'plan-review' as const, approve: intentValue.approve }
      : undefined
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(options === undefined ? {} : { options }),
      ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
      ...(intent === undefined ? {} : { intent }),
    })
  }
  return { requestId: event.id, questions }
}

function planReviewOf(request: TaskQuestionRequest): TaskPlanReview | undefined {
  if (request.questions.length !== 1) return undefined
  const question = request.questions[0]
  if (question === undefined || question.intent?.kind !== 'plan-review' || question.detail === undefined) return undefined
  if (question.multiSelect === true || question.options?.length !== 2) return undefined
  const approve = question.options.find(option => option.label === question.intent?.approve)
  if (approve === undefined) return undefined
  const decline = question.options.find(option => option.label !== approve.label)
  return {
    requestId: request.requestId,
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve,
    ...(decline === undefined ? {} : { decline }),
  }
}

function extractResolvedQuestionId(data: unknown): string | undefined {
  const questionRpcId = record(data)?.questionRpcId
  return typeof questionRpcId === 'string' ? questionRpcId : undefined
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
    || trimmed.startsWith('<skill_content')
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
