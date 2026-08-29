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

  it('投影并解决一整组普通待回应问题', () => {
    const requested = projectTaskEvent(createTaskProjection('task-1'), {
      id: 'question-rpc-1',
      taskId: 'task-1',
      kind: 'control',
      type: 'question/requested',
      time: 30,
      data: {
        type: 'question/requested',
        sessionId: 'task-1',
        questions: [
          {
            id: 'delivery-mode',
            header: '交付方式',
            question: '优先采用哪种交付方式？',
            options: [{ label: '纵向切片', description: '先贯通一条任务闭环。' }],
          },
          {
            id: 'risk',
            question: '还有哪些风险？',
            multiSelect: true,
          },
        ],
      },
    })
    const resolved = projectTaskEvent(requested, {
      id: 'question-resolved-1',
      taskId: 'task-1',
      kind: 'control',
      type: 'question/resolved',
      time: 31,
      data: {
        type: 'question/resolved',
        sessionId: 'task-1',
        questionRpcId: 'question-rpc-1',
        outcome: 'answered',
      },
    })

    expect(requested.status).toBe('waiting-response')
    expect(requested.pendingQuestions).toEqual([{
      requestId: 'question-rpc-1',
      questions: [
        {
          id: 'delivery-mode',
          header: '交付方式',
          question: '优先采用哪种交付方式？',
          options: [{ label: '纵向切片', description: '先贯通一条任务闭环。' }],
        },
        {
          id: 'risk',
          question: '还有哪些风险？',
          multiSelect: true,
        },
      ],
    }])
    expect(requested.pendingPlanReviews).toEqual([])
    expect(resolved.pendingQuestions).toEqual([])
    expect(resolved.status).toBe('running')
  })

  it('把可完整表达的方案审阅从普通问题中独立投影', () => {
    const requested = projectTaskEvent(createTaskProjection('task-1'), {
      id: 'plan-review-rpc-1',
      taskId: 'task-1',
      kind: 'control',
      type: 'question/requested',
      time: 40,
      data: {
        type: 'question/requested',
        sessionId: 'task-1',
        questions: [{
          id: 'review-plan',
          question: '是否按此方案开始实施？',
          detail: '## 方案\n\n先贯通问题回应闭环。',
          options: [
            { label: '批准方案', description: '退出方案模式并开始实施。' },
            { label: '继续修改', description: '保留方案模式并补充要求。' },
          ],
          intent: { kind: 'plan-review', approve: '批准方案' },
        }],
      },
    })

    expect(requested.status).toBe('waiting-response')
    expect(requested.pendingQuestions).toEqual([])
    expect(requested.pendingPlanReviews).toEqual([{
      requestId: 'plan-review-rpc-1',
      id: 'review-plan',
      question: '是否按此方案开始实施？',
      plan: '## 方案\n\n先贯通问题回应闭环。',
      approve: { label: '批准方案', description: '退出方案模式并开始实施。' },
      decline: { label: '继续修改', description: '保留方案模式并补充要求。' },
    }])
  })

  it('把非二元方案意图回退为普通问题以保留答案表达能力', () => {
    const requested = projectTaskEvent(createTaskProjection('task-1'), {
      id: 'plan-review-single-option',
      taskId: 'task-1',
      kind: 'control',
      type: 'question/requested',
      time: 41,
      data: {
        type: 'question/requested',
        questions: [{
          id: 'review-plan',
          question: '是否执行？',
          detail: '# 实施方案',
          options: [{ label: '批准方案' }],
          intent: { kind: 'plan-review', approve: '批准方案' },
        }],
      },
    })

    expect(requested.pendingPlanReviews).toEqual([])
    expect(requested.pendingQuestions).toHaveLength(1)
  })

  it('只根据宿主权限事件更新权限，不把用户命令当成已生效状态', () => {
    const command = projectTaskEvent(createTaskProjection('task-1'), {
      ...event('user/message', 1),
      data: { text: '/permission danger-full-access' },
    })
    const updated = projectTaskEvent(command, {
      ...event('permission/update', 2),
      data: { sandboxPolicy: 'danger-full-access' },
    })

    expect(command.permissionMode).toBe('standard')
    expect(updated.permissionMode).toBe('full-access')
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

  it('完整投影多回合对话流，保留历史用户消息和助手回复', () => {
    let proj = createTaskProjection('task-1')

    // Turn 1
    proj = projectTaskEvent(proj, {
      ...event('user/message', 1),
      data: { text: '重构权限模块' },
    })
    proj = projectTaskEvent(proj, {
      ...event('turn/start', 2),
      data: { turn: 1 },
    })
    proj = projectTaskEvent(proj, {
      ...event('assistant/chunk', 3),
      data: { chunk: { type: 'text-delta', text: '正在重构中...' } },
    })
    proj = projectTaskEvent(proj, {
      ...event('turn/end', 4),
      data: { turn: 1, reason: { kind: 'completed' } },
    })

    // Turn 2
    proj = projectTaskEvent(proj, {
      ...event('user/message', 5),
      data: { text: '测试是否通过？' },
    })
    proj = projectTaskEvent(proj, {
      ...event('turn/start', 6),
      data: { turn: 2 },
    })
    proj = projectTaskEvent(proj, {
      ...event('assistant/chunk', 7),
      data: { chunk: { type: 'text-delta', text: '全部测试已通过！' } },
    })
    proj = projectTaskEvent(proj, {
      ...event('turn/end', 8),
      data: { turn: 2, reason: { kind: 'completed' } },
    })

    expect(proj.messages).toHaveLength(4)
    expect(proj.messages[0]).toMatchObject({
      role: 'user',
      content: '重构权限模块',
      isSystemInjection: false,
    })
    expect(proj.messages[1]).toMatchObject({
      role: 'assistant',
      content: '正在重构中...',
      status: 'completed',
    })
    expect(proj.messages[2]).toMatchObject({
      role: 'user',
      content: '测试是否通过？',
      isSystemInjection: false,
    })
    expect(proj.messages[3]).toMatchObject({
      role: 'assistant',
      content: '全部测试已通过！',
      status: 'completed',
    })
    // Backwards-compatible current output
    expect(proj.output).toBe('全部测试已通过！')
  })

  it('识别系统注入提示并标记 isSystemInjection', () => {
    let proj = createTaskProjection('task-1')

    proj = projectTaskEvent(proj, {
      ...event('user/message', 1),
      data: { text: '<system-reminder>\nAvailable skills: ...' },
    })
    proj = projectTaskEvent(proj, {
      ...event('user/message', 2),
      data: { text: '/permission danger:full-access' },
    })
    proj = projectTaskEvent(proj, {
      ...event('user/message', 3),
      data: { text: '<skill_content name="handoff">\n<skill_resources>...</skill_resources>\n</skill_content>' },
    })
    proj = projectTaskEvent(proj, {
      ...event('user/message', 4),
      data: { text: '真实用户需求' },
    })

    expect(proj.messages).toHaveLength(4)
    expect(proj.messages[0]?.isSystemInjection).toBe(true)
    expect(proj.messages[0]?.role).toBe('system')
    expect(proj.messages[1]?.isCommand).toBe(true)
    expect(proj.messages[1]?.role).toBe('user')
    expect(proj.messages[2]?.isSystemInjection).toBe(true)
    expect(proj.messages[2]?.role).toBe('system')
    expect(proj.messages[3]?.isSystemInjection).toBe(false)
    expect(proj.messages[3]?.role).toBe('user')
  })

  it('解析用户与助手消息中的图片附件', () => {
    let proj = createTaskProjection('task-1')

    // 用户发送带图片的消息
    proj = projectTaskEvent(proj, {
      ...event('user/message', 1),
      data: {
        content: [
          { type: 'text', text: '请查看架构图' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'att-user-1',
              mediaType: 'image/png',
              bytes: 2048,
              width: 1024,
              height: 768,
              name: 'architecture.png',
            },
          },
        ],
      },
    })

    // 助手返回带图片的消息
    proj = projectTaskEvent(proj, {
      ...event('assistant/message', 2),
      data: {
        message: {
          content: [
            { type: 'text', text: '已生成预览：' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'att-ai-1',
                mediaType: 'image/webp',
                bytes: 4096,
                width: 1200,
                height: 800,
                name: 'preview.webp',
              },
            },
          ],
        },
      },
    })

    expect(proj.messages).toHaveLength(2)
    expect(proj.messages[0]).toMatchObject({
      role: 'user',
      content: '请查看架构图',
      images: [
        {
          id: 'att-user-1',
          attachmentId: 'att-user-1',
          mediaType: 'image/png',
          bytes: 2048,
          width: 1024,
          height: 768,
          name: 'architecture.png',
        },
      ],
    })
    expect(proj.messages[1]).toMatchObject({
      role: 'assistant',
      content: '已生成预览：',
      images: [
        {
          id: 'att-ai-1',
          attachmentId: 'att-ai-1',
          mediaType: 'image/webp',
          bytes: 4096,
          width: 1200,
          height: 800,
          name: 'preview.webp',
        },
      ],
    })
  })

  it('为内联图片生成可重复的事件级标识', () => {
    const imageEvent = {
      ...event('user/message', 1),
      data: {
        content: [{ type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' }],
      },
    }

    const first = projectTaskEvent(createTaskProjection('task-1'), imageEvent)
    const second = projectTaskEvent(createTaskProjection('task-1'), imageEvent)

    expect(first.messages[0]?.images?.[0]?.id).toBe(`${imageEvent.id}:image-0`)
    expect(second.messages[0]?.images?.[0]?.id).toBe(first.messages[0]?.images?.[0]?.id)
  })

  it('用户发送新消息时清理历史悬挂的空 Assistant 占位', () => {
    // 1. turn/start 产生了一个空的 assistant 占位
    const proj1 = projectTaskEvent(createTaskProjection('task-1'), event('turn/start', 1))
    expect(proj1.messages).toHaveLength(1)
    expect(proj1.messages[0]?.role).toBe('assistant')
    expect(proj1.messages[0]?.status).toBe('streaming')
    expect(proj1.messages[0]?.content).toBe('')

    // 2. 紧接着用户发送了命令/消息（例如权限命令），未经历 turn/end
    const proj2 = projectTaskEvent(proj1, {
      ...event('user/message', 2),
      data: { text: '/permission danger-full-access' },
    })

    // 空的占位应该被清理，只保留用户的消息
    expect(proj2.messages).toHaveLength(1)
    expect(proj2.messages[0]?.role).toBe('user')
    expect(proj2.messages[0]?.content).toBe('/permission danger-full-access')
  })

  it('用户发送新消息时将历史已有内容的 streaming 消息闭合为 completed', () => {
    const proj1 = projectTaskEvent(createTaskProjection('task-1'), event('turn/start', 1))
    const proj2 = projectTaskEvent(proj1, {
      ...event('assistant/chunk', 2),
      data: { chunk: { type: 'text-delta', text: '你好，我是助手' } },
    })
    expect(proj2.messages[0]?.status).toBe('streaming')

    const proj3 = projectTaskEvent(proj2, {
      ...event('user/message', 3),
      data: { text: '新问题' },
    })

    expect(proj3.messages).toHaveLength(2)
    expect(proj3.messages[0]?.role).toBe('assistant')
    expect(proj3.messages[0]?.status).toBe('completed')
    expect(proj3.messages[0]?.content).toBe('你好，我是助手')
    expect(proj3.messages[1]?.role).toBe('user')
    expect(proj3.messages[1]?.content).toBe('新问题')
  })

  it('回合结束时清理空的 assistant 消息并收敛所有 streaming 状态', () => {
    const proj1 = projectTaskEvent(createTaskProjection('task-1'), event('turn/start', 1))
    const proj2 = projectTaskEvent(proj1, {
      ...event('turn/end', 2),
      data: { turn: 1, reason: { kind: 'completed' } },
    })

    // 空占位在 turn/end 后不应残留
    expect(proj2.messages).toHaveLength(0)
  })
})
