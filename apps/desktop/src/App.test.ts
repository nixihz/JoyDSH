import { describe, expect, it } from 'vitest'
import type { TaskApproval, TaskEvent, TaskFileChange, TaskQuestionRequest } from '@joydsh/domain'
import { createTaskProjection, projectTaskEvent } from '@joydsh/task-projection'
import { createAppFocusGraph, type AppFocusGraphOptions } from './app-focus.ts'
import { approvalEvidence } from './approval-evidence.ts'
import { buildQuestionAnswer, cycleProjectIndex, resolveDisplayedTask, resolveReconnectionTask, resolveWorkspaceProjectPermission, selectArtifactChangeAfterMutation, sessionTitleFromProjectionEvent } from './App.tsx'
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
  archiveViewOpen: false,
  archivedTaskCount: 0,
  canArchiveTask: true,
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

describe('会话标题', () => {
  it('从标题投影事件读取自动生成的名称', () => {
    const event: TaskEvent = {
      id: 'projection-1',
      taskId: 'session-1',
      kind: 'control',
      type: 'session/projection',
      time: 100,
      data: { key: 'title', value: '实现会话自动命名', seq: 3 },
    }

    expect(sessionTitleFromProjectionEvent(event)).toBe('实现会话自动命名')
    expect(sessionTitleFromProjectionEvent({ ...event, data: { key: 'goal', value: 'ignored' } })).toBeUndefined()
  })
})

describe('审批与权限焦点', () => {
  it('命令中心仅在存在待审批时提供审批入口', () => {
    const withApproval = createAppFocusGraph(BASE_OPTIONS)
    const withoutApproval = createAppFocusGraph({ ...BASE_OPTIONS, pendingApprovalCount: 0 })

    expect(withApproval.nodes.map(node => node.id)).toContain('command-approvals')
    expect(withoutApproval.nodes.map(node => node.id)).not.toContain('command-approvals')
  })

  it('命令中心分别提供问题与方案审阅入口', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      pendingQuestionCount: 2,
      pendingPlanReviewCount: 1,
    })

    expect(graph.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'command-approvals',
      'command-questions',
      'command-plan-reviews',
    ]))
  })

  it('普通问题详情提供选项、自由文本、取消和安全提交焦点', () => {
    const unanswered = createAppFocusGraph({
      ...BASE_OPTIONS,
      pendingResponseKind: 'question',
      questionOptionCount: 3,
      questionAnswered: false,
      questionHasPrevious: false,
      questionHasNext: false,
    })
    const answered = createAppFocusGraph({
      ...BASE_OPTIONS,
      pendingResponseKind: 'question',
      questionOptionCount: 3,
      questionAnswered: true,
      questionHasPrevious: false,
      questionHasNext: false,
    })

    expect(unanswered.entryId).toBe('question-option-0')
    expect(unanswered.nodes.map(node => node.id)).toEqual([
      'question-back',
      'question-option-0',
      'question-option-1',
      'question-option-2',
      'question-custom',
      'question-cancel',
      'question-skip',
    ])
    expect(answered.nodes.map(node => node.id)).toContain('question-submit')
    expect(answered.nodes.find(node => node.id === 'question-submit')?.neighbors?.left).toBe('question-skip')
  })

  it('方案审阅默认聚焦拒绝，并保留讨论与批准路径', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      pendingResponseKind: 'plan-review',
      planReviewHasDecline: true,
    })

    expect(graph.entryId).toBe('plan-review-decline')
    expect(graph.nodes.map(node => node.id)).toEqual([
      'plan-review-back',
      'plan-review-discuss',
      'plan-review-decline',
      'plan-review-approve',
    ])
    expect(graph.nodes.find(node => node.id === 'plan-review-decline')?.neighbors?.right).toBe('plan-review-approve')
  })

  it('命令中心提供归档、归档列表和恢复焦点', () => {
    const command = createAppFocusGraph({ ...BASE_OPTIONS, archivedTaskCount: 2 })
    expect(command.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'command-archive-task',
      'command-archives',
    ]))

    const archives = createAppFocusGraph({
      ...BASE_OPTIONS,
      archiveViewOpen: true,
      archivedTaskCount: 2,
    })
    expect(archives.entryId).toBe('archive-back')
    expect(archives.nodes.map(node => node.id)).toEqual([
      'archive-back',
      'archive-restore-0',
      'archive-restore-1',
    ])
  })

  it('运行中不把禁用的归档动作加入焦点图', () => {
    const graph = createAppFocusGraph({ ...BASE_OPTIONS, canArchiveTask: false })
    expect(graph.nodes.map(node => node.id)).not.toContain('command-archive-task')
    expect(graph.nodes.map(node => node.id)).toContain('command-archives')
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

  it('启用完全访问时默认聚焦取消，并可切换到风险确认', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      permissionConfirmationOpen: true,
    })

    expect(graph.entryId).toBe('permission-cancel')
    expect(graph.nodes.map(node => node.id)).toEqual(['permission-cancel', 'permission-confirm'])
    expect(graph.nodes[0]?.neighbors?.right).toBe('permission-confirm')
    expect(graph.nodes[1]?.neighbors?.left).toBe('permission-cancel')
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
    expect(itemNode?.neighbors?.right).toBe('project-permission-0')
    expect(graph.nodes.map(node => node.id)).toContain('project-permission-0')
    expect(graph.nodes.find(node => node.id === 'project-permission-0')?.neighbors?.left).toBe('project-item-0')
  })

  it('主任务存在待审批时把审批入口加入焦点图', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      canPauseTask: false,
    })

    expect(graph.entryId).toBe('task-approval-open')
    expect(graph.nodes.map(node => node.id)).toContain('task-approval-open')
  })

  it('主任务存在问题或方案审阅时把待回应入口置于输入框之前', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      pendingApprovalCount: 0,
      pendingQuestionCount: 1,
      pendingPlanReviewCount: 1,
    })

    expect(graph.nodes.map(node => node.id)).toContain('task-response-open')
    expect(graph.nodes.find(node => node.id === 'task-input')?.neighbors?.up).toBe('task-response-open')
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

describe('结构化问题回答', () => {
  it('按题型编码选项、自由文本与跳过结果', () => {
    const request: TaskQuestionRequest = {
      requestId: 'question-rpc-1',
      questions: [
        { id: 'single', question: '单选', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'multi', question: '多选', options: [{ label: 'X' }], multiSelect: true },
        { id: 'skipped', question: '跳过' },
      ],
    }

    expect(buildQuestionAnswer(request, {
      single: { selected: ['A'], custom: '自定义答案', skipped: false },
      multi: { selected: ['X'], custom: '补充说明', skipped: false },
      skipped: { selected: [], custom: '', skipped: true },
    })).toEqual({
      answers: [
        { id: 'single', selected: [], custom: '自定义答案' },
        { id: 'multi', selected: ['X'], custom: '补充说明' },
        { id: 'skipped', selected: [] },
      ],
    })
  })
})

describe('任务检查器焦点', () => {
  it('待发送附件提供预览与移除路径，并连接输入框和工具栏', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      pendingApprovalCount: 0,
      canPauseTask: false,
      pendingAttachmentIds: ['image-a', 'image-b'],
    })

    expect(graph.nodes.find(node => node.id === 'task-input')?.neighbors?.down).toBe('attachment-preview-image-a')
    expect(graph.nodes.find(node => node.id === 'attachment-preview-image-a')?.neighbors?.right).toBe('attachment-remove-image-a')
    expect(graph.nodes.find(node => node.id === 'attachment-remove-image-a')?.neighbors?.right).toBe('attachment-preview-image-b')
    expect(graph.nodes.find(node => node.id === 'attachment-remove-image-b')?.neighbors?.down).toBe('voice-input')
    expect(graph.nodes.find(node => node.id === 'voice-input')?.neighbors?.up).toBe('attachment-remove-image-b')
  })

  it('图片灯箱默认聚焦关闭，并提供完整缩放焦点链', () => {
    const graph = createAppFocusGraph({ ...BASE_OPTIONS, lightboxOpen: true })
    expect(graph.entryId).toBe('lightbox-close')
    expect(graph.nodes.map(node => node.id)).toEqual([
      'lightbox-zoom-out',
      'lightbox-reset',
      'lightbox-zoom-in',
      'lightbox-close',
    ])
    expect(graph.nodes.find(node => node.id === 'lightbox-close')?.neighbors?.left).toBe('lightbox-zoom-in')
  })

  it('把当前检查器页作为任务区域的下一个焦点区', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      pendingApprovalCount: 0,
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

  it('检查器隐藏后移除右栏节点，并把空间导航收束到显示按钮', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      pendingApprovalCount: 0,
      inspectorOpen: false,
      inspectorPage: 'changes',
      artifactChangeIds: ['change-a'],
    })

    expect(graph.nodes.map(node => node.id)).toContain('inspector-toggle')
    expect(graph.nodes.map(node => node.id)).not.toContain('inspector-tab-changes')
    expect(graph.nodes.map(node => node.id)).not.toContain('inspector-file-change-a')
    expect(graph.nodes.find(node => node.id === 'task-input')?.neighbors?.right).toBe('inspector-toggle')
    expect(graph.nodes.find(node => node.id === 'runtime-toggle')?.neighbors?.right).toBe('inspector-toggle')
  })

  it('建立输入框、发送按钮、工具栏与检查器标签页之间的双向横向空间导航', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      pendingApprovalCount: 0,
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
    expect(runtimeToggle?.neighbors?.right).toBe('inspector-toggle')

    // Inside Inspector Tabs
    expect(tabActivity?.neighbors?.left).toBe('inspector-toggle')
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
      pendingApprovalCount: 0,
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
      pendingApprovalCount: 0,
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

    // Session cards vertical sidebar linking
    const sCardNew = graph.nodes.find(node => node.id === 'session-card-new')
    const sCard0 = graph.nodes.find(node => node.id === 'session-card-0')
    const sCard1 = graph.nodes.find(node => node.id === 'session-card-1')
    expect(sCardNew?.neighbors?.up).toBe('project-tab-0')
    expect(sCardNew?.neighbors?.down).toBe('session-card-0')
    expect(sCard0?.neighbors?.up).toBe('session-card-new')
    expect(sCard0?.neighbors?.down).toBe('session-card-1')
    expect(sCard1?.neighbors?.up).toBe('session-card-0')
    expect(sCard1?.neighbors?.down).toBe('task-input')

    expect(sCard0?.neighbors?.right).toBe('task-input')

    // Task input points left to active session card in sidebar
    const inputNode = graph.nodes.find(node => node.id === 'task-input')
    expect(inputNode?.neighbors?.left).toBe('session-card-0')
  })

  it('当项目没有活跃会话时正确构建焦点拓扑并提供空状态与新建会话路径', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      hasActiveTask: false,
      commandCenterOpen: false,
      pendingApprovalCount: 0,
      projectCount: 3,
      activeProjectIndex: 1,
      sessionCount: 0,
      activeSessionIndex: 0,
    })

    expect(graph.entryId).toBe('project-tab-1')
    const nodeIds = graph.nodes.map(node => node.id)
    expect(nodeIds).toContain('project-tab-0')
    expect(nodeIds).toContain('project-tab-1')
    expect(nodeIds).toContain('project-tab-2')
    expect(nodeIds).toContain('project-tab-new')
    expect(nodeIds).toContain('session-card-new')
    expect(nodeIds).toContain('empty-new-session')
    expect(nodeIds).toContain('open-project-center')

    // From project tab 1 down to session-card-new
    const pTab1 = graph.nodes.find(node => node.id === 'project-tab-1')
    expect(pTab1?.neighbors?.down).toBe('session-card-new')

    // From session-card-new
    const sCardNew = graph.nodes.find(node => node.id === 'session-card-new')
    expect(sCardNew?.neighbors?.up).toBe('project-tab-1')
    expect(sCardNew?.neighbors?.down).toBe('empty-new-session')
    expect(sCardNew?.neighbors?.right).toBe('empty-new-session')

    // From empty-new-session in main area
    const emptyNew = graph.nodes.find(node => node.id === 'empty-new-session')
    expect(emptyNew?.neighbors?.left).toBe('session-card-new')
    expect(emptyNew?.neighbors?.right).toBe('open-project-center')
  })

  it('新建会话草稿立即进入独立输入区，焦点不再落在现有会话历史里', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      pendingApprovalCount: 0,
      canPauseTask: false,
      hasActiveTask: true,
      draftSession: true,
      projectCount: 2,
      activeProjectIndex: 0,
      sessionCount: 2,
      activeSessionIndex: 0,
    })

    const nodeIds = graph.nodes.map(node => node.id)
    expect(nodeIds).toContain('task-input')
    expect(nodeIds).not.toContain('empty-new-session')

    const inputNode = graph.nodes.find(node => node.id === 'task-input')
    expect(inputNode?.neighbors?.left).toBe('session-card-new')
    expect(inputNode?.neighbors?.up).toBe('session-card-new')

    const sCardNew = graph.nodes.find(node => node.id === 'session-card-new')
    expect(sCardNew?.neighbors?.right).toBe('task-input')

    const pTab0 = graph.nodes.find(node => node.id === 'project-tab-0')
    expect(pTab0?.neighbors?.down).toBe('session-card-new')
  })

  it('草稿会话不会回落到现有任务，避免把新输入当成当前历史的续写', () => {
    const tasks = [
      { id: 'task-old', workspacePath: '/proj', running: false, blank: false, updatedAt: 1 },
      { id: 'task-other', workspacePath: '/proj', running: false, blank: false, updatedAt: 2 },
    ]

    expect(resolveDisplayedTask(tasks, 'task-old', true)).toBeUndefined()
    expect(resolveDisplayedTask(tasks, undefined, true)).toBeUndefined()
    expect(resolveDisplayedTask(tasks, 'task-other', false)?.id).toBe('task-other')
    expect(resolveDisplayedTask(tasks, undefined, false)?.id).toBe('task-old')
  })

  it('L1 / R1 与肩键在多项目间双向循环计算目标索引', () => {
    // 3 projects: 0, 1, 2
    expect(cycleProjectIndex(0, 3, 'next')).toBe(1)
    expect(cycleProjectIndex(1, 3, 'next')).toBe(2)
    expect(cycleProjectIndex(2, 3, 'next')).toBe(0)

    expect(cycleProjectIndex(0, 3, 'previous')).toBe(2)
    expect(cycleProjectIndex(2, 3, 'previous')).toBe(1)
    expect(cycleProjectIndex(1, 3, 'previous')).toBe(0)

    // Unselected state (-1)
    expect(cycleProjectIndex(-1, 3, 'next')).toBe(0)
    expect(cycleProjectIndex(-1, 3, 'previous')).toBe(2)

    // Single project
    expect(cycleProjectIndex(0, 1, 'next')).toBe(0)
    expect(cycleProjectIndex(0, 1, 'previous')).toBe(0)
  })

  it('重连时只恢复匹配当前工作区路径的会话，避免跳到其他项目', () => {
    const taskA = { id: 'task-a', workspacePath: '/path/project-a', running: false, blank: false, updatedAt: 100 }
    const taskB = { id: 'task-b', workspacePath: '/path/project-b', running: false, blank: false, updatedAt: 200 }
    const listed = [taskB] // 运行时当前只有 project-b 的会话

    // 1. 当 workspacePath 已明确为 project-a 时，由于没有匹配会话，应返回 undefined，绝不 fallback 到 taskB 造成强制切项目
    expect(resolveReconnectionTask(listed, '/path/project-a')).toBeUndefined()

    // 2. 当 workspacePath 为 project-b 时，正常匹配到 taskB
    expect(resolveReconnectionTask(listed, '/path/project-b')).toEqual(taskB)

    // 3. 当 workspacePath 尚未初始化 (空字符串) 时，才使用首个会话
    expect(resolveReconnectionTask([taskA, taskB], '')).toEqual(taskA)
  })
})

describe('语音输入与设置焦点', () => {
  it('手柄下拉选择层接管焦点并默认选中当前项', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      settingsOpen: true,
      gamepadSelectOptionIds: ['gamepad-select-option-0', 'gamepad-select-option-2'],
      gamepadSelectSelectedId: 'gamepad-select-option-2',
    })

    expect(graph.entryId).toBe('gamepad-select-option-2')
    expect(graph.nodes.map(node => node.id)).toEqual([
      'gamepad-select-close',
      'gamepad-select-option-0',
      'gamepad-select-option-2',
    ])
    expect(graph.nodes.find(node => node.id === 'gamepad-select-option-2')?.neighbors?.down)
      .toBe('gamepad-select-close')
  })

  it('主工作区焦点图包含 voice-input 并正确关联输入框与发送按钮', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      canSend: true,
      canPauseTask: true,
    })

    expect(graph.nodes.map(node => node.id)).toContain('voice-input')
    expect(graph.nodes.map(node => node.id)).toContain('screenshot-button')
    expect(graph.nodes.map(node => node.id)).toContain('paste-image')

    const voiceNode = graph.nodes.find(node => node.id === 'voice-input')
    expect(voiceNode?.neighbors?.left).toBe('pause-task')
    expect(voiceNode?.neighbors?.right).toBe('screenshot-button')
    expect(voiceNode?.neighbors?.up).toBe('task-input')

    const screenshotNode = graph.nodes.find(node => node.id === 'screenshot-button')
    expect(screenshotNode?.neighbors?.left).toBe('voice-input')
    expect(screenshotNode?.neighbors?.right).toBe('paste-image')
    expect(screenshotNode?.neighbors?.up).toBe('task-input')

    const pasteNode = graph.nodes.find(node => node.id === 'paste-image')
    expect(pasteNode?.neighbors?.left).toBe('screenshot-button')
    expect(pasteNode?.neighbors?.right).toBe('send-task')
    expect(pasteNode?.neighbors?.up).toBe('task-input')

    const pauseNode = graph.nodes.find(node => node.id === 'pause-task')
    expect(pauseNode?.neighbors?.right).toBe('voice-input')

    expect(graph.nodes.map(node => node.id)).not.toContain('attach-image')

    const sendNode = graph.nodes.find(node => node.id === 'send-task')
    expect(sendNode?.neighbors?.left).toBe('paste-image')
  })

  it('设置面板焦点图包含语音输入按键与测试项，不再重复配置 Spokenly 触发模式', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      settingsOpen: true,
      settingsReady: true,
    })

    expect(graph.nodes.map(node => node.id)).toEqual(expect.arrayContaining([
      'voice-input-gamepad-button',
      'voice-input-key',
      'voice-input-test',
    ]))
    expect(graph.nodes.map(node => node.id)).not.toContain('voice-input-mode')
  })

  it('辅助功能未授权时把系统授权入口加入设置焦点图', () => {
    const graph = createAppFocusGraph({
      ...BASE_OPTIONS,
      commandCenterOpen: false,
      settingsOpen: true,
      settingsReady: true,
      voicePermissionActionAvailable: true,
    })

    const nodeIds = graph.nodes.map(node => node.id)
    expect(nodeIds).toContain('voice-input-permission')
    expect(nodeIds.indexOf('voice-input-permission')).toBeLessThan(nodeIds.indexOf('voice-input-test'))
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

describe('工作区项目权限解析 (resolveWorkspaceProjectPermission)', () => {
  it('优先从工作区目录获取已配置的项目权限', () => {
    const projects = [
      { name: 'JoyDSH', path: '/opt/case/iamx/JoyDSH', recent: true, permissionMode: 'full-access' as const },
      { name: 'account', path: '/opt/case/iamx/account', recent: false, permissionMode: 'standard' as const },
    ]

    expect(resolveWorkspaceProjectPermission(projects, '/opt/case/iamx/JoyDSH', 'standard')).toBe('full-access')
    expect(resolveWorkspaceProjectPermission(projects, '/opt/case/iamx/account', 'full-access')).toBe('standard')
  })

  it('未匹配到项目时回退到默认或传入的备用权限', () => {
    const projects = [
      { name: 'JoyDSH', path: '/opt/case/iamx/JoyDSH', recent: true, permissionMode: 'full-access' as const },
    ]

    expect(resolveWorkspaceProjectPermission(projects, '/opt/case/iamx/other', 'full-access')).toBe('full-access')
    expect(resolveWorkspaceProjectPermission(projects, '/opt/case/iamx/other')).toBe('standard')
  })
})

describe('会话历史多回合对话流 (Task Conversation Stream)', () => {
  it('历史回放正确还原多回合用户消息与助手回复', () => {
    const events: TaskEvent[] = [
      mockEvent('user/message', 1, { text: '重构权限体系' }),
      mockEvent('turn/start', 2, { turn: 1 }),
      mockEvent('assistant/chunk', 3, { chunk: { type: 'text-delta', text: '正在分析权限规范...' } }),
      mockEvent('turn/end', 4, { reason: { kind: 'completed' } }),
      mockEvent('user/message', 5, { text: '增加完全访问模式测试' }),
      mockEvent('turn/start', 6, { turn: 2 }),
      mockEvent('assistant/chunk', 7, { chunk: { type: 'text-delta', text: '测试已补充并通过！' } }),
      mockEvent('turn/end', 8, { reason: { kind: 'completed' } }),
    ]

    const projection = events.reduce((acc, ev) => ({
      ...acc,
      ...projectTaskEvent(acc, ev),
    }), createTaskProjection('task-1'))

    const visibleMessages = projection.messages.filter(m => !m.isSystemInjection)
    expect(visibleMessages).toHaveLength(4)
    expect(visibleMessages[0]).toMatchObject({ role: 'user', content: '重构权限体系' })
    expect(visibleMessages[1]).toMatchObject({ role: 'assistant', content: '正在分析权限规范...' })
    expect(visibleMessages[2]).toMatchObject({ role: 'user', content: '增加完全访问模式测试' })
    expect(visibleMessages[3]).toMatchObject({ role: 'assistant', content: '测试已补充并通过！' })
  })

  it('客户端乐观消息与服务端确认事件无缝匹配不重复', () => {
    let proj = createTaskProjection('task-1')
    // Optimistic message added on submit
    proj = {
      ...proj,
      messages: [
        {
          id: 'user-input-1700000000000',
          role: 'user',
          content: '运行所有测试',
          time: 1700000000000,
          isSystemInjection: false,
        },
      ],
    }

    // Authoritative event arrives from DSH
    proj = projectTaskEvent(proj, mockEvent('user/message', 1, { text: '运行所有测试' }))

    expect(proj.messages).toHaveLength(1)
    expect(proj.messages[0]?.id).toBe('task-1:1')
    expect(proj.messages[0]?.content).toBe('运行所有测试')
  })

  it('在多轮任务会话中清理悬挂的流式占位避免残留转圈', () => {
    let proj = createTaskProjection('task-1')
    proj = projectTaskEvent(proj, mockEvent('turn/start', 1))
    expect(proj.messages).toHaveLength(1)
    expect(proj.messages[0]?.status).toBe('streaming')

    // 收到用户权限指令
    proj = projectTaskEvent(proj, mockEvent('user/message', 2, { text: '/permission danger-full-access' }))
    // 助手正常回复权限已设置
    proj = projectTaskEvent(proj, mockEvent('turn/start', 3))
    proj = projectTaskEvent(proj, mockEvent('assistant/chunk', 4, { chunk: { type: 'text-delta', text: '已将权限设为 workspace-write' } }))
    proj = projectTaskEvent(proj, mockEvent('turn/end', 5, { reason: { kind: 'completed' } }))

    // 用户发下一轮消息
    proj = projectTaskEvent(proj, mockEvent('user/message', 6, { text: '新问题' }))

    expect(proj.messages).toHaveLength(3)
    expect(proj.messages[0]?.content).toBe('/permission danger-full-access')
    expect(proj.messages[1]?.content).toBe('已将权限设为 workspace-write')
    expect(proj.messages[1]?.status).toBe('completed')
    expect(proj.messages[2]?.content).toBe('新问题')
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
