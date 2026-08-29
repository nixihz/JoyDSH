import type {
  ImageAttachmentInput,
  ImageAttachmentRef,
  ImageMediaType,
  RuntimeHealth,
  TaskApproval,
  TaskApprovalOutcome,
  TaskEvent,
  TaskPermissionMode,
  TaskQuestionAnswer,
  TaskSession,
} from '@joydsh/domain'
import { z } from 'zod'

const DSH_VERSION = '0.1.1-rc.2'

const imageAttachmentRefSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  name: z.string().optional(),
  originalDimensions: z.object({
    width: z.number(),
    height: z.number(),
  }).optional(),
})

const sessionAttachmentValueSchema = z.object({
  attachment: imageAttachmentRefSchema,
  data: z.string(),
})

const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

const rpcResponseSchema = z.object({
  type: z.literal('server-response'),
  rpcId: z.string(),
  result: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: rpcErrorSchema }),
  ]),
})

const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  updatedAt: z.number(),
  running: z.boolean(),
  blank: z.boolean(),
  cwd: z.string().optional(),
  projections: z.object({
    asOfSeq: z.number().int(),
    values: z.object({ title: z.string().nullable().optional() }).passthrough(),
  }).optional(),
})

const sessionEventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number(),
  data: z.unknown(),
})

const historySchema = z.object({
  events: z.array(z.object({ event: sessionEventSchema })),
  hasMore: z.boolean(),
})

const credentialStatusSchema = z.object({
  configured: z.boolean(),
  source: z.string().optional(),
  writable: z.boolean(),
})

const credentialsDescribeSchema = z.object({
  credentials: z.record(z.string(), credentialStatusSchema),
})

const settingsDescribeSchema = z.object({
  namespaces: z.array(z.object({
    ns: z.string(),
    value: z.unknown(),
  })),
})

const deepseekSettingsSchema = z.object({
  baseURL: z.string().optional(),
}).passthrough()

const piAiSettingsSchema = z.object({
  providers: z.record(z.string(), z.object({
    baseURL: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough()

const discoveredModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
})

const discoveredModelsSchema = z.object({
  models: z.array(discoveredModelSchema),
})

const modelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
})

const selectedModelSchema = z.object({ selected: modelSelectionSchema })

const eventEnvelopeSchema = z.object({
  type: z.literal('server-request'),
  rpcId: z.string(),
  payload: z.object({ type: z.string() }).passthrough(),
})

const questionRequestedPayloadSchema = z.object({
  type: z.literal('question/requested'),
  sessionId: z.string().min(1),
  questions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    detail: z.string().optional(),
    options: z.array(z.object({
      label: z.string(),
      description: z.string().optional(),
    })).optional(),
    multiSelect: z.boolean().optional(),
    intent: z.object({
      kind: z.literal('plan-review'),
      approve: z.string(),
    }).optional(),
  })).min(1),
})

const approvalReceiptSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true) }),
  z.object({
    accepted: z.literal(false),
    reason: z.enum(['not-pending', 'bad-response']),
  }),
])

const commandExecutionSchema = z.object({
  commandId: z.string().min(1),
  result: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('success'),
      text: z.string().optional(),
    }).passthrough(),
    z.object({
      kind: z.literal('error'),
      text: z.string(),
    }).passthrough(),
  ]),
}).passthrough().optional()

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface WebSocketLike {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event | MessageEvent) => void): void
  close(): void
}

export interface DshAdapterOptions {
  baseUrl: string
  fetch?: FetchLike
  webSocketFactory?: (url: string) => WebSocketLike
}

export interface TaskSubscription {
  onEvent(event: TaskEvent): void
  onConnectionChange?(state: RuntimeHealth['state']): void
}

export type CredentialStatus = z.infer<typeof credentialStatusSchema>
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export interface ProviderSettings {
  baseUrls: Record<'deepseek-official' | 'openai', string>
}

export interface DshAdapter {
  healthCheck(): Promise<RuntimeHealth>
  listTasks(): Promise<TaskSession[]>
  createTask(input: { workspacePath: string }): Promise<TaskSession>
  replayTask(taskId: string): Promise<TaskEvent[]>
  sendInput(taskId: string, text: string, images?: readonly ImageAttachmentInput[]): Promise<void>
  getAttachment(taskId: string, attachmentId: string): Promise<{ attachment: ImageAttachmentRef; data: string }>
  setTaskPermission(taskId: string, mode: TaskPermissionMode): Promise<void>
  respondToApproval(taskId: string, approval: TaskApproval, outcome: TaskApprovalOutcome): Promise<void>
  respondToQuestion(taskId: string, requestId: string, answer: TaskQuestionAnswer): Promise<void>
  cancelQuestion(requestId: string): Promise<void>
  pauseTask(taskId: string): Promise<void>
  stopTask(taskId: string): Promise<void>
  describeCredential(ref: string): Promise<CredentialStatus>
  setCredential(ref: string, value: string): Promise<void>
  describeProviderSettings(): Promise<ProviderSettings>
  discoverModels(settingsNs: string, provider: string): Promise<DiscoveredModel[]>
  configureProvider(provider: 'deepseek-official' | 'openai', credentialRef: string, baseUrl: string): Promise<void>
  setDefaultModel(selection: ModelSelection): Promise<void>
  selectTaskModel(taskId: string, selection: ModelSelection): Promise<ModelSelection>
  subscribe(subscription: TaskSubscription): () => void
}

export class DshAdapterError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'DshAdapterError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class DshHttpAdapter implements DshAdapter {
  private readonly baseUrl: URL
  private readonly fetch: FetchLike
  private readonly createWebSocket: (url: string) => WebSocketLike

  constructor(options: DshAdapterOptions) {
    this.baseUrl = new URL(options.baseUrl)
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.createWebSocket = options.webSocketFactory
      ?? ((url: string) => new WebSocket(url))
  }

  async healthCheck(): Promise<RuntimeHealth> {
    await this.call('host.describe', {})
    return {
      state: 'connected',
      version: DSH_VERSION,
      capabilities: ['session.create', 'session.prompt', 'session.cancel', 'events.mux', 'events.host'],
    }
  }

  async listTasks(): Promise<TaskSession[]> {
    const value = z.object({ items: z.array(sessionSummarySchema) }).parse(
      await this.call('session.list', {}),
    )
    return value.items.map(toTaskSession)
  }

  async createTask(input: { workspacePath: string }): Promise<TaskSession> {
    const value = z.object({ sessionId: z.string().min(1) }).parse(
      await this.call('session.create', { cwd: input.workspacePath }),
    )
    return {
      id: value.sessionId,
      workspacePath: input.workspacePath,
      running: false,
      blank: true,
      updatedAt: Date.now(),
    }
  }

  async replayTask(taskId: string): Promise<TaskEvent[]> {
    const value = historySchema.parse(
      await this.call('session.history', { sessionId: taskId }),
    )
    return value.events.map(({ event }) => toSessionTaskEvent(taskId, event))
  }

  async sendInput(taskId: string, text: string, images?: readonly ImageAttachmentInput[]): Promise<void> {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
    > = []

    if (text.trim() !== '') {
      content.push({ type: 'text', text })
    }

    if (images && images.length > 0) {
      for (const img of images) {
        const cleanBase64 = img.data.includes(',') ? img.data.split(',')[1]! : img.data
        content.push({
          type: 'image',
          mediaType: img.mediaType,
          data: cleanBase64,
          ...(img.name ? { name: img.name } : {}),
        })
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    await this.call('session.prompt', {
      sessionId: taskId,
      mode: 'queue',
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  async getAttachment(taskId: string, attachmentId: string): Promise<{ attachment: ImageAttachmentRef; data: string }> {
    const value = sessionAttachmentValueSchema.parse(
      await this.call('session.attachment', { sessionId: taskId, attachmentId }),
    )
    return value
  }

  async setTaskPermission(taskId: string, mode: TaskPermissionMode): Promise<void> {
    const preset = mode === 'full-access' ? 'danger-full-access' : 'workspace-write'
    const execution = commandExecutionSchema.parse(await this.call('commands/execute', {
      args: {
        agentId: taskId,
        line: `/permission ${preset}`,
        images: [],
      },
    }))
    if (execution === undefined) {
      throw new DshAdapterError('permission-command-unavailable', '当前 DSH 运行时未提供权限切换命令')
    }
    if (execution.result.kind === 'error') {
      throw new DshAdapterError(
        'permission-command-failed',
        execution.result.text,
        { command: execution },
      )
    }
  }

  async respondToApproval(taskId: string, approval: TaskApproval, outcome: TaskApprovalOutcome): Promise<void> {
    const response = await this.fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: approval.requestId,
        result: {
          ok: true,
          value: {
            sessionId: taskId,
            approvalId: approval.approvalId,
            outcome,
          },
        },
      }),
    })
    if (!response.ok) {
      throw new DshAdapterError('transport-error', `DSH 审批回应失败：HTTP ${response.status}`)
    }
    const receipt = approvalReceiptSchema.parse(await response.json())
    if (!receipt.accepted) {
      throw new DshAdapterError('approval-not-pending', '审批请求已经失效', { reason: receipt.reason })
    }
  }

  async respondToQuestion(taskId: string, requestId: string, answer: TaskQuestionAnswer): Promise<void> {
    const response = await this.fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: requestId,
        result: {
          ok: true,
          value: { sessionId: taskId, answer },
        },
      }),
    })
    if (!response.ok) {
      throw new DshAdapterError('transport-error', `DSH 问题回应失败：HTTP ${response.status}`)
    }
    const receipt = approvalReceiptSchema.parse(await response.json())
    if (!receipt.accepted) {
      throw new DshAdapterError('question-not-pending', '问题请求已经失效', { reason: receipt.reason })
    }
  }

  async cancelQuestion(requestId: string): Promise<void> {
    const response = await this.fetch(new URL('/api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: requestId,
        result: {
          ok: false,
          error: {
            code: 'cancelled',
            message: '用户取消了问题请求',
            details: {},
          },
        },
      }),
    })
    if (!response.ok) {
      throw new DshAdapterError('transport-error', `DSH 问题取消失败：HTTP ${response.status}`)
    }
    const receipt = approvalReceiptSchema.parse(await response.json())
    if (!receipt.accepted) {
      throw new DshAdapterError('question-not-pending', '问题请求已经失效', { reason: receipt.reason })
    }
  }

  async stopTask(taskId: string): Promise<void> {
    await this.pauseTask(taskId)
  }

  async pauseTask(taskId: string): Promise<void> {
    await this.call('session.cancel', { sessionId: taskId })
  }

  async describeCredential(ref: string): Promise<CredentialStatus> {
    const value = credentialsDescribeSchema.parse(
      await this.call('credentials.describe', { refs: [ref] }),
    )
    const status = value.credentials[ref]
    if (status === undefined) throw new DshAdapterError('protocol-error', `DSH 未返回凭据 ${ref} 的状态`)
    return status
  }

  async setCredential(ref: string, value: string): Promise<void> {
    await this.call('credentials.set', { ref, value })
  }

  async describeProviderSettings(): Promise<ProviderSettings> {
    const value = settingsDescribeSchema.parse(await this.call('settings.describe', {}))
    const deepseek = deepseekSettingsSchema.safeParse(
      value.namespaces.find(namespace => namespace.ns === 'llm-deepseek')?.value,
    )
    const piAi = piAiSettingsSchema.safeParse(
      value.namespaces.find(namespace => namespace.ns === 'llm-pi-ai')?.value,
    )
    return {
      baseUrls: {
        'deepseek-official': deepseek.success ? deepseek.data.baseURL ?? '' : '',
        openai: piAi.success ? piAi.data.providers?.openai?.baseURL ?? '' : '',
      },
    }
  }

  async discoverModels(settingsNs: string, provider: string): Promise<DiscoveredModel[]> {
    const value = discoveredModelsSchema.parse(
      await this.call('llm.discoverModels', { settingsNs, provider }),
    )
    return value.models
  }

  async configureProvider(provider: 'deepseek-official' | 'openai', credentialRef: string, baseUrl: string): Promise<void> {
    const isDeepSeek = provider === 'deepseek-official'
    const apiKeyPath = isDeepSeek ? ['apiKeyEnv'] : ['providers', provider, 'apiKeyEnv']
    const baseUrlPath = isDeepSeek ? ['baseURL'] : ['providers', provider, 'baseURL']
    await this.call('settings.mutate', {
      ns: isDeepSeek ? 'llm-deepseek' : 'llm-pi-ai',
      ops: [
        { op: 'set', path: apiKeyPath, value: credentialRef },
        baseUrl === ''
          ? { op: 'unset', path: baseUrlPath }
          : { op: 'set', path: baseUrlPath, value: baseUrl },
      ],
    })
  }

  async setDefaultModel(selection: ModelSelection): Promise<void> {
    await this.call('settings.update', {
      ns: 'agent-default-model',
      patch: selection,
    })
  }

  async selectTaskModel(taskId: string, selection: ModelSelection): Promise<ModelSelection> {
    const value = selectedModelSchema.parse(
      await this.call('session.selectModel', { sessionId: taskId, ...selection }),
    )
    return value.selected
  }

  subscribe(subscription: TaskSubscription): () => void {
    let stopped = false
    const sockets = new Set<WebSocketLike>()
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let isInitial = true
    let currentState: 'connecting' | 'connected' | 'disconnected' | undefined

    const notifyState = (next: 'connecting' | 'connected' | 'disconnected'): void => {
      if (currentState === next) return
      currentState = next
      subscription.onConnectionChange?.(next)
    }

    const cleanupSockets = (): void => {
      for (const socket of sockets) {
        try {
          socket.close()
        } catch {
          // ignore error on close
        }
      }
      sockets.clear()
    }

    const connect = (): void => {
      if (stopped) return
      cleanupSockets()
      if (isInitial) {
        notifyState('connecting')
      }
      let opened = 0
      let reconnectScheduled = false

      const scheduleReconnect = (): void => {
        if (stopped || reconnectScheduled) return
        reconnectScheduled = true
        isInitial = false
        notifyState('disconnected')
        if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(connect, 500)
      }

      for (const path of ['/api/events.mux', '/api/events.host']) {
        const url = new URL(path, this.baseUrl)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = this.createWebSocket(url.toString())
        sockets.add(socket)
        socket.addEventListener('open', () => {
          opened += 1
          if (opened === 2) {
            isInitial = false
            notifyState('connected')
          }
        })
        socket.addEventListener('message', (rawEvent) => {
          const message = rawEvent as MessageEvent
          if (typeof message.data !== 'string') return
          let decoded: unknown
          try {
            decoded = JSON.parse(message.data)
          } catch {
            return
          }
          const parsed = eventEnvelopeSchema.safeParse(decoded)
          if (!parsed.success) return
          if (parsed.data.payload.type === 'question/requested'
            && !questionRequestedPayloadSchema.safeParse(parsed.data.payload).success) return
          subscription.onEvent(toTaskEvent(parsed.data.rpcId, parsed.data.payload))
        })
        socket.addEventListener('error', scheduleReconnect)
        socket.addEventListener('close', scheduleReconnect)
      }
    }

    connect()
    return () => {
      stopped = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      cleanupSockets()
    }
  }

  private async call(method: string, payload: unknown): Promise<unknown> {
    const rpcId = createRpcId()
    const response = await this.fetch(new URL(`/api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    if (!response.ok) {
      throw new DshAdapterError('transport-error', `DSH 请求失败：HTTP ${response.status}`)
    }
    const envelope = rpcResponseSchema.parse(await response.json())
    if (envelope.rpcId !== rpcId) {
      throw new DshAdapterError('protocol-error', 'DSH 响应的 rpcId 与请求不一致')
    }
    if (!envelope.result.ok) {
      throw new DshAdapterError(
        envelope.result.error.code,
        envelope.result.error.message,
        envelope.result.error.details,
      )
    }
    return envelope.result.value
  }
}

function createRpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toTaskSession(session: z.infer<typeof sessionSummarySchema>): TaskSession {
  const title = session.projections?.values.title
  return {
    id: session.sessionId,
    ...(title === undefined || title === null ? {} : { title }),
    ...(session.cwd === undefined ? {} : { workspacePath: session.cwd }),
    running: session.running,
    blank: session.blank,
    updatedAt: session.updatedAt,
  }
}

function toSessionTaskEvent(taskId: string, event: z.infer<typeof sessionEventSchema>): TaskEvent {
  return {
    id: `${taskId}:${event.seq}`,
    taskId,
    kind: 'session',
    type: event.type,
    sequence: event.seq,
    time: event.time,
    data: event.data,
  }
}

function toTaskEvent(rpcId: string, payload: z.infer<typeof eventEnvelopeSchema>['payload']): TaskEvent {
  const taskId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
  if (payload.type === 'session/event') {
    const event = sessionEventSchema.parse(payload.event)
    if (taskId === undefined) throw new DshAdapterError('protocol-error', '会话事件缺少 sessionId')
    return toSessionTaskEvent(taskId, event)
  }
  const kind = payload.type === 'stream/error' || payload.type === 'host/agent-error'
    ? 'error'
    : payload.type.startsWith('host/') ? 'host' : 'control'
  return {
    id: rpcId,
    ...(taskId === undefined ? {} : { taskId }),
    kind,
    type: payload.type,
    time: Date.now(),
    data: payload,
  }
}
