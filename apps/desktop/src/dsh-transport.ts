import { DshHttpAdapter, type DshAdapterOptions, type WebSocketLike } from '@joydsh/dsh-adapter'
import { isTauri } from './runtime-control.ts'

const RUNTIME_URL = 'http://127.0.0.1:43127'

interface NativeStreamFrame {
  kind: 'open' | 'message' | 'close'
  data?: string
}

interface DshRpcInvocation {
  [key: string]: unknown
  method: string
  request: unknown
}

type SocketEventType = 'open' | 'message' | 'error' | 'close'
type SocketListener = (event: Event | MessageEvent) => void

class TauriEventSocket implements WebSocketLike {
  private readonly listeners = new Map<SocketEventType, SocketListener[]>()
  private unlisten: (() => void) | undefined
  private closed = false

  constructor(stream: 'mux' | 'host') {
    void this.attach(stream)
  }

  addEventListener(type: SocketEventType, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
    this.unlisten?.()
    this.unlisten = undefined
  }

  private async attach(stream: 'mux' | 'host'): Promise<void> {
    const { listen } = await import('@tauri-apps/api/event')
    if (this.closed) return
    const unlisten = await listen<NativeStreamFrame>(`dsh-events-${stream}`, event => {
      if (this.closed) return
      const frame = event.payload
      if (frame.kind === 'message' && frame.data !== undefined) {
        this.emit('message', { data: frame.data } as MessageEvent)
        return
      }
      this.emit(frame.kind, new Event(frame.kind))
    })
    if (this.closed) unlisten()
    else this.unlisten = unlisten
  }

  private emit(type: SocketEventType, event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

export function createRuntimeAdapter(): DshHttpAdapter {
  if (!isTauri()) return new DshHttpAdapter({ baseUrl: window.location.origin })
  const options: DshAdapterOptions = {
    baseUrl: RUNTIME_URL,
    fetch: tauriFetch,
    webSocketFactory: url => new TauriEventSocket(url.endsWith('events.mux') ? 'mux' : 'host'),
  }
  return new DshHttpAdapter(options)
}

export function toDshRpcInvocation(request: unknown): DshRpcInvocation {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('无法转发 DSH 请求：请求体必须是 JSON 对象')
  }

  const body = request as Record<string, unknown>
  if (body.type === 'client-response') return { method: 'respond', request }
  if (typeof body.method === 'string' && body.method.length > 0) {
    return { method: body.method, request }
  }

  throw new Error('无法转发 DSH 请求：请求体缺少有效 method')
}

async function tauriFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request: unknown = JSON.parse(String(init?.body))
  const { invoke } = await import('@tauri-apps/api/core')
  const response = await invoke<unknown>('dsh_rpc', toDshRpcInvocation(request))
  return Response.json(response)
}
