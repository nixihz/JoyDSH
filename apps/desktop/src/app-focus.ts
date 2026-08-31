import type { FocusGraph, FocusNode } from '@joydsh/focus'
import type { WorkspacePermissionMode } from './workspace-service.ts'

export interface AppFocusGraphOptions {
  connected: boolean
  hasActiveTask: boolean
  hasFailureAction: boolean
  busy: boolean
  canPauseTask: boolean
  canSend: boolean
  settingsOpen: boolean
  commandCenterOpen: boolean
  approvalDetailOpen: boolean
  archiveViewOpen?: boolean
  archivedTaskCount?: number
  canArchiveTask?: boolean
  permissionConfirmationOpen?: boolean
  artifactConfirmationOpen: boolean
  commitPhase?: 'generating' | 'editing' | 'confirming' | 'committing' | 'failed' | 'completed'
  approvalResponding: boolean
  pendingApprovalCount: number
  pendingQuestionCount?: number
  pendingPlanReviewCount?: number
  pendingResponseKind?: 'question' | 'plan-review'
  questionOptionCount?: number
  questionAnswered?: boolean
  questionHasPrevious?: boolean
  questionHasNext?: boolean
  planReviewHasDecline?: boolean
  projectCenterOpen: boolean
  projectPermissionMode: WorkspacePermissionMode
  projectCount: number
  activeProjectIndex?: number
  sessionCount?: number
  activeSessionIndex?: number
  draftSession?: boolean
  hasWorkspaceBase: boolean
  canCreateProject: boolean
  selectedProvider: 'deepseek-official' | 'openai'
  settingsReady: boolean
  credentialWritable: boolean
  canSaveSettings: boolean
  voicePermissionActionAvailable?: boolean
  inspectorPage: 'activity' | 'changes' | 'artifacts'
  inspectorOpen?: boolean
  artifactChangeIds: readonly string[]
  selectedArtifactChangeId?: string
  selectedArtifactAccepted: boolean
  canReviewArtifacts: boolean
  canRollbackArtifacts: boolean
  canCommitArtifacts: boolean
  canContinueCommit: boolean
  lightboxOpen?: boolean
  pendingAttachmentIds?: readonly string[]
  gamepadSelectOptionIds?: readonly string[]
  gamepadSelectSelectedId?: string
}

export function createAppFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  if ((options.gamepadSelectOptionIds?.length ?? 0) > 0) return createGamepadSelectFocusGraph(options)
  if (options.lightboxOpen) {
    return {
      entryId: 'lightbox-close',
      nodes: [
        { id: 'lightbox-zoom-out', group: 'lightbox', order: 0, neighbors: { right: 'lightbox-reset' } },
        { id: 'lightbox-reset', group: 'lightbox', order: 1, neighbors: { left: 'lightbox-zoom-out', right: 'lightbox-zoom-in' } },
        { id: 'lightbox-zoom-in', group: 'lightbox', order: 2, neighbors: { left: 'lightbox-reset', right: 'lightbox-close' } },
        { id: 'lightbox-close', group: 'lightbox', order: 3, neighbors: { left: 'lightbox-zoom-in' } },
      ],
    }
  }
  if (options.settingsOpen) return createSettingsFocusGraph(options)
  if (options.projectCenterOpen) return createProjectFocusGraph(options)
  if (options.commandCenterOpen && options.archiveViewOpen) return createArchiveFocusGraph(options.archivedTaskCount ?? 0)
  if (options.commandCenterOpen && options.permissionConfirmationOpen) return createPermissionConfirmationFocusGraph()
  if (options.commandCenterOpen && options.artifactConfirmationOpen) return createArtifactConfirmationFocusGraph()
  if (options.commandCenterOpen && options.commitPhase !== undefined) return createCommitFocusGraph(options)
  if (options.commandCenterOpen && options.pendingResponseKind === 'question') return createQuestionFocusGraph(options)
  if (options.commandCenterOpen && options.pendingResponseKind === 'plan-review') return createPlanReviewFocusGraph(options)
  if (options.commandCenterOpen && options.approvalDetailOpen) return createApprovalFocusGraph(options)
  if (options.commandCenterOpen) return createCommandFocusGraph(options)

  const projectCount = options.projectCount ?? 0
  const activeProjectIndex = Math.max(0, Math.min(options.activeProjectIndex ?? 0, Math.max(0, projectCount - 1)))
  const sessionCount = options.sessionCount ?? 0
  const activeSessionIndex = Math.max(0, Math.min(options.activeSessionIndex ?? 0, Math.max(0, sessionCount - 1)))

  const activeProjectTabId = projectCount > 0 ? `project-tab-${activeProjectIndex}` : 'project-tab-new'
  const activeSessionCardId = options.draftSession === true || sessionCount === 0
    ? 'session-card-new'
    : `session-card-${activeSessionIndex}`
  const inspectorTabId = `inspector-tab-${options.inspectorPage}`
  const inspectorOpen = options.inspectorOpen !== false
  const inspectorTargetId = inspectorOpen ? inspectorTabId : 'inspector-toggle'
  const hasInformationResponse = (options.pendingQuestionCount ?? 0) > 0 || (options.pendingPlanReviewCount ?? 0) > 0
  const firstComposerTarget = hasInformationResponse
    ? 'task-response-open'
    : options.pendingApprovalCount > 0
      ? 'task-approval-open'
      : options.hasFailureAction
        ? 'failure-model-settings'
        : 'task-input'

  const topTarget = projectCount > 0 ? activeProjectTabId : (options.hasActiveTask ? firstComposerTarget : 'open-project-center')
  const headerDown = options.busy ? undefined : topTarget

  const settingsNeighbors: FocusNode['neighbors'] = { right: 'runtime-toggle' }
  if (headerDown !== undefined) {
    settingsNeighbors.down = headerDown
    settingsNeighbors['previous-region'] = headerDown
    settingsNeighbors['next-region'] = headerDown
  }
  const nodes: FocusNode[] = [
    { id: 'settings-toggle', group: 'header', order: 0, neighbors: settingsNeighbors },
  ]
  if (!options.busy) {
    const runtimeNeighbors: FocusNode['neighbors'] = { left: 'settings-toggle', right: 'inspector-toggle' }
    if (headerDown !== undefined) {
      runtimeNeighbors.down = headerDown
      runtimeNeighbors['previous-region'] = headerDown
      runtimeNeighbors['next-region'] = headerDown
    }
    nodes.push({ id: 'runtime-toggle', group: 'header', order: 1, neighbors: runtimeNeighbors })
  } else {
    delete settingsNeighbors.right
  }

  // Project Bar Nodes (PS5 Top Ribbon)
  if (projectCount > 0 && !options.busy) {
    const projectTabIds = Array.from({ length: projectCount }, (_, i) => `project-tab-${i}`)
    projectTabIds.push('project-tab-new')

    for (const [index, id] of projectTabIds.entries()) {
      const prevId = projectTabIds[index - 1] ?? projectTabIds.at(-1) ?? id
      const nextId = projectTabIds[index + 1] ?? projectTabIds[0] ?? id
      const downTarget = sessionCount > 0
        ? activeSessionCardId
        : (projectCount > 0 ? 'session-card-new' : (options.hasActiveTask ? firstComposerTarget : 'open-project-center'))

      nodes.push({
        id,
        group: 'project-bar',
        order: index,
        neighbors: {
          left: prevId,
          right: nextId,
          up: 'settings-toggle',
          down: downTarget,
          'previous-region': 'settings-toggle',
          'next-region': downTarget,
        },
      })
    }
  }

  // Session Sidebar Nodes (Vertical Left Sidebar)
  if (!options.busy && (sessionCount > 0 || projectCount > 0)) {
    const sessionCardIds = ['session-card-new', ...Array.from({ length: sessionCount }, (_, i) => `session-card-${i}`)]
    const firstMainTarget = options.hasActiveTask
      ? firstComposerTarget
      : (projectCount > 0 ? 'empty-new-session' : 'open-project-center')

    for (const [index, id] of sessionCardIds.entries()) {
      const upTarget = index === 0 ? (projectCount > 0 ? activeProjectTabId : 'settings-toggle') : (sessionCardIds[index - 1] ?? activeProjectTabId)
      const downTarget = index === sessionCardIds.length - 1 ? firstMainTarget : (sessionCardIds[index + 1] ?? firstMainTarget)

      nodes.push({
        id,
        group: 'session-bar',
        order: index,
        neighbors: {
          up: upTarget,
          down: downTarget,
          right: firstMainTarget,
          'previous-region': projectCount > 0 ? activeProjectTabId : 'settings-toggle',
          'next-region': firstMainTarget,
        },
      })
    }
  }

  if (!options.hasActiveTask && !options.busy) {
    if (projectCount > 0) {
      nodes.push({
        id: 'empty-new-session',
        group: 'main',
        order: 0,
        neighbors: {
          up: 'session-card-new',
          left: 'session-card-new',
          right: 'open-project-center',
          down: inspectorTargetId,
          'previous-region': 'session-card-new',
          'next-region': inspectorTargetId,
        },
      })
      nodes.push({
        id: 'open-project-center',
        group: 'main',
        order: 1,
        neighbors: {
          up: 'session-card-new',
          left: 'empty-new-session',
          right: inspectorTargetId,
          down: inspectorTargetId,
          'previous-region': 'empty-new-session',
          'next-region': inspectorTargetId,
        },
      })
    } else {
      nodes.push({
        id: 'open-project-center',
        group: 'main',
        order: 0,
        neighbors: {
          up: 'settings-toggle',
          right: inspectorTargetId,
          'previous-region': 'settings-toggle',
          'next-region': inspectorTargetId,
        },
      })
    }
  }

  if (options.hasActiveTask) {
    const composerUpTarget = sessionCount > 0 ? activeSessionCardId : (projectCount > 0 ? activeProjectTabId : 'settings-toggle')
    const attachmentActionIds = (options.pendingAttachmentIds ?? []).flatMap(id => [
      `attachment-preview-${id}`,
      `attachment-remove-${id}`,
    ])
    const toolbarEntryId = options.canPauseTask ? 'pause-task' : 'voice-input'
    const composerDownTarget = attachmentActionIds[0] ?? toolbarEntryId
    const toolbarUpTarget = attachmentActionIds.at(-1) ?? 'task-input'

    if (hasInformationResponse) {
      const responseNeighbors: NonNullable<FocusNode['neighbors']> = {
        up: composerUpTarget,
        down: options.pendingApprovalCount > 0
          ? 'task-approval-open'
          : options.hasFailureAction ? 'failure-model-settings' : 'task-input',
        right: inspectorTargetId,
        'previous-region': composerUpTarget,
        'next-region': inspectorTargetId,
      }
      if (sessionCount > 0) responseNeighbors.left = activeSessionCardId
      nodes.push({ id: 'task-response-open', group: 'main', order: 0, neighbors: responseNeighbors })
    }

    if (options.pendingApprovalCount > 0) {
      const approvalNeighbors: NonNullable<FocusNode['neighbors']> = {
        up: hasInformationResponse ? 'task-response-open' : composerUpTarget,
        down: options.hasFailureAction ? 'failure-model-settings' : 'task-input',
        right: inspectorTargetId,
        'previous-region': composerUpTarget,
        'next-region': inspectorTargetId,
      }
      if (sessionCount > 0) approvalNeighbors.left = activeSessionCardId
      nodes.push({
        id: 'task-approval-open',
        group: 'main',
        order: 0,
        neighbors: approvalNeighbors,
      })
    }

    if (options.hasFailureAction) {
      const failureNeighbors: NonNullable<FocusNode['neighbors']> = {
        up: options.pendingApprovalCount > 0
          ? 'task-approval-open'
          : hasInformationResponse ? 'task-response-open' : composerUpTarget,
        down: 'task-input',
        right: inspectorTargetId,
        'previous-region': composerUpTarget,
        'next-region': inspectorTargetId,
      }
      if (sessionCount > 0) failureNeighbors.left = activeSessionCardId
      nodes.push({
        id: 'failure-model-settings',
        group: 'main',
        order: 0,
        neighbors: failureNeighbors,
      })
    }

    const inputNeighbors: NonNullable<FocusNode['neighbors']> = {
      up: options.hasFailureAction
        ? 'failure-model-settings'
        : options.pendingApprovalCount > 0
          ? 'task-approval-open'
          : hasInformationResponse ? 'task-response-open' : composerUpTarget,
      right: inspectorTargetId,
      'previous-region': composerUpTarget,
      'next-region': inspectorTargetId,
    }
    if (sessionCount > 0) inputNeighbors.left = activeSessionCardId
    inputNeighbors.down = composerDownTarget
    nodes.push({ id: 'task-input', group: 'main', order: 1, neighbors: inputNeighbors })

    for (const [index, id] of attachmentActionIds.entries()) {
      nodes.push({
        id,
        group: 'composer-attachments',
        order: index,
        neighbors: {
          up: 'task-input',
          down: toolbarEntryId,
          left: attachmentActionIds[index - 1] ?? (sessionCount > 0 ? activeSessionCardId : 'task-input'),
          right: attachmentActionIds[index + 1] ?? inspectorTargetId,
          'previous-region': 'task-input',
          'next-region': inspectorTargetId,
        },
      })
    }

    if (options.canPauseTask) {
      const pauseNeighbors: FocusNode['neighbors'] = {
        up: toolbarUpTarget,
        right: 'voice-input',
        'previous-region': composerUpTarget,
        'next-region': inspectorTargetId,
      }
      nodes.push({ id: 'pause-task', group: 'main', order: 2, neighbors: pauseNeighbors })
    }

    const voiceNeighbors: FocusNode['neighbors'] = {
      up: toolbarUpTarget,
      right: 'screenshot-button',
      'previous-region': composerUpTarget,
      'next-region': inspectorTargetId,
    }
    if (options.canPauseTask) voiceNeighbors.left = 'pause-task'
    nodes.push({ id: 'voice-input', group: 'main', order: 3, neighbors: voiceNeighbors })

    const screenshotNeighbors: FocusNode['neighbors'] = {
      up: toolbarUpTarget,
      left: 'voice-input',
      right: 'paste-image',
      'previous-region': composerUpTarget,
      'next-region': inspectorTargetId,
    }
    nodes.push({ id: 'screenshot-button', group: 'main', order: 4, neighbors: screenshotNeighbors })

    const pasteNeighbors: FocusNode['neighbors'] = {
      up: toolbarUpTarget,
      left: 'screenshot-button',
      right: options.canSend ? 'send-task' : inspectorTargetId,
      'previous-region': composerUpTarget,
      'next-region': inspectorTargetId,
    }
    nodes.push({ id: 'paste-image', group: 'main', order: 5, neighbors: pasteNeighbors })

    if (options.canSend) {
      const sendNeighbors: FocusNode['neighbors'] = {
        up: toolbarUpTarget,
        left: 'paste-image',
        right: inspectorTargetId,
        'previous-region': composerUpTarget,
        'next-region': inspectorTargetId,
      }
      nodes.push({
        id: 'send-task',
        group: 'main',
        order: 6,
        neighbors: sendNeighbors,
      })
    }
  }

  const tabIds = ['inspector-tab-activity', 'inspector-tab-changes', 'inspector-tab-artifacts']
  const fileIds = options.artifactChangeIds.map(changeId => `inspector-file-${changeId}`)
  const selectedFileId = options.selectedArtifactChangeId === undefined
    ? undefined
    : `inspector-file-${options.selectedArtifactChangeId}`
  const acceptActionId = options.selectedArtifactChangeId === undefined
    ? undefined
    : `artifact-accept-${options.selectedArtifactChangeId}`
  const rejectActionId = options.selectedArtifactChangeId === undefined
    ? undefined
    : `artifact-reject-${options.selectedArtifactChangeId}`
  const headerUpTarget = !options.busy ? 'runtime-toggle' : 'settings-toggle'

  nodes.push({
    id: 'inspector-toggle',
    group: 'inspector-toggle',
    order: 0,
    neighbors: {
      left: firstComposerTarget,
      ...(inspectorOpen ? { right: inspectorTabId } : {}),
      up: headerUpTarget,
      down: firstComposerTarget,
      'previous-region': firstComposerTarget,
      'next-region': inspectorOpen ? inspectorTabId : 'settings-toggle',
    },
  })

  for (const [index, id] of (inspectorOpen ? tabIds : []).entries()) {
    const leftTarget = index === 0 ? 'inspector-toggle' : (tabIds[index - 1] ?? 'inspector-toggle')
    const rightTarget = tabIds[index + 1]
    const neighbors: FocusNode['neighbors'] = {
      left: leftTarget,
      up: headerUpTarget,
      down: firstComposerTarget,
      'previous-region': firstComposerTarget,
      'next-region': 'settings-toggle',
    }
    if (rightTarget !== undefined) neighbors.right = rightTarget
    if (id === inspectorTabId && fileIds.length > 0 && options.inspectorPage === 'changes') {
      const firstFileId = fileIds[0]
      if (firstFileId !== undefined) neighbors.down = firstFileId
    }
    nodes.push({ id, group: 'inspector-tabs', order: index, neighbors })
  }
  if (inspectorOpen && options.inspectorPage === 'changes') {
    for (const [index, id] of fileIds.entries()) {
      const actionTarget = id === selectedFileId && options.canReviewArtifacts
        ? options.selectedArtifactAccepted ? rejectActionId : acceptActionId
        : undefined
      nodes.push({
        id,
        group: 'inspector-files',
        order: index,
        neighbors: {
          left: firstComposerTarget,
          up: fileIds[index - 1] ?? inspectorTabId,
          down: fileIds[index + 1] ?? inspectorTabId,
          ...(actionTarget === undefined ? {} : { right: actionTarget }),
          'previous-region': firstComposerTarget,
          'next-region': 'settings-toggle',
        },
      })
    }
    if (options.canReviewArtifacts && selectedFileId !== undefined && rejectActionId !== undefined) {
      if (!options.selectedArtifactAccepted && acceptActionId !== undefined) {
        nodes.push({
          id: acceptActionId,
          group: 'inspector-review',
          order: 0,
          neighbors: { left: selectedFileId, right: rejectActionId, 'previous-region': selectedFileId },
        })
      }
      nodes.push({
        id: rejectActionId,
        group: 'inspector-review',
        order: 1,
        neighbors: {
          left: options.selectedArtifactAccepted ? selectedFileId : acceptActionId ?? selectedFileId,
          'previous-region': selectedFileId,
        },
      })
    }
  }

  const defaultEntry = options.hasActiveTask
    ? (firstComposerTarget === 'failure-model-settings' ? firstComposerTarget : options.canPauseTask ? 'pause-task' : firstComposerTarget)
    : (projectCount > 0 ? activeProjectTabId : (options.busy ? 'settings-toggle' : 'open-project-center'))

  return { entryId: defaultEntry, nodes }
}

function createGamepadSelectFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  const optionIds = options.gamepadSelectOptionIds ?? []
  const entryId = options.gamepadSelectSelectedId !== undefined && optionIds.includes(options.gamepadSelectSelectedId)
    ? options.gamepadSelectSelectedId
    : optionIds[0] ?? 'gamepad-select-close'
  const nodes: FocusNode[] = [{
    id: 'gamepad-select-close',
    group: 'gamepad-select-header',
    order: 0,
    neighbors: optionIds.length === 0 ? {} : { down: entryId, 'next-region': entryId },
  }]
  for (const [index, id] of optionIds.entries()) {
    nodes.push({
      id,
      group: 'gamepad-select-options',
      order: index,
      neighbors: {
        up: optionIds[index - 1] ?? 'gamepad-select-close',
        down: optionIds[index + 1] ?? 'gamepad-select-close',
        left: 'gamepad-select-close',
        'previous-region': 'gamepad-select-close',
      },
    })
  }
  return { entryId, nodes }
}

function createQuestionFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  const optionIds = Array.from({ length: options.questionOptionCount ?? 0 }, (_, index) => `question-option-${index}`)
  const ids = [
    'question-back',
    ...optionIds,
    'question-custom',
    'question-cancel',
    ...(options.questionHasPrevious === true ? ['question-previous'] : []),
    'question-skip',
    ...(options.questionAnswered === true
      ? [options.questionHasNext === true ? 'question-next' : 'question-submit']
      : []),
  ]
  const entryId = optionIds[0] ?? 'question-custom'
  return {
    entryId,
    nodes: ids.map((id, index) => ({
      id,
      group: id.startsWith('question-option') || id === 'question-custom' ? 'question-answer' : 'question-navigation',
      order: index,
      neighbors: {
        up: ids[index - 1] ?? ids.at(-1) ?? entryId,
        down: ids[index + 1] ?? ids[0] ?? entryId,
        ...(id === 'question-submit' || id === 'question-next'
          ? { left: 'question-skip' }
          : {}),
      },
    })),
  }
}

function createPlanReviewFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  const ids = [
    'plan-review-back',
    'plan-review-discuss',
    ...(options.planReviewHasDecline === true ? ['plan-review-decline'] : []),
    'plan-review-approve',
  ]
  const entryId = options.planReviewHasDecline === true ? 'plan-review-decline' : 'plan-review-discuss'
  return {
    entryId,
    nodes: ids.map((id, index) => ({
      id,
      group: id === 'plan-review-back' ? 'plan-review-header' : 'plan-review-actions',
      order: index,
      neighbors: {
        up: id === 'plan-review-back' ? ids.at(-1) ?? entryId : 'plan-review-back',
        ...(id !== 'plan-review-back' ? { left: ids[index - 1] ?? 'plan-review-back' } : {}),
        ...(id !== 'plan-review-back' && ids[index + 1] !== undefined ? { right: ids[index + 1] } : {}),
      },
    })),
  }
}

function createPermissionConfirmationFocusGraph(): FocusGraph {
  return {
    entryId: 'permission-cancel',
    nodes: [
      {
        id: 'permission-cancel',
        group: 'permission-confirmation',
        order: 0,
        neighbors: { right: 'permission-confirm' },
      },
      {
        id: 'permission-confirm',
        group: 'permission-confirmation',
        order: 1,
        neighbors: { left: 'permission-cancel' },
      },
    ],
  }
}

function createCommandFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  const entryId = 'command-current-task'
  const ids = [
    entryId,
    ...(options.pendingApprovalCount > 0 ? ['command-approvals'] : []),
    ...((options.pendingQuestionCount ?? 0) > 0 ? ['command-questions'] : []),
    ...((options.pendingPlanReviewCount ?? 0) > 0 ? ['command-plan-reviews'] : []),
    'command-projects',
    ...(options.hasActiveTask ? ['command-toggle-permission'] : []),
    ...(options.hasActiveTask && options.canArchiveTask ? ['command-archive-task'] : []),
    'command-archives',
    ...(options.canPauseTask ? ['command-pause-task'] : []),
    ...(options.canCommitArtifacts ? ['command-commit-artifacts'] : []),
    ...(options.canRollbackArtifacts ? ['command-rollback-artifacts'] : []),
    'command-fullscreen',
    'command-model-settings',
  ]
  return {
    entryId,
    nodes: ids.map((id, index) => ({
      id,
      group: 'command-center',
      order: index,
      neighbors: {
        up: ids[index - 1] ?? ids.at(-1) ?? entryId,
        down: ids[index + 1] ?? entryId,
      },
    })),
  }
}

function createArchiveFocusGraph(count: number): FocusGraph {
  const ids = ['archive-back', ...Array.from({ length: count }, (_, index) => `archive-restore-${index}`)]
  return {
    entryId: 'archive-back',
    nodes: ids.map((id, index) => ({
      id,
      group: 'archives',
      order: index,
      neighbors: {
        up: ids[index - 1] ?? ids.at(-1) ?? 'archive-back',
        down: ids[index + 1] ?? ids[0] ?? 'archive-back',
      },
    })),
  }
}

function createCommitFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  switch (options.commitPhase) {
    case 'generating':
      return {
        entryId: 'commit-back',
        nodes: [{ id: 'commit-back', group: 'commit-header', order: 0 }],
      }
    case 'editing':
      return {
        entryId: 'commit-back',
        nodes: [
          {
            id: 'commit-back',
            group: 'commit-header',
            order: 0,
            neighbors: { down: 'commit-message', 'next-region': 'commit-message' },
          },
          {
            id: 'commit-message',
            group: 'commit-editor',
            order: 0,
            neighbors: {
              up: 'commit-back',
              ...(options.canContinueCommit ? { down: 'commit-continue' } : {}),
              'previous-region': 'commit-back',
            },
          },
          ...(options.canContinueCommit
            ? [{
                id: 'commit-continue',
                group: 'commit-actions',
                order: 0,
                neighbors: { up: 'commit-message', 'previous-region': 'commit-message' },
              } satisfies FocusNode]
            : []),
        ],
      }
    case 'confirming':
      return {
        entryId: 'commit-cancel',
        nodes: [
          {
            id: 'commit-cancel',
            group: 'commit-confirmation',
            order: 0,
            neighbors: { right: 'commit-confirm' },
          },
          {
            id: 'commit-confirm',
            group: 'commit-confirmation',
            order: 1,
            neighbors: { left: 'commit-cancel' },
          },
        ],
      }
    case 'committing':
      return {
        entryId: 'commit-status',
        nodes: [{ id: 'commit-status', group: 'commit-progress', order: 0 }],
      }
    case 'failed': {
      const nodes: FocusNode[] = [{
        id: 'commit-back',
        group: 'commit-header',
        order: 0,
        ...(options.canCommitArtifacts
          ? { neighbors: { down: 'commit-retry', 'next-region': 'commit-retry' } }
          : {}),
      }]
      if (options.canCommitArtifacts) {
        nodes.push({
          id: 'commit-retry',
          group: 'commit-actions',
          order: 0,
          neighbors: { up: 'commit-back', 'previous-region': 'commit-back' },
        })
      }
      return { entryId: 'commit-back', nodes }
    }
    case 'completed':
      return {
        entryId: 'commit-done',
        nodes: [{ id: 'commit-done', group: 'commit-actions', order: 0 }],
      }
    case undefined:
      break
  }
  return { entryId: 'command-current-task', nodes: [] }
}

function createArtifactConfirmationFocusGraph(): FocusGraph {
  return {
    entryId: 'artifact-cancel',
    nodes: [
      {
        id: 'artifact-cancel',
        group: 'artifact-confirmation',
        order: 0,
        neighbors: { right: 'artifact-confirm' },
      },
      {
        id: 'artifact-confirm',
        group: 'artifact-confirmation',
        order: 1,
        neighbors: { left: 'artifact-cancel' },
      },
    ],
  }
}

function createApprovalFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  if (options.approvalResponding) {
    return {
      entryId: 'approval-back',
      nodes: [{ id: 'approval-back', group: 'approval-header', order: 0 }],
    }
  }
  return {
    entryId: 'approval-reject',
    nodes: [
      {
        id: 'approval-back',
        group: 'approval-header',
        order: 0,
        neighbors: { down: 'approval-reject', 'next-region': 'approval-reject' },
      },
      {
        id: 'approval-reject',
        group: 'approval-actions',
        order: 0,
        neighbors: { up: 'approval-back', right: 'approval-allow', 'previous-region': 'approval-back' },
      },
      {
        id: 'approval-allow',
        group: 'approval-actions',
        order: 1,
        neighbors: { up: 'approval-back', left: 'approval-reject', 'previous-region': 'approval-back' },
      },
    ],
  }
}

function createProjectFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  const permissionId = `project-permission-${options.projectPermissionMode}`
  const projectItemIds = Array.from({ length: options.projectCount }, (_, index) => `project-item-${index}`)
  const projectPermissionIds = Array.from({ length: options.projectCount }, (_, index) => `project-permission-${index}`)
  const firstProjectItemId = projectItemIds[0]
  const contentIds = [
    ...(options.hasWorkspaceBase
      ? ['project-name', ...(options.canCreateProject ? ['project-create'] : [])]
      : ['project-base-empty']),
    ...projectItemIds,
  ]
  const entryId = options.projectCount > 0 ? 'project-item-0' : contentIds[0] ?? permissionId
  const firstContentId = contentIds[0] ?? permissionId
  const nodes: FocusNode[] = [
    {
      id: 'project-base-picker',
      group: 'project-header',
      order: 0,
      neighbors: { right: 'project-open-folder', down: entryId, 'next-region': entryId },
    },
    {
      id: 'project-open-folder',
      group: 'project-header',
      order: 1,
      neighbors: { left: 'project-base-picker', down: entryId, 'next-region': entryId },
    },
    {
      id: 'project-permission-standard',
      group: 'project-permission',
      order: 0,
      neighbors: { up: 'project-base-picker', right: 'project-permission-full-access', down: firstContentId, 'previous-region': 'project-base-picker' },
    },
    {
      id: 'project-permission-full-access',
      group: 'project-permission',
      order: 1,
      neighbors: { up: 'project-open-folder', left: 'project-permission-standard', down: firstContentId, 'previous-region': 'project-open-folder' },
    },
  ]
  for (const [index, id] of contentIds.entries()) {
    const isProjectItem = id.startsWith('project-item-')
    const projectIndex = isProjectItem ? Number(id.slice('project-item-'.length)) : undefined
    const projectPermissionId = projectIndex === undefined ? undefined : projectPermissionIds[projectIndex]
    const neighbors: FocusNode['neighbors'] = {
      up: isProjectItem && id === 'project-item-0'
        ? (options.hasWorkspaceBase ? 'project-name' : 'project-base-empty')
        : contentIds[index - 1] ?? permissionId,
      down: isProjectItem
        ? (contentIds[index + 1] ?? (options.hasWorkspaceBase ? 'project-name' : 'project-base-picker'))
        : (firstProjectItemId ?? contentIds[index + 1] ?? 'project-base-picker'),
      'previous-region': permissionId,
      'next-region': firstProjectItemId ?? 'project-base-picker',
    }
    if (projectPermissionId !== undefined) neighbors.right = projectPermissionId
    if (id === 'project-name' && options.canCreateProject) neighbors.right = 'project-create'
    if (id === 'project-create') {
      neighbors.left = 'project-name'
      neighbors.up = permissionId
      neighbors.down = firstProjectItemId ?? 'project-base-picker'
    }
    nodes.push({ id, group: 'project-content', order: index, neighbors })
    if (projectPermissionId !== undefined && projectIndex !== undefined) {
      const projectPermissionNeighbors: FocusNode['neighbors'] = {
        left: id,
        'previous-region': permissionId,
      }
      const up = projectIndex > 0 ? projectPermissionIds[projectIndex - 1] : neighbors.up
      const down = projectIndex < projectPermissionIds.length - 1 ? projectPermissionIds[projectIndex + 1] : neighbors.down
      if (up !== undefined) projectPermissionNeighbors.up = up
      if (down !== undefined) projectPermissionNeighbors.down = down
      nodes.push({
        id: projectPermissionId,
        group: 'project-content',
        order: index,
        neighbors: projectPermissionNeighbors,
      })
    }
  }
  return { entryId, nodes }
}

function createSettingsFocusGraph(options: AppFocusGraphOptions): FocusGraph {
  const selectedProviderId = `provider-${options.selectedProvider}`
  const fieldIds: string[] = []
  if (options.settingsReady) {
    if (options.credentialWritable) fieldIds.push('api-key')
    fieldIds.push('base-url')
    if (options.selectedProvider === 'openai') fieldIds.push('codex-model')
    if (options.canSaveSettings) fieldIds.push('settings-save')
    fieldIds.push('voice-input-gamepad-button')
    fieldIds.push('voice-input-key')
    if (options.voicePermissionActionAvailable) fieldIds.push('voice-input-permission')
    fieldIds.push('voice-input-test')
  }
  const firstField = fieldIds[0]
  const providerBaseNeighbors = (side: 'left' | 'right', target: string): NonNullable<FocusNode['neighbors']> => {
    const value: NonNullable<FocusNode['neighbors']> = { [side]: target, up: 'settings-tab-model' }
    if (firstField !== undefined) {
      value.down = firstField
      value['next-region'] = firstField
    }
    return value
  }
  const nodes: FocusNode[] = [
    {
      id: 'settings-close',
      group: 'settings-header',
      order: 0,
      neighbors: { left: 'settings-tab-appearance', down: selectedProviderId, 'next-region': selectedProviderId },
    },
    {
      id: 'settings-tab-model',
      group: 'settings-tabs',
      order: 0,
      neighbors: { right: 'settings-tab-input', down: selectedProviderId, up: 'settings-close', 'next-region': selectedProviderId },
    },
    {
      id: 'settings-tab-input',
      group: 'settings-tabs',
      order: 1,
      neighbors: { left: 'settings-tab-model', right: 'settings-tab-appearance', down: 'voice-input-gamepad-button', up: 'settings-close' },
    },
    {
      id: 'settings-tab-appearance',
      group: 'settings-tabs',
      order: 2,
      neighbors: { left: 'settings-tab-input', right: 'settings-close', down: 'appearance-theme-dark', up: 'settings-close' },
    },
    {
      id: 'provider-deepseek-official',
      group: 'settings-provider',
      order: 0,
      neighbors: providerBaseNeighbors('right', 'provider-openai'),
    },
    {
      id: 'provider-openai',
      group: 'settings-provider',
      order: 1,
      neighbors: providerBaseNeighbors('left', 'provider-deepseek-official'),
    },
  ]

  for (const [index, id] of fieldIds.entries()) {
    const previous = index === 0 ? selectedProviderId : fieldIds[index - 1]
    const next = fieldIds[index + 1]
    const fieldNeighbors: FocusNode['neighbors'] = { 'previous-region': selectedProviderId }
    if (previous !== undefined) fieldNeighbors.up = previous
    if (next !== undefined) fieldNeighbors.down = next
    if (id === 'api-key') fieldNeighbors.right = 'api-key-visibility'
    nodes.push({ id, group: 'settings-form', order: index, neighbors: fieldNeighbors })
    if (id === 'api-key') {
      const visibilityNeighbors: FocusNode['neighbors'] = {
        left: 'api-key',
        up: selectedProviderId,
        'previous-region': selectedProviderId,
      }
      if (next !== undefined) visibilityNeighbors.down = next
      nodes.push({ id: 'api-key-visibility', group: 'settings-form', order: index, neighbors: visibilityNeighbors })
    }
  }
  return { entryId: selectedProviderId, nodes }
}
