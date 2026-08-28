import { describe, expect, it } from 'vitest'
import { toDshRpcInvocation } from './dsh-transport.ts'

describe('Tauri DSH 传输', () => {
  it('普通 RPC 继续使用请求中的 method', () => {
    const request = {
      method: 'session.prompt',
      payload: { sessionId: 'session-1' },
    }

    expect(toDshRpcInvocation(request)).toEqual({
      method: 'session.prompt',
      request,
    })
  })

  it('client-response 固定转发到 respond 接口', () => {
    const request = {
      type: 'client-response',
      rpcId: 'approval-rpc-1',
      result: { ok: true },
    }

    expect(toDshRpcInvocation(request)).toEqual({
      method: 'respond',
      request,
    })
  })

  it('拒绝没有 method 的未知请求体', () => {
    expect(() => toDshRpcInvocation({ type: 'unknown' }))
      .toThrowError('无法转发 DSH 请求：请求体缺少有效 method')
  })

  it.each([null, [], 'invalid'])('拒绝不是 JSON 对象的请求体：%j', request => {
    expect(() => toDshRpcInvocation(request))
      .toThrowError('无法转发 DSH 请求：请求体必须是 JSON 对象')
  })
})
