import { describe, expect, it, vi } from 'vitest'
import { DshHttpAdapter, type WebSocketLike } from './index.ts'

class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>()
  closed = false

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event | MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: 'open' | 'message' | 'error' | 'close', event: Event | MessageEvent = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    this.closed = true
  }
}

describe('DSH 适配契约', () => {
  it('创建任务会话时把 DSH 响应转换为 JoyDSH 领域对象', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { sessionId: 'session-1' } },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await expect(adapter.createTask({ workspacePath: '/tmp/joydsh' })).resolves.toEqual({
      id: 'session-1',
      workspacePath: '/tmp/joydsh',
      running: false,
      blank: true,
      updatedAt: expect.any(Number),
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:43127/api/session.create'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('列出会话时读取自动生成的标题投影', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [{
              sessionId: 'session-1',
              updatedAt: 100,
              running: false,
              blank: false,
              cwd: '/tmp/joydsh',
              projections: { asOfSeq: 4, values: { title: '自动命名会话' } },
            }],
          },
        },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await expect(adapter.listTasks()).resolves.toEqual([{
      id: 'session-1',
      title: '自动命名会话',
      workspacePath: '/tmp/joydsh',
      running: false,
      blank: false,
      updatedAt: 100,
    }])
  })

  it('DSH 返回错误时拒绝命令并保留错误码', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: false, error: { code: 'session-not-found', message: 'missing' } },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await expect(adapter.stopTask('missing')).rejects.toMatchObject({
      code: 'session-not-found',
      message: 'missing',
    })
  })

  it('回放历史时按序转换会话事件', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            hasMore: false,
            events: [
              { event: { type: 'turn/start', seq: 0, time: 100, data: {} } },
              { event: { type: 'assistant/message', seq: 1, time: 101, data: { text: '完成' } } },
            ],
          },
        },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    const events = await adapter.replayTask('session-1')

    expect(events.map(event => [event.type, event.sequence])).toEqual([
      ['turn/start', 0],
      ['assistant/message', 1],
    ])
  })

  it('通过独立双事件流接收会话事件并可取消订阅', () => {
    const sockets: FakeSocket[] = []
    const urls: string[] = []
    const adapter = new DshHttpAdapter({
      baseUrl: 'http://127.0.0.1:43127',
      webSocketFactory: (url) => {
        urls.push(url)
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const events: Array<{ taskId: string | undefined, type: string, sequence: number | undefined, data: unknown }> = []
    const states: string[] = []

    const unsubscribe = adapter.subscribe({
      onEvent: event => events.push({
        taskId: event.taskId,
        type: event.type,
        sequence: event.sequence,
        data: event.data,
      }),
      onConnectionChange: state => states.push(state),
    })
    sockets[0]?.emit('open')
    sockets[1]?.emit('open')
    sockets[0]?.emit('message', {
      data: JSON.stringify({
        type: 'server-request',
        rpcId: 'event-1',
        payload: {
          type: 'session/event',
          sessionId: 'session-1',
          event: { type: 'assistant/message', seq: 2, time: 100, data: { text: '完成' } },
        },
      }),
    } as MessageEvent)
    sockets[0]?.emit('message', {
      data: JSON.stringify({
        type: 'server-request',
        rpcId: 'projection-1',
        payload: {
          type: 'session/projection',
          sessionId: 'session-1',
          key: 'title',
          value: '自动命名会话',
          seq: 3,
        },
      }),
    } as MessageEvent)
    unsubscribe()

    expect(urls).toEqual([
      'ws://127.0.0.1:43127/api/events.mux',
      'ws://127.0.0.1:43127/api/events.host',
    ])
    expect(states).toEqual(['connecting', 'connected'])
    expect(events).toEqual([
      {
        taskId: 'session-1',
        type: 'assistant/message',
        sequence: 2,
        data: { text: '完成' },
      },
      {
        taskId: 'session-1',
        type: 'session/projection',
        sequence: undefined,
        data: {
          type: 'session/projection',
          sessionId: 'session-1',
          key: 'title',
          value: '自动命名会话',
          seq: 3,
        },
      },
    ])
    expect(sockets.every(socket => socket.closed)).toBe(true)
  })

  it('连接失败后进入 disconnected 并在静默重试期间避免 connecting 闪烁', () => {
    vi.useFakeTimers()
    try {
      const sockets: FakeSocket[] = []
      const adapter = new DshHttpAdapter({
        baseUrl: 'http://127.0.0.1:43127',
        webSocketFactory: () => {
          const socket = new FakeSocket()
          sockets.push(socket)
          return socket
        },
      })
      const states: string[] = []

      const unsubscribe = adapter.subscribe({
        onEvent: () => {},
        onConnectionChange: state => states.push(state),
      })

      expect(states).toEqual(['connecting'])

      // 初始连接失败 -> 进入 disconnected
      sockets[0]?.emit('error')
      sockets[1]?.emit('close')
      expect(states).toEqual(['connecting', 'disconnected'])

      // 500ms 后后台静默重试第 1 次，如果仍未连上，不应向 UI 广播 connecting
      vi.advanceTimersByTime(500)
      expect(states).toEqual(['connecting', 'disconnected'])

      // 重试再次失败 -> 依然保持 disconnected，不产生冗余通知
      const retrySocketMux = sockets[2]
      const retrySocketHost = sockets[3]
      retrySocketMux?.emit('error')
      retrySocketHost?.emit('close')
      expect(states).toEqual(['connecting', 'disconnected'])

      // 再次经过 500ms 后重试成功 -> 两个 socket 都 open -> 通知 connected
      vi.advanceTimersByTime(500)
      const successSocketMux = sockets[4]
      const successSocketHost = sockets[5]
      successSocketMux?.emit('open')
      successSocketHost?.emit('open')
      expect(states).toEqual(['connecting', 'disconnected', 'connected'])

      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('查询并只写保存模型凭据', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: request.method === 'credentials.describe'
            ? { credentials: { DEEPSEEK_API_KEY: { configured: false, writable: true } } }
            : {},
        },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await expect(adapter.describeCredential('DEEPSEEK_API_KEY')).resolves.toEqual({
      configured: false,
      writable: true,
    })
    await adapter.setCredential('DEEPSEEK_API_KEY', 'test-secret')

    expect(requests).toEqual([
      { method: 'credentials.describe', payload: { refs: ['DEEPSEEK_API_KEY'] } },
      { method: 'credentials.set', payload: { ref: 'DEEPSEEK_API_KEY', value: 'test-secret' } },
    ])
  })

  it('读取 DeepSeek 与 OpenAI 的 Base URL', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [
              { ns: 'llm-deepseek', value: { baseURL: 'https://deepseek.example/v1' } },
              {
                ns: 'llm-pi-ai',
                value: { providers: { openai: { baseURL: 'https://openai.example/v1' } } },
              },
            ],
          },
        },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await expect(adapter.describeProviderSettings()).resolves.toEqual({
      baseUrls: {
        'deepseek-official': 'https://deepseek.example/v1',
        openai: 'https://openai.example/v1',
      },
    })
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:43127/api/settings.describe'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('发现 Codex 模型并配置 OpenAI 路由和会话模型', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      const values: Record<string, unknown> = {
        'llm.discoverModels': {
          models: [
            { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: 400_000, maxTokens: 128_000 },
          ],
        },
        'settings.mutate': { ns: 'llm-pi-ai' },
        'settings.update': { ns: 'agent-default-model' },
        'session.selectModel': {
          selected: { provider: 'openai', model: 'gpt-5.3-codex' },
        },
      }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: values[request.method] },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await expect(adapter.discoverModels('llm-pi-ai', 'openai')).resolves.toEqual([
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: 400_000, maxTokens: 128_000 },
    ])
    await adapter.configureProvider('openai', 'OPENAI_API_KEY', 'https://openai.example/v1')
    await adapter.setDefaultModel({ provider: 'openai', model: 'gpt-5.3-codex' })
    await adapter.selectTaskModel('session-1', { provider: 'openai', model: 'gpt-5.3-codex' })

    expect(requests).toEqual([
      {
        method: 'llm.discoverModels',
        payload: { settingsNs: 'llm-pi-ai', provider: 'openai' },
      },
      {
        method: 'settings.mutate',
        payload: {
          ns: 'llm-pi-ai',
          ops: [
            { op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: 'OPENAI_API_KEY' },
            { op: 'set', path: ['providers', 'openai', 'baseURL'], value: 'https://openai.example/v1' },
          ],
        },
      },
      {
        method: 'settings.update',
        payload: { ns: 'agent-default-model', patch: { provider: 'openai', model: 'gpt-5.3-codex' } },
      },
      {
        method: 'session.selectModel',
        payload: { sessionId: 'session-1', provider: 'openai', model: 'gpt-5.3-codex' },
      },
    ])
  })

  it('清空 Base URL 时恢复 provider 默认地址', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: {} },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await adapter.configureProvider('deepseek-official', 'DEEPSEEK_API_KEY', '')
    await adapter.configureProvider('openai', 'OPENAI_API_KEY', '')

    expect(requests).toEqual([
      {
        method: 'settings.mutate',
        payload: {
          ns: 'llm-deepseek',
          ops: [
            { op: 'set', path: ['apiKeyEnv'], value: 'DEEPSEEK_API_KEY' },
            { op: 'unset', path: ['baseURL'] },
          ],
        },
      },
      {
        method: 'settings.mutate',
        payload: {
          ns: 'llm-pi-ai',
          ops: [
            { op: 'set', path: ['providers', 'openai', 'apiKeyEnv'], value: 'OPENAI_API_KEY' },
            { op: 'unset', path: ['providers', 'openai', 'baseURL'] },
          ],
        },
      },
    ])
  })

  it('通过 DSH 权限命令切换任务的标准权限和完全访问', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true, command: { kind: 'success' } } },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await adapter.setTaskPermission('session-1', 'full-access')
    await adapter.setTaskPermission('session-1', 'standard')

    expect(requests.map(request => ({
      method: request.method,
      payload: {
        ...(request.payload as Record<string, unknown>),
        clientTimeZone: '<timezone>',
      },
    }))).toEqual([
      {
        method: 'session.prompt',
        payload: {
          sessionId: 'session-1',
          mode: 'queue',
          content: [{ type: 'text', text: '/permission danger-full-access' }],
          clientTimeZone: '<timezone>',
        },
      },
      {
        method: 'session.prompt',
        payload: {
          sessionId: 'session-1',
          mode: 'queue',
          content: [{ type: 'text', text: '/permission workspace-write' }],
          clientTimeZone: '<timezone>',
        },
      },
    ])
  })

  it('暂停任务时只中断当前 DSH 回合', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true } },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await adapter.pauseTask('session-1')

    expect(requests).toEqual([{
      method: 'session.cancel',
      payload: { sessionId: 'session-1' },
    }])
  })

  it('用审批请求的 rpcId 回应一次性允许', async () => {
    const calls: Array<{ url: string, body: unknown }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ accepted: true })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    await adapter.respondToApproval('session-1', {
      requestId: 'approval-rpc-1',
      approvalId: 'approval-1',
      toolName: 'bash',
      reason: '需要访问工作空间外目录',
    }, 'allowed-once')

    expect(calls).toEqual([{
      url: 'http://127.0.0.1:43127/api/respond',
      body: {
        type: 'client-response',
        rpcId: 'approval-rpc-1',
        result: {
          ok: true,
          value: {
            sessionId: 'session-1',
            approvalId: 'approval-1',
            outcome: 'allowed-once',
          },
        },
      },
    }])
  })

  it('发送图文与纯图片提示词', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: true } },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    // 图文混合
    await adapter.sendInput('session-1', '查看此图', [
      { id: 'img-1', mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=', name: 'screenshot.png' },
    ])
    // 纯图
    await adapter.sendInput('session-1', '', [
      { id: 'img-2', mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==', name: 'photo.jpg' },
    ])

    expect(requests.map(r => ({
      method: r.method,
      content: (r.payload as { content: unknown }).content,
    }))).toEqual([
      {
        method: 'session.prompt',
        content: [
          { type: 'text', text: '查看此图' },
          { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'screenshot.png' },
        ],
      },
      {
        method: 'session.prompt',
        content: [
          { type: 'image', mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==', name: 'photo.jpg' },
        ],
      },
    ])
  })

  it('按需拉取历史会话附件', async () => {
    const requests: Array<{ method: string, payload: unknown }> = []
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string, method: string, payload: unknown }
      requests.push({ method: request.method, payload: request.payload })
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            attachment: {
              attachmentId: 'att-1',
              mediaType: 'image/png',
              bytes: 1024,
              width: 800,
              height: 600,
              name: 'arch.png',
            },
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          },
        },
      })
    })
    const adapter = new DshHttpAdapter({ baseUrl: 'http://127.0.0.1:43127', fetch })

    const res = await adapter.getAttachment('session-1', 'att-1')
    expect(res).toEqual({
      attachment: {
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: 1024,
        width: 800,
        height: 600,
        name: 'arch.png',
      },
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    })
    expect(requests).toEqual([
      { method: 'session.attachment', payload: { sessionId: 'session-1', attachmentId: 'att-1' } },
    ])
  })
})
