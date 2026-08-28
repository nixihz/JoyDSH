import { describe, expect, it } from 'vitest'
import type { TaskApproval, TaskEvent, TaskFileChange } from '@joydsh/domain'
import { createAppFocusGraph, type AppFocusGraphOptions } from './app-focus.ts'
import { approvalEvidence } from './approval-evidence.ts'
import { selectArtifactChangeAfterMutation } from './App.tsx'
import { aggregateActivityItems } from './TaskInspector.tsx'

const BASE_OPTIONS: AppFocusGraphOptions = {
  connected: true,
  hasActiveTask: true,
  hasFailureAction: false,
  busy: false,
  canPauseTask: true,
  canSend: false,
  settingsOpen: false,
  commandCenterOpen: true,
  approvalDetailOpen: false,
  artifactConfirmationOpen: false,
  approvalResponding: false,
  pendingApprovalCount: 1,
  projectCenterOpen: false,
  projectPermissionMode: 'standard',
  projectCount: 1,
  hasWorkspaceBase: true,
  canCreateProject: false,
  selectedProvider: 'openai',
  settingsReady: true,
  credentialWritable: true,
  canSaveSettings: true,
  inspectorPage: 'activity',
  artifactChangeIds: [],
  selectedArtifactAccepted: false,
  canReviewArtifacts: false,
  canRollbackArtifacts: false,
  canCommitArtifacts: false,
  canContinueCommit: false,
}

describe('审批与权限焦点', () => {
  it('命令中心仅在存在待审批时提供审批入口', () => {
    const withApproval = createAppFocusGraph(BASE_OPTIONS)
    const withoutApproval = createAppFocusGraph({ ...BASE_OPTIONS, pendingApprovalCount: 0 })

    expect(withApproval.nodes.map(node => node.id)).toContain('command-approvals')
    expect(withoutApproval.nodes.map(node => node.id)).not.toContain('command-approvals')
  })

  it('命令中心包含全屏切换入口并维护上下环形导航', () => {
    const graph = createAppFocusGraph(BASE_OPTIONS)
    expect(graph.nodes.map(node => node.id)).toContain('command-fullscreen')

    const fullscreenNode = graph.nodes.find(node => node.id === 'command-fullscreen')
    expect(fullscreenNode?.neighbors?.down).toBe('command-model-settings')
    expect(fullscreenNode?.neighbors?.up).toBe('command-pause-task')

    const modelNode = graph.nodes.find(node => node.id === 'command-model-settings')
    expect(modelNode?.neighbors?.up).toBe('command-fullscreen')
  })

  it('审批详情默认落到拒绝，回应中只保留返回路径', () => {
    const ready = createAppFocusGraph({ ...BASE_OPTIONS, approvalDetailOpen: true })
    const responding = createAppFocusGraph({ ...BASE_OPTIONS, approvalDetailOpen: true, approvalResponding: true })

    expect(ready.entryId).toBe('approval-reject')
    expect(ready.nodes.map(node => node.id)).toEqual(['approval-back', 'approval-reject', 'approval-allow'])
    expect(responding).toEqual({
      entryId: 'approval-back',
      nodes: [{ id: 'approval-back', group: 'approval-header', order: 0 }],
    })
  })

  it('项目中心的权限选项始终在焦点图内', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      projectCenterOpen: true,
      projectPermissionMode: 'full-access',
      canCreateProject: true,
    })

    expect(graph.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'project-permission-standard',
      'project-permission-full-access',
      'project-name',
      'project-create',
      'project-item-0',
    ]))
    const nameNode = graph.nodes.find(node => node.id === 'project-name')
    const createNode = graph.nodes.find(node => node.id === 'project-create')
    const itemNode = graph.nodes.find(node => node.id === 'project-item-0')

    expect(nameNode?.neighbors?.up).toBe('project-permission-full-access')
    expect(nameNode?.neighbors?.down).toBe('project-item-0')
    expect(nameNode?.neighbors?.right).toBe('project-create')

    expect(createNode?.neighbors?.left).toBe('project-name')
    expect(createNode?.neighbors?.up).toBe('project-permission-full-access')
    expect(createNode?.neighbors?.down).toBe('project-item-0')

    expect(itemNode?.neighbors?.up).toBe('project-name')
  })

  it('命令中心只把可提交成果加入焦点图', () => {
    const unavailable = createAppFocusGraph(BASE_OPTIONS)
    const available = createAppFocusGraph({ ...BASE_OPTIONS, canCommitArtifacts: true })

    expect(unavailable.nodes.map(node => node.id)).not.toContain('command-commit-artifacts')
    expect(available.nodes.map(node => node.id)).toContain('command-commit-artifacts')
  })

  it('提交编辑与危险确认使用保守的默认焦点', () => {
    const editing = createAppFocusGraph({
      ...BASE_OPTIONS,
      commitPhase: 'editing',
      canCommitArtifacts: true,
      canContinueCommit: true,
    })
    const confirming = createAppFocusGraph({
      ...BASE_OPTIONS,
      commitPhase: 'confirming',
      canCommitArtifacts: true,
    })

    expect(editing.entryId).toBe('commit-back')
    expect(editing.nodes.map(node => node.id)).toEqual(['commit-back', 'commit-message', 'commit-continue'])
    expect(editing.nodes.find(node => node.id === 'commit-message')?.neighbors?.down).toBe('commit-continue')
    expect(confirming.entryId).toBe('commit-cancel')
    expect(confirming.nodes.map(node => node.id)).toEqual(['commit-cancel', 'commit-confirm'])
  })

  it('提交说明为空时不把禁用的继续按钮加入焦点图', () => {
    const graph = createAppFocusGraph({ ...BASE_OPTIONS, commitPhase: 'editing' })

    expect(graph.nodes.map(node => node.id)).toEqual(['commit-back', 'commit-message'])
    expect(graph.nodes.find(node => node.id === 'commit-message')?.neighbors?.down).toBeUndefined()
  })

  it('提交写入中保留状态焦点，失败时按可用性提供重试', () => {
    const committing = createAppFocusGraph({ ...BASE_OPTIONS, commitPhase: 'committing' })
    const retryable = createAppFocusGraph({ ...BASE_OPTIONS, commitPhase: 'failed', canCommitArtifacts: true })
    const blocked = createAppFocusGraph({ ...BASE_OPTIONS, commitPhase: 'failed' })

    expect(committing).toEqual({
      entryId: 'commit-status',
      nodes: [{ id: 'commit-status', group: 'commit-progress', order: 0 }],
    })
    expect(retryable.nodes.map(node => node.id)).toEqual(['commit-back', 'commit-retry'])
    expect(blocked.nodes.map(node => node.id)).toEqual(['commit-back'])
  })
})

describe('任务检查器焦点', () => {
  it('把当前检查器页作为任务区域的下一个焦点区', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      inspectorPage: 'changes',
      artifactChangeIds: ['change-a', 'change-b'],
      selectedArtifactChangeId: 'change-a',
      canReviewArtifacts: true,
    })

    expect(graph.nodes.find(node => node.id === 'task-input')?.neighbors?.['next-region'])
      .toBe('inspector-tab-changes')
    expect(graph.nodes.find(node => node.id === 'inspector-tab-changes')?.neighbors?.down)
      .toBe('inspector-file-change-a')
    expect(graph.nodes.find(node => node.id === 'inspector-file-change-b')?.neighbors?.down)
      .toBe('inspector-tab-changes')
    expect(graph.nodes.find(node => node.id === 'inspector-file-change-a')?.neighbors?.right)
      .toBe('artifact-accept-change-a')
  })

  it('建立输入框、发送按钮、工具栏与检查器标签页之间的双向横向空间导航', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      inspectorPage: 'activity',
      canSend: true,
      canPauseTask: true,
    })

    const taskInput = graph.nodes.find(node => node.id === 'task-input')
    const sendTask = graph.nodes.find(node => node.id === 'send-task')
    const voiceInput = graph.nodes.find(node => node.id === 'voice-input')
    const runtimeToggle = graph.nodes.find(node => node.id === 'runtime-toggle')
    const tabActivity = graph.nodes.find(node => node.id === 'inspector-tab-activity')
    const tabChanges = graph.nodes.find(node => node.id === 'inspector-tab-changes')
    const tabArtifacts = graph.nodes.find(node => node.id === 'inspector-tab-artifacts')

    // From Composer / Header to Inspector Tab
    expect(taskInput?.neighbors?.right).toBe('inspector-tab-activity')
    expect(sendTask?.neighbors?.right).toBe('inspector-tab-activity')
    expect(runtimeToggle?.neighbors?.right).toBe('inspector-tab-activity')

    // Inside Inspector Tabs
    expect(tabActivity?.neighbors?.left).toBe('task-input')
    expect(tabActivity?.neighbors?.right).toBe('inspector-tab-changes')
    expect(tabChanges?.neighbors?.left).toBe('inspector-tab-activity')
    expect(tabChanges?.neighbors?.right).toBe('inspector-tab-artifacts')
    expect(tabArtifacts?.neighbors?.left).toBe('inspector-tab-changes')

    // From Inspector Tabs back to Header & Composer
    expect(tabActivity?.neighbors?.up).toBe('runtime-toggle')
    expect(tabActivity?.neighbors?.down).toBe('task-input')
  })

  it('在变更页中支持从文件列表项向左直接返回输入框', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      inspectorPage: 'changes',
      artifactChangeIds: ['file-1', 'file-2'],
      selectedArtifactChangeId: 'file-1',
      canReviewArtifacts: true,
    })

    const fileNode = graph.nodes.find(node => node.id === 'inspector-file-file-1')
    expect(fileNode?.neighbors?.left).toBe('task-input')
    expect(fileNode?.neighbors?.right).toBe('artifact-accept-file-1')
  })

  it('文件消失后优先保持原位置，并使用稳定 changeId', () => {
    const before = [artifactChange('change-a'), artifactChange('change-b'), artifactChange('change-c')]
    const after = [artifactChange('change-a'), artifactChange('change-c')]

    expect(selectArtifactChangeAfterMutation('change-b', before, after, 'change-b')).toBe('change-c')
    expect(selectArtifactChangeAfterMutation('change-c', before, after, 'change-b')).toBe('change-c')
  })
})

describe('PS5 多项目与多会话空间焦点导航', () => {
  it('生成顶部项目栏与会话栏焦点节点，并建立纵向与横向关联', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      projectCount: 2,
      activeProjectIndex: 0,
      sessionCount: 2,
      activeSessionIndex: 0,
    })

    const nodeIds = graph.nodes.map(node => node.id)
    expect(nodeIds).toContain('project-tab-0')
    expect(nodeIds).toContain('project-tab-1')
    expect(nodeIds).toContain('project-tab-new')
    expect(nodeIds).toContain('session-card-0')
    expect(nodeIds).toContain('session-card-1')
    expect(nodeIds).toContain('session-card-new')

    // Project tabs horizontal linking
    const pTab0 = graph.nodes.find(node => node.id === 'project-tab-0')
    const pTab1 = graph.nodes.find(node => node.id === 'project-tab-1')
    const pTabNew = graph.nodes.find(node => node.id === 'project-tab-new')
    expect(pTab0?.neighbors?.right).toBe('project-tab-1')
    expect(pTab1?.neighbors?.left).toBe('project-tab-0')
    expect(pTab1?.neighbors?.right).toBe('project-tab-new')
    expect(pTabNew?.neighbors?.left).toBe('project-tab-1')

    // Vertical transition from project tab down to session card
    expect(pTab0?.neighbors?.down).toBe('session-card-0')

    // Session cards horizontal and vertical linking
    const sCard0 = graph.nodes.find(node => node.id === 'session-card-0')
    const sCard1 = graph.nodes.find(node => node.id === 'session-card-1')
    const sCardNew = graph.nodes.find(node => node.id === 'session-card-new')
    expect(sCard0?.neighbors?.right).toBe('session-card-1')
    expect(sCard1?.neighbors?.left).toBe('session-card-0')
    expect(sCard1?.neighbors?.right).toBe('session-card-new')
    expect(sCardNew?.neighbors?.left).toBe('session-card-1')

    expect(sCard0?.neighbors?.up).toBe('project-tab-0')
    expect(sCard0?.neighbors?.down).toBe('task-input')

    // Task input points up to session card
    const inputNode = graph.nodes.find(node => node.id === 'task-input')
    expect(inputNode?.neighbors?.up).toBe('session-card-0')
  })
})

describe('语音输入与设置焦点', () => {
  it('主工作区焦点图包含 voice-input 并正确关联输入框与发送按钮', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      canSend: true,
      canPauseTask: true,
    })

    expect(graph.nodes.map(node => node.id)).toContain('voice-input')
    const voiceNode = graph.nodes.find(node => node.id === 'voice-input')
    expect(voiceNode?.neighbors?.left).toBe('pause-task')
    expect(voiceNode?.neighbors?.right).toBe('send-task')
    expect(voiceNode?.neighbors?.up).toBe('task-input')

    const pauseNode = graph.nodes.find(node => node.id === 'pause-task')
    expect(pauseNode?.neighbors?.right).toBe('voice-input')

    const sendNode = graph.nodes.find(node => node.id === 'send-task')
    expect(sendNode?.neighbors?.left).toBe('voice-input')
  })

  it('设置面板焦点图包含语音输入按键、模式与测试项', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      settingsOpen: true,
      settingsReady: true,
    })

    expect(graph.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'voice-input-key',
      'voice-input-mode',
      'voice-input-test',
    ]))
  })
})

describe('审批工具参数', () => {
  const approval: TaskApproval = {
    requestId: 'rpc-1',
    approvalId: 'approval-1',
    toolName: 'bash',
    callId: 'call-2',
    reason: '需要执行命令',
  }

  it('只关联 callId 完全匹配的 tool/call 并格式化完整参数', () => {
    const events: TaskEvent[] = [
      toolCallEvent('call-1', '{"command":"wrong"}', 1),
      toolCallEvent('call-2', '{"command":"pnpm test","timeout":30000}', 2),
    ]

    expect(approvalEvidence(approval, events)).toEqual({
      command: 'pnpm test',
      arguments: '{\n  "command": "pnpm test",\n  "timeout": 30000\n}',
    })
  })

  it('没有匹配调用时不按工具名猜测参数', () => {
    expect(approvalEvidence(approval, [toolCallEvent('other-call', '{"command":"wrong"}', 1)])).toEqual({
      arguments: '未提供可关联的工具调用参数。',
    })
  })
})

describe('TaskInspector 动态聚合 (aggregateActivityItems)', () => {
  it('连续的 assistant/chunk 流式片段合并为单一的助手回复', () => {
    const events: TaskEvent[] = [
      mockEvent('assistant/chunk', 1, { chunk: { type: 'text-delta', text: '你好' } }),
      mockEvent('assistant/chunk', 2, { chunk: { type: 'text-delta', text: '，' } }),
      mockEvent('assistant/chunk', 3, { chunk: { type: 'text-delta', text: '我正在分析' } }),
      mockEvent('assistant/chunk', 4, { chunk: { type: 'text-delta', text: '代码' } }),
      mockEvent('assistant/chunk', 5, { chunk: { type: 'finish' } }),
    ]

    const items = aggregateActivityItems(events)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: '助手回复',
      badgeKind: 'assistant',
      badgeLabel: '助手',
      content: '你好，我正在分析代码',
      contentKind: 'text',
    })
  })

  it('工具调用与执行结果正确分隔助手流式输出', () => {
    const events: TaskEvent[] = [
      mockEvent('turn/start', 1, { turn: 1 }),
      mockEvent('assistant/chunk', 2, { chunk: { type: 'text-delta', text: '让我运行测试' } }),
      mockEvent('tool/call', 3, { name: 'bash', arguments: '{"command":"pnpm test"}' }),
      mockEvent('tool/result', 4, { name: 'bash', output: '76 passed' }),
      mockEvent('assistant/chunk', 5, { chunk: { type: 'text-delta', text: '所有测试均已通过！' } }),
      mockEvent('turn/end', 6, { reason: { kind: 'completed' } }),
    ]

    const items = aggregateActivityItems(events)
    expect(items).toHaveLength(6)

    expect(items[0]?.title).toBe('回合 #1 开始')
    expect(items[1]?.content).toBe('让我运行测试')
    expect(items[2]?.title).toBe('调用工具 · bash')
    expect(items[2]?.content).toBe('$ pnpm test')
    expect(items[2]?.contentKind).toBe('code')
    expect(items[3]?.title).toBe('工具执行结果')
    expect(items[3]?.content).toBe('76 passed')
    expect(items[4]?.content).toBe('所有测试均已通过！')
    expect(items[5]?.title).toBe('回合结束')
    expect(items[5]?.content).toBe('执行完成')
  })

  it('提取 todo/write 计划并生成结构化清单', () => {
    const events: TaskEvent[] = [
      mockEvent('todo/write', 1, {
        todos: [
          { content: '确认界面需求', status: 'completed' },
          { content: '重构动态列表', status: 'in_progress' },
          { content: '验证测试', status: 'pending' },
        ],
      }),
    ]

    const items = aggregateActivityItems(events)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('更新执行计划 (3 项)')
    expect(items[0]?.badgeKind).toBe('plan')
    expect(items[0]?.contentKind).toBe('todos')
    expect(items[0]?.todoItems).toEqual([
      { content: '确认界面需求', status: 'completed' },
      { content: '重构动态列表', status: 'in_progress' },
      { content: '验证测试', status: 'pending' },
    ])
  })

  it('正确解析用户指令、审批请求与处理结果', () => {
    const events: TaskEvent[] = [
      mockEvent('user/message', 1, { text: '重构 TaskInspector' }),
      mockEvent('approval/requested', 2, { toolName: 'bash', reason: '需要执行终端命令' }, 'control'),
      mockEvent('approval/resolved', 3, { outcome: 'allowed-once' }, 'control'),
    ]

    const items = aggregateActivityItems(events)
    expect(items).toHaveLength(3)
    expect(items[0]?.badgeLabel).toBe('用户')
    expect(items[0]?.content).toBe('重构 TaskInspector')
    expect(items[1]?.title).toBe('请求审批 · bash')
    expect(items[1]?.content).toBe('需要执行终端命令')
    expect(items[2]?.title).toBe('审批处理')
    expect(items[2]?.content).toBe('已允许执行')
  })

  it('正确展示错误与异常状态', () => {
    const events: TaskEvent[] = [
      mockEvent('host/agent-error', 1, { message: 'DSH 连接中断' }, 'error'),
    ]

    const items = aggregateActivityItems(events)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('error')
    expect(items[0]?.badgeKind).toBe('error')
    expect(items[0]?.title).toBe('执行异常')
    expect(items[0]?.content).toBe('DSH 连接中断')
  })

  it('空事件列表返回空数组', () => {
    expect(aggregateActivityItems([])).toEqual([])
  })
})

function mockEvent(type: string, sequence: number, data: unknown = {}, kind: TaskEvent['kind'] = 'session'): TaskEvent {
  return {
    id: `task-1:${sequence}`,
    taskId: 'task-1',
    kind,
    type,
    sequence,
    time: 1000 + sequence * 10,
    data,
  }
}

function toolCallEvent(callId: string, argumentsValue: string, sequence: number): TaskEvent {
  return {
    id: `task-1:${sequence}`,
    taskId: 'task-1',
    kind: 'session',
    type: 'tool/call',
    sequence,
    time: sequence,
    data: { turn: 1, step: 1, callId, name: 'bash', arguments: argumentsValue },
  }
}

function artifactChange(changeId: string): TaskFileChange {
  return {
    changeId,
    path: `${changeId}.txt`,
    kind: 'modified',
    review: 'pending',
    diff: { kind: 'binary' },
  }
}

