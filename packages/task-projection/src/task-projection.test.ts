import { describe, expect, it } from 'vitest'
import type { TaskEvent } from '@joydsh/domain'
import { createTaskProjection, projectTaskEvent, synchronizeTaskRunning } from './index.ts'

function event(type: string, sequence: number): TaskEvent {
  return {
    id: `task-1:${sequence}`,
    taskId: 'task-1',
    kind: 'session',
    type,
    sequence,
    time: sequence,
    data: {},
  }
}

describe('任务事件投影', () => {
  it('用任务列表的权威运行状态修正恢复投影', () => {
    const completed = projectTaskEvent(createTaskProjection('task-1'), {
      ...event('turn/end', 1),
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    const running = synchronizeTaskRunning(completed, true)
    const idle = synchronizeTaskRunning(running, false)
    const waiting = synchronizeTaskRunning({
      ...running,
      status: 'waiting-approval',
    }, true)

    expect(running.status).toBe('running')
    expect(idle.status).toBe('idle')
    expect(waiting.status).toBe('waiting-approval')
  })

  it('按事件序列推进任务状态并忽略重复事件', () => {
    const started = projectTaskEvent(createTaskProjection('task-1'), event('turn/start', 1))
    const duplicate = projectTaskEvent(started, event('turn/start', 1))
    const stopped = projectTaskEvent(duplicate, {
      ...event('turn/end', 2),
      data: { turn: 1, reason: { kind: 'completed' } },
    })

    expect(started.status).toBe('running')
    expect(duplicate.events).toHaveLength(1)
    expect(stopped.status).toBe('completed')
    expect(stopped.lastSequence).toBe(2)
  })

  it.each([
    ['aborted', 'cancelled'],
    ['blocked', 'blocked'],
    ['max-tokens', 'max-tokens'],
    ['interrupted', 'interrupted'],
  ] as const)('把 %s 回合结束原因投影为 %s 状态', (reason, status) => {
    const projected = projectTaskEvent(createTaskProjection('task-1'), {
      ...event('turn/end', 1),
      data: { turn: 1, reason: { kind: reason } },
    })

    expect(projected.status).toBe(status)
  })

  it('把用户主动中断的回合投影为可继续的暂停状态', () => {
    const projected = projectTaskEvent(createTaskProjection('task-1'), {
      ...event('turn/end', 1),
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })

    expect(projected.status).toBe('paused')
  })

  it('宿主错误将任务投影为失败状态', () => {
    const failed = projectTaskEvent(createTaskProjection('task-1'), {
      id: 'host-error',
      taskId: 'task-1',
      kind: 'error',
      type: 'host/agent-error',
      time: 10,
      data: { message: '运行时失败' },
    })

    expect(failed.status).toBe('failed')
    expect(failed.events.at(-1)?.type).toBe('host/agent-error')
  })

  it('把模型文本增量投影为可见输出', () => {
    const output = projectTaskEvent(createTaskProjection('task-1'), {
      id: 'task-1:1',
      taskId: 'task-1',
      kind: 'session',
      type: 'assistant/chunk',
      sequence: 1,
      time: 10,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } },
    })

    expect(output.output).toBe('你好')
  })

  it('把模型结束块中的失败原因提升到任务状态', () => {
    const failed = projectTaskEvent(createTaskProjection('task-1'), {
      id: 'task-1:2',
      taskId: 'task-1',
      kind: 'session',
      type: 'assistant/chunk',
      sequence: 2,
      time: 10,
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'MISSING_CREDENTIAL',
              message: 'no API key for provider route "deepseek-official"',
            },
          },
        },
      },
    })

    expect(failed.status).toBe('failed')
    expect(failed.failure).toEqual({
      code: 'MISSING_CREDENTIAL',
      message: 'no API key for provider route "deepseek-official"',
    })
  })

  it('用最新 todo/write 全量快照替换任务计划', () => {
    const initial = projectTaskEvent(createTaskProjection('task-1'), {
      ...event('todo/write', 1),
      data: {
        todos: [
          { content: '确认目标', status: 'completed' },
          { content: '实现功能', status: 'in_progress' },
        ],
      },
    })
    const replaced = projectTaskEvent(initial, {
      ...event('todo/write', 2),
      data: {
        todos: [
          { content: '运行验收', status: 'pending' },
        ],
      },
    })

    expect(initial.plan).toEqual([
      { content: '确认目标', status: 'completed' },
      { content: '实现功能', status: 'in_progress' },
    ])
    expect(replaced.plan).toEqual([
      { content: '运行验收', status: 'pending' },
    ])
  })

  it('从权限预设和 mux 事件投影待审批状态', () => {
    const fullAccess = projectTaskEvent(createTaskProjection('task-1'), {
      ...event('permission/preset', 1),
      data: { preset: 'danger-full-access' },
    })
    const requested = projectTaskEvent(fullAccess, {
      id: 'approval-rpc-1',
      taskId: 'task-1',
      kind: 'control',
      type: 'approval/requested',
      time: 20,
      data: {
        type: 'approval/requested',
        sessionId: 'task-1',
        approvalId: 'approval-1',
        toolName: 'bash',
        callId: 'call-1',
        reason: '需要访问工作空间外目录',
      },
    })
    const resolved = projectTaskEvent(requested, {
      id: 'approval-resolved-rpc-1',
      taskId: 'task-1',
      kind: 'control',
      type: 'approval/resolved',
      time: 21,
      data: {
        type: 'approval/resolved',
        sessionId: 'task-1',
        approvalId: 'approval-1',
        outcome: 'allowed-once',
      },
    })

    expect(fullAccess.permissionMode).toBe('full-access')
    expect(requested.status).toBe('waiting-approval')
    expect(requested.pendingApprovals).toEqual([{
      requestId: 'approval-rpc-1',
      approvalId: 'approval-1',
      toolName: 'bash',
      callId: 'call-1',
      reason: '需要访问工作空间外目录',
    }])
    expect(resolved.pendingApprovals).toEqual([])
    expect(resolved.status).toBe('running')
  })

  it('收到 request/header 或 user/message 时自动切换为 running 并清空上回合输出', () => {
    const previous = {
      ...createTaskProjection('task-1'),
      status: 'idle' as const,
      output: '上一回合的历史输出',
    }
    const nextTurn = projectTaskEvent(previous, {
      ...event('request/header', 1),
      data: { reason: 'resume' },
    })

    expect(nextTurn.status).toBe('running')
    expect(nextTurn.output).toBe('')
  })

  it('收到 assistant/chunk 时保持 running 状态并累加输出', () => {
    const initial = {
      ...createTaskProjection('task-1'),
      status: 'idle' as const,
    }
    const chunk1 = projectTaskEvent(initial, {
      ...event('assistant/chunk', 1),
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
    })
    const chunk2 = projectTaskEvent(chunk1, {
      ...event('assistant/chunk', 2),
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' World' } },
    })

    expect(chunk1.status).toBe('running')
    expect(chunk2.status).toBe('running')
    expect(chunk2.output).toBe('Hello World')
  })
})
