import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ImageAttachmentInput,
  ImageMediaType,
  RuntimeConnectionState,
  TaskArtifactBaseline,
  TaskArtifactSnapshot,
  TaskApproval,
  TaskApprovalOutcome,
  TaskEvent,
  TaskFileChange,
  TaskPermissionMode,
  TaskPlanReview,
  TaskQuestionAnswer,
  TaskQuestionRequest,
  TaskSession,
} from '@joydsh/domain'
import type { CredentialStatus, ModelSelection } from '@joydsh/dsh-adapter'
import {
  createTaskProjection,
  projectTaskEvent,
  synchronizeTaskRunning,
  type TaskProjection,
  type TaskProjectionMessage,
} from '@joydsh/task-projection'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  CirclePause,
  ClipboardPaste,
  Eye,
  EyeOff,
  Folder,
  FolderKanban,
  FileCheck2,
  GitCommitHorizontal,
  Image as ImageIcon,
  Layers3,
  KeyRound,
  LoaderCircle,
  Maximize,
  Mic,
  Minimize,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  User,
  X,
} from 'lucide-react'
import {
  loadVoiceInputConfig,
  saveVoiceInputConfig,
  simulateKeyAction,
  checkKeySimulationSupport,
  requestKeySimulationPermission,
  GAMEPAD_BUTTON_OPTIONS,
  TARGET_KEY_OPTIONS,
  gamepadButtonConflict,
  type VoiceInputConfig,
  type VoiceInputGamepadButton,
  type VoiceInputTargetKey,
  type KeySimulationCapabilities,
} from './voice-input-service.ts'
import { createRuntimeAdapter } from './dsh-transport.ts'
import { createAppFocusGraph } from './app-focus.ts'
import { createLatestSelection } from './latest-selection.ts'
import { approvalEvidence } from './approval-evidence.ts'
import { subscribeFullscreenChange, toggleWindowFullscreen } from './fullscreen-service.ts'
import {
  ArtifactOperationException,
  artifactUnavailableReason,
  commitTaskArtifacts,
  ensureTaskArtifactBaseline,
  inspectTaskArtifacts,
  requestTaskCommitProposal,
  resolveTaskCommitProposal,
  reviewTaskArtifactFile,
  rollbackTaskArtifacts,
  type TaskCommitProposal,
} from './artifact-service.ts'
import { ProjectCenter } from './ProjectCenter.tsx'
import { startManagedRuntime, stopManagedRuntime } from './runtime-control.ts'
import { focusManagedElement, restoreManagedFocus, useSemanticNavigation } from './semantic-navigation.ts'
import {
  chooseWorkspaceDirectory,
  createWorkspaceProject,
  describeWorkspaceCatalog,
  rememberWorkspaceProject,
  setWorkspaceBase,
  type WorkspaceCatalog,
  type WorkspacePermissionMode,
  type WorkspaceProject,
} from './workspace-service.ts'
import { aggregateActivityItems, TaskInspector, type InspectorPage } from './TaskInspector.tsx'
import { MarkdownContent } from './MarkdownContent.tsx'
import { ImageLightbox, type LightboxImage } from './ImageLightbox.tsx'
import { AttachmentRail } from './AttachmentRail.tsx'
import { MessageImages } from './MessageImages.tsx'
import {
  applyGamepadSelectChoice,
  createGamepadSelectSession,
  GamepadSelectOverlay,
  type GamepadSelectSession,
} from './GamepadSelectOverlay.tsx'
import { captureScreenImage, dataUrlToBlob, readImageFromClipboard, writeImageToClipboard } from './screenshot-service.ts'
import { collectPendingResponses } from './pending-responses.ts'
import {
  archiveTask,
  archivedTasks,
  loadTaskArchiveState,
  restoreArchivedTask,
  saveTaskArchiveState,
  visibleTasks,
} from './task-archive-service.ts'

const DSH_VERSION = '0.1.1-rc.2'
const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'])
const MAX_VISIBLE_EVENTS = 2000
const EMPTY_APPROVALS: readonly TaskApproval[] = []
const EMPTY_QUESTIONS: readonly TaskQuestionRequest[] = []
const EMPTY_PLAN_REVIEWS: readonly TaskPlanReview[] = []
const INSPECTOR_PAGES: readonly InspectorPage[] = ['activity', 'changes', 'artifacts']
const PROVIDERS = {
  'deepseek-official': {
    name: 'DeepSeek',
    credentialRef: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash',
  },
  openai: {
    name: 'OpenAI Codex',
    credentialRef: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.6-sol',
  },
} as const

type ModelProvider = keyof typeof PROVIDERS

interface QuestionDraft {
  selected: string[]
  custom: string
  skipped: boolean
}

type QuestionDrafts = Record<string, QuestionDraft>

type PendingResponseSelection =
  | { kind: 'question', taskId: string, requestId: string }
  | { kind: 'plan-review', taskId: string, requestId: string }

interface PendingApprovalSelection {
  taskId: string
  approvalId: string
}

export function buildQuestionAnswer(request: TaskQuestionRequest, drafts: QuestionDrafts): TaskQuestionAnswer {
  return {
    answers: request.questions.map(question => {
      const draft = drafts[question.id] ?? { selected: [], custom: '', skipped: true }
      if (draft.skipped) return { id: question.id, selected: [] }
      const custom = draft.custom.trim()
      return {
        id: question.id,
        selected: custom !== '' && question.multiSelect !== true ? [] : draft.selected,
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

type ArtifactConfirmation =
  | { kind: 'reject-file'; changeId: string; path: string; returnTo: 'inspector' }
  | { kind: 'rollback-task'; returnTo: 'command' }

type ArtifactCommitFlow =
  | { phase: 'generating'; acceptedCount: number; snapshotToken: string }
  | { phase: 'editing'; acceptedCount: number; proposal: TaskCommitProposal; message: string }
  | { phase: 'confirming'; acceptedCount: number; proposal: TaskCommitProposal; message: string }
  | { phase: 'committing'; acceptedCount: number; proposal: TaskCommitProposal; message: string }
  | { phase: 'failed'; acceptedCount: number; message: string }
  | { phase: 'completed'; acceptedCount: number; revision: string; warning?: string }

export function App() {
  const adapter = useMemo(createRuntimeAdapter, [])
  const [connection, setConnection] = useState<RuntimeConnectionState>('disconnected')
  const [workspacePath, setWorkspacePath] = useState('')
  const [taskInput, setTaskInput] = useState('')
  const [allTasks, setAllTasks] = useState<TaskSession[]>([])
  const [taskArchiveState, setTaskArchiveState] = useState(loadTaskArchiveState)
  const [archiveViewOpen, setArchiveViewOpen] = useState(false)
  const [projections, setProjections] = useState<Record<string, TaskProjection>>({})
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>()
  const [composingNewSession, setComposingNewSession] = useState(false)
  const composingNewSessionRef = useRef(false)
  const updateComposingNewSession = useCallback((value: boolean) => {
    composingNewSessionRef.current = value
    setComposingNewSession(value)
  }, [])
  const [inspectorPage, setInspectorPage] = useState<InspectorPage>('activity')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [artifactBaseline, setArtifactBaseline] = useState<TaskArtifactBaseline | undefined>()
  const [artifactSnapshot, setArtifactSnapshot] = useState<TaskArtifactSnapshot | undefined>()
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [selectedArtifactChangeId, setSelectedArtifactChangeId] = useState<string | undefined>()
  const [artifactMutationBusy, setArtifactMutationBusy] = useState(false)
  const [artifactMutationError, setArtifactMutationError] = useState<string | undefined>()
  const [artifactConfirmation, setArtifactConfirmation] = useState<ArtifactConfirmation | undefined>()
  const [artifactCommitFlow, setArtifactCommitFlow] = useState<ArtifactCommitFlow | undefined>()
  const [busy, setBusy] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [commandCenterOpen, setCommandCenterOpen] = useState(false)
  const [permissionConfirmationOpen, setPermissionConfirmationOpen] = useState(false)
  const [permissionChangeBusy, setPermissionChangeBusy] = useState(false)
  const [permissionChangeError, setPermissionChangeError] = useState<string | undefined>()
  const [projectCenterOpen, setProjectCenterOpen] = useState(false)
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalog>({ projects: [] })
  const [projectName, setProjectName] = useState('')
  const [projectPermissionMode, setProjectPermissionMode] = useState<WorkspacePermissionMode>('standard')
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState<string | undefined>()
  const [selectedApprovalSelection, setSelectedApprovalSelection] = useState<PendingApprovalSelection | undefined>()
  const [approvalRespondingId, setApprovalRespondingId] = useState<string | undefined>()
  const [approvalError, setApprovalError] = useState<string | undefined>()
  const [selectedPendingResponse, setSelectedPendingResponse] = useState<PendingResponseSelection | undefined>()
  const [questionIndex, setQuestionIndex] = useState(0)
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDrafts>({})
  const [responseBusy, setResponseBusy] = useState(false)
  const [responseError, setResponseError] = useState<string | undefined>()
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>('deepseek-official')
  const [selectedModel, setSelectedModel] = useState<string>(PROVIDERS.openai.defaultModel)
  const [credentialStatuses, setCredentialStatuses] = useState<Partial<Record<ModelProvider, CredentialStatus>>>({})
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [baseUrlDrafts, setBaseUrlDrafts] = useState<Record<ModelProvider, string>>({
    'deepseek-official': '',
    openai: '',
  })
  const [showApiKey, setShowApiKey] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string | undefined>()
  const [settingsMessage, setSettingsMessage] = useState<string | undefined>()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [voiceConfig, setVoiceConfig] = useState<VoiceInputConfig>(loadVoiceInputConfig)
  const [isVoicePressed, setIsVoicePressed] = useState(false)
  const [voiceTestStatus, setVoiceTestStatus] = useState<string | undefined>()
  const [voiceCapabilities, setVoiceCapabilities] = useState<KeySimulationCapabilities | undefined>()
  const [voicePermissionBusy, setVoicePermissionBusy] = useState(false)
  const [pendingImages, setPendingImages] = useState<ImageAttachmentInput[]>([])
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [gamepadSelect, setGamepadSelect] = useState<GamepadSelectSession | null>(null)
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const voiceActionQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pressedVoiceTargetRef = useRef<Pick<VoiceInputConfig, 'targetKey' | 'customKeyCode'> | null>(null)
  const lightboxReturnFocusRef = useRef<HTMLElement | null>(null)
  const settingsReturnFocusRef = useRef('settings-toggle')
  const commandReturnFocusRef = useRef('settings-toggle')
  const projectReturnFocusRef = useRef('settings-toggle')
  const approvalReturnFocusRef = useRef('command-approvals')
  const responseReturnFocusRef = useRef('command-questions')
  const approvalAttemptRef = useRef(0)
  const responseAttemptRef = useRef(0)
  const artifactAttemptRef = useRef(0)
  const gamepadSelectReturnFocusRef = useRef<string | undefined>(undefined)

  const refreshVoiceCapabilities = useCallback(async () => {
    const capabilities = await checkKeySimulationSupport()
    setVoiceCapabilities(capabilities)
    return capabilities
  }, [])
  const commitAttemptRef = useRef(0)
  const previousArtifactStatusRef = useRef<TaskProjection['status'] | undefined>(undefined)
  const taskSelectionRef = useRef(createLatestSelection())
  const projectTrackRef = useRef<HTMLDivElement>(null)
  const sessionTrackRef = useRef<HTMLDivElement>(null)
  const outputSurfaceRef = useRef<HTMLDivElement>(null)

  const closeGamepadSelect = useCallback(() => {
    setGamepadSelect(null)
    const returnFocusId = gamepadSelectReturnFocusRef.current
    gamepadSelectReturnFocusRef.current = undefined
    if (returnFocusId !== undefined) restoreManagedFocus(returnFocusId)
  }, [])

  const openGamepadSelect = useCallback((select: HTMLSelectElement) => {
    const session = createGamepadSelectSession(select)
    if (session.choices.length === 0) return
    gamepadSelectReturnFocusRef.current = session.focusId
    setGamepadSelect(session)
  }, [])

  const chooseGamepadSelectOption = useCallback((optionIndex: number) => {
    if (gamepadSelect === null) return
    applyGamepadSelectChoice(gamepadSelect, optionIndex)
    closeGamepadSelect()
  }, [closeGamepadSelect, gamepadSelect])

  const projects = workspaceCatalog.projects
  const activeProject = projects.find(project => project.path === workspacePath)
  const activeProjectIndex = projects.findIndex(project => project.path === workspacePath)
  const visibleTaskList = useMemo(() => visibleTasks(allTasks, taskArchiveState), [allTasks, taskArchiveState])
  const archivedTaskList = useMemo(() => archivedTasks(allTasks, taskArchiveState), [allTasks, taskArchiveState])
  const currentProjectTasks = useMemo(() => {
    return visibleTaskList.filter(t => t.workspacePath === workspacePath || (!t.workspacePath && !workspacePath))
  }, [visibleTaskList, workspacePath])
  const activeTask = useMemo(() => {
    return resolveDisplayedTask(currentProjectTasks, activeTaskId, composingNewSession)
  }, [activeTaskId, composingNewSession, currentProjectTasks])
  const activeSessionIndex = activeTask ? currentProjectTasks.findIndex(t => t.id === activeTask.id) : 0
  const projection = activeTask ? (projections[activeTask.id] ?? createTaskProjection(activeTask.id)) : undefined

  const pendingApprovals = projection?.pendingApprovals ?? EMPTY_APPROVALS
  const pendingQuestions = projection?.pendingQuestions ?? EMPTY_QUESTIONS
  const pendingPlanReviews = projection?.pendingPlanReviews ?? EMPTY_PLAN_REVIEWS
  const pendingResponseQueue = useMemo(() => collectPendingResponses(
    visibleTaskList.map(task => task.id),
    projections,
    activeTask?.id,
  ), [activeTask?.id, projections, visibleTaskList])
  const allPendingApprovals = pendingResponseQueue.approvals
  const allPendingQuestions = pendingResponseQueue.questions
  const allPendingPlanReviews = pendingResponseQueue.planReviews
  const selectedTaskProjection = selectedApprovalSelection === undefined
    ? undefined
    : projections[selectedApprovalSelection.taskId]
  const selectedApproval = selectedApprovalSelection === undefined
    ? undefined
    : selectedTaskProjection?.pendingApprovals.find(approval => approval.approvalId === selectedApprovalSelection.approvalId)
  const selectedResponseProjection = selectedPendingResponse === undefined
    ? undefined
    : projections[selectedPendingResponse.taskId]
  const selectedQuestionRequest = selectedPendingResponse?.kind === 'question'
    ? selectedResponseProjection?.pendingQuestions.find(request => request.requestId === selectedPendingResponse.requestId)
    : undefined
  const selectedPlanReview = selectedPendingResponse?.kind === 'plan-review'
    ? selectedResponseProjection?.pendingPlanReviews.find(review => review.requestId === selectedPendingResponse.requestId)
    : undefined
  const selectedQuestion = selectedQuestionRequest?.questions[questionIndex]
  const selectedQuestionDraft = selectedQuestion === undefined
    ? undefined
    : questionDrafts[selectedQuestion.id] ?? { selected: [], custom: '', skipped: false }
  const selectedQuestionAnswered = selectedQuestionDraft !== undefined
    && (selectedQuestionDraft.selected.length > 0 || selectedQuestionDraft.custom.trim() !== '')
  const activePermissionMode = projection?.permissionMode ?? projectPermissionMode
  const selectedArtifactChange = artifactSnapshot?.changes.find(change => change.changeId === selectedArtifactChangeId)
  const artifactExecutionActive = projection?.status === 'running'
    || projection?.status === 'waiting-approval'
    || projection?.status === 'waiting-response'
  const canReviewArtifacts = artifactSnapshot?.availability === 'ready'
    && artifactSnapshot.mutation.availability === 'ready'
    && !artifactExecutionActive
    && !artifactsLoading
    && !artifactMutationBusy
    && !busy
  const canRollbackArtifacts = canReviewArtifacts && (artifactSnapshot?.changes.length ?? 0) > 0
  const acceptedArtifactCount = artifactSnapshot?.availability === 'ready'
    ? artifactSnapshot.changes.reduce((count, change) => count + (change.review === 'accepted' ? 1 : 0), 0)
    : 0
  const hasAcceptedArtifacts = acceptedArtifactCount > 0
  const canCommitArtifacts = canReviewArtifacts && hasAcceptedArtifacts
  const selectedApprovalEvidence = useMemo(
    () => selectedApproval === undefined ? undefined : approvalEvidence(selectedApproval, projection?.events ?? []),
    [projection?.events, selectedApproval],
  )
  const conversationMessages = useMemo(() => {
    if (!projection?.messages || projection.messages.length === 0) return []
    return projection.messages.filter((msg, index, all) => {
      if (msg.isSystemInjection) return false
      const isLatest = index === all.length - 1
      if (!isLatest && msg.role === 'assistant') {
        const hasContent = Boolean(msg.content && msg.content.trim() !== '')
        const hasImages = Boolean(msg.images && msg.images.length > 0)
        const hasFailure = msg.failure !== undefined
        if (!hasContent && !hasImages && !hasFailure) return false
      }
      return true
    })
  }, [projection?.messages])

  const appendEvent = useCallback((event: TaskEvent) => {
    if (event.taskId !== undefined) {
      const taskId = event.taskId
      setProjections(current => {
        const existing = current[taskId] ?? createTaskProjection(taskId)
        const next = projectTaskEvent(existing, event)
        return {
          ...current,
          [taskId]: { ...next, events: next.events.slice(-MAX_VISIBLE_EVENTS) },
        }
      })
      setAllTasks(current => {
        const running = event.type === 'host/session-status' && typeof event.data === 'object' && event.data !== null && 'running' in event.data
          ? (event.data as { running: boolean }).running
          : event.type === 'turn/start' ? true : event.type === 'turn/end' ? false : undefined
        const title = sessionTitleFromProjectionEvent(event)
        if (running === undefined && title === undefined) return current
        return current.map(t => t.id === taskId ? {
          ...t,
          ...(running === undefined ? {} : { running }),
          ...(title === undefined ? {} : { title }),
        } : t)
      })
    } else {
      setProjections(current => {
        const updated: Record<string, TaskProjection> = {}
        for (const [id, proj] of Object.entries(current)) {
          const next = projectTaskEvent(proj, event)
          updated[id] = { ...next, events: next.events.slice(-MAX_VISIBLE_EVENTS) }
        }
        return updated
      })
    }
  }, [])

  const loadTaskArtifacts = useCallback(async (
    task: TaskSession,
    establishBoundary: boolean,
  ): Promise<void> => {
    const attempt = artifactAttemptRef.current + 1
    artifactAttemptRef.current = attempt
    const path = task.workspacePath
    setArtifactsLoading(true)
    if (path === undefined || path.trim() === '') {
      setArtifactBaseline(undefined)
      setArtifactSnapshot({
        availability: 'unavailable',
        taskId: task.id,
        workspacePath: '',
        inspectedAt: Date.now(),
        changes: [],
        reason: 'workspace-unavailable',
        message: '任务没有可用的工作空间路径',
      })
      setSelectedArtifactChangeId(undefined)
      setArtifactsLoading(false)
      return
    }

    try {
      if (establishBoundary) await ensureTaskArtifactBaseline(task.id, path)
      let snapshot = await inspectTaskArtifacts(task.id, path)
      if (snapshot.availability === 'unavailable' && snapshot.reason === 'baseline-missing') {
        try {
          await ensureTaskArtifactBaseline(task.id, path)
          snapshot = await inspectTaskArtifacts(task.id, path)
        } catch {
          // Keep unavailable snapshot if establishment cannot complete
        }
      }
      if (artifactAttemptRef.current !== attempt) return
      setArtifactBaseline(snapshot.baseline)
      setArtifactSnapshot(snapshot)
      setArtifactMutationError(undefined)
      setSelectedArtifactChangeId(current => snapshot.changes.some(change => change.changeId === current)
        ? current
        : snapshot.changes[0]?.changeId)
    } catch (cause) {
      if (artifactAttemptRef.current !== attempt) return
      const message = errorMessage(cause)
      setArtifactBaseline(undefined)
      setArtifactSnapshot({
        availability: 'unavailable',
        taskId: task.id,
        workspacePath: path,
        inspectedAt: Date.now(),
        changes: [],
        reason: artifactUnavailableReason(message),
        message,
      })
      setSelectedArtifactChangeId(undefined)
    } finally {
      if (artifactAttemptRef.current === attempt) setArtifactsLoading(false)
    }
  }, [])

  const restoreTask = useCallback(async (task: TaskSession) => {
    if (composingNewSessionRef.current) return undefined
    const selection = taskSelectionRef.current.begin()
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    setActiveTaskId(task.id)
    setError(undefined)
    const effectivePath = task.workspacePath || workspacePath
    if (task.workspacePath && task.workspacePath !== workspacePath) {
      setWorkspacePath(task.workspacePath)
    }
    setArtifactBaseline(undefined)
    setArtifactSnapshot(undefined)
    setSelectedArtifactChangeId(undefined)
    const targetPermission = resolveWorkspaceProjectPermission(
      workspaceCatalog.projects,
      effectivePath,
      projectPermissionMode,
    )
    const initialProj: TaskProjection = {
      ...createTaskProjection(task.id),
      permissionMode: targetPermission,
    }
    try {
      const history = await adapter.replayTask(task.id)
      const restored = synchronizeTaskRunning(
        history.reduce(projectTaskEvent, initialProj),
        task.running,
      )
      const finalProj = { ...restored, events: restored.events.slice(-MAX_VISIBLE_EVENTS) }
      if (!taskSelectionRef.current.isCurrent(selection)) return finalProj
      setProjections(current => ({ ...current, [task.id]: finalProj }))
      setProjectPermissionMode(finalProj.permissionMode)
      await loadTaskArtifacts(task, false)
      return finalProj
    } catch (cause) {
      if (!taskSelectionRef.current.isCurrent(selection)) return initialProj
      const message = errorMessage(cause)
      setError(message)
      const fallbackProj = {
        ...initialProj,
        status: 'failed' as const,
        failure: { message },
      }
      setProjections(current => ({ ...current, [task.id]: fallbackProj }))
      return fallbackProj
    }
  }, [adapter, loadTaskArtifacts, projectPermissionMode, workspaceCatalog.projects, workspacePath])

  const reconnect = useCallback(async (reportError = true): Promise<boolean> => {
    setError(undefined)
    setConnection('connecting')
    try {
      const [, listed] = await Promise.all([adapter.healthCheck(), adapter.listTasks()])
      setConnection('connected')
      setAllTasks(listed)
      const visible = visibleTasks(listed, taskArchiveState)
      const current = resolveReconnectionTask(visible, workspacePath)
      if (current !== undefined && !composingNewSessionRef.current) await restoreTask(current)
      return true
    } catch (cause) {
      setConnection('disconnected')
      setError(reportError ? errorMessage(cause) : undefined)
      return false
    }
  }, [adapter, restoreTask, taskArchiveState, workspacePath])

  const reconnectRef = useRef(reconnect)
  reconnectRef.current = reconnect

  useEffect(() => {
    const unsubscribe = adapter.subscribe({
      onEvent: appendEvent,
      onConnectionChange: setConnection,
    })
    void reconnectRef.current(false)
    return unsubscribe
  }, [adapter, appendEvent])

  const loadWorkspaceCatalog = useCallback(async () => {
    try {
      const catalog = await describeWorkspaceCatalog()
      setWorkspaceCatalog(catalog)
      setWorkspacePath(current => {
        if (current === '' && catalog.projects.length > 0) {
          const first = catalog.projects[0]
          return first !== undefined ? first.path : current
        }
        return current
      })
    } catch (cause) {
      setProjectError(errorMessage(cause))
    }
  }, [])

  useEffect(() => {
    void loadWorkspaceCatalog()
  }, [loadWorkspaceCatalog])

  useEffect(() => {
    return subscribeFullscreenChange(setIsFullscreen)
  }, [])

  useEffect(() => {
    void refreshVoiceCapabilities()
    const refreshAfterSystemSettings = () => void refreshVoiceCapabilities()
    window.addEventListener('focus', refreshAfterSystemSettings)
    return () => window.removeEventListener('focus', refreshAfterSystemSettings)
  }, [refreshVoiceCapabilities])

  useEffect(() => {
    if (outputSurfaceRef.current) {
      outputSurfaceRef.current.scrollTop = outputSurfaceRef.current.scrollHeight
    }
  }, [projection?.output, projection?.status, projection?.messages])

  useEffect(() => {
    projectTrackRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [workspacePath])

  useEffect(() => {
    sessionTrackRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeTaskId])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setApiKeyDraft('')
    setShowApiKey(false)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    restoreManagedFocus(settingsReturnFocusRef.current)
  }, [])

  const loadSettings = useCallback(() => {
    setSettingsOpen(true)
    setCredentialStatuses({})
    setBaseUrlDrafts({ 'deepseek-official': '', openai: '' })
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    setSettingsBusy(true)
    void refreshVoiceCapabilities()
    void Promise.all([
      adapter.describeCredential(PROVIDERS['deepseek-official'].credentialRef),
      adapter.describeCredential(PROVIDERS.openai.credentialRef),
      adapter.describeProviderSettings(),
    ])
      .then(([deepseek, openai, providerSettings]) => {
        setCredentialStatuses({ 'deepseek-official': deepseek, openai })
        setBaseUrlDrafts(providerSettings.baseUrls)
      })
      .catch(cause => setSettingsError(errorMessage(cause)))
      .finally(() => setSettingsBusy(false))
  }, [adapter, refreshVoiceCapabilities])

  const openSettings = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      settingsReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'settings-toggle'
    }
    loadSettings()
  }, [loadSettings])

  const closeCommandCenter = useCallback(() => {
    if (permissionChangeBusy || artifactMutationBusy || responseBusy || artifactCommitFlow?.phase === 'committing') return
    approvalAttemptRef.current += 1
    commitAttemptRef.current += 1
    setCommandCenterOpen(false)
    setArchiveViewOpen(false)
    setSelectedApprovalSelection(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    responseAttemptRef.current += 1
    setSelectedPendingResponse(undefined)
    setQuestionIndex(0)
    setQuestionDrafts({})
    setResponseBusy(false)
    setResponseError(undefined)
    setArtifactConfirmation(undefined)
    setArtifactCommitFlow(undefined)
    setArtifactMutationError(undefined)
    setPermissionConfirmationOpen(false)
    setPermissionChangeError(undefined)
    restoreManagedFocus(commandReturnFocusRef.current)
  }, [artifactCommitFlow?.phase, artifactMutationBusy, permissionChangeBusy, responseBusy])

  const closeApprovalDetail = useCallback(() => {
    approvalAttemptRef.current += 1
    setSelectedApprovalSelection(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    restoreManagedFocus(allPendingApprovals.length > 0 ? approvalReturnFocusRef.current : 'command-current-task')
  }, [allPendingApprovals.length])

  const openApprovalDetail = useCallback(() => {
    const pending = allPendingApprovals[0]
    if (pending === undefined) return
    const approval = pending.item
    if (document.activeElement instanceof HTMLElement) {
      approvalReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'command-approvals'
    }
    setApprovalError(undefined)
    setArtifactConfirmation(undefined)
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    setArtifactMutationError(undefined)
    setPermissionConfirmationOpen(false)
    setPermissionChangeError(undefined)
    setCommandCenterOpen(true)
    setSelectedApprovalSelection({ taskId: pending.taskId, approvalId: approval.approvalId })
  }, [allPendingApprovals])

  const respondToSelectedApproval = useCallback((outcome: TaskApprovalOutcome) => {
    if (selectedApprovalSelection === undefined || selectedApproval === undefined || approvalRespondingId !== undefined) return
    const attempt = approvalAttemptRef.current + 1
    approvalAttemptRef.current = attempt
    setApprovalError(undefined)
    setApprovalRespondingId(selectedApproval.approvalId)
    void adapter.respondToApproval(selectedApprovalSelection.taskId, selectedApproval, outcome)
      .catch(cause => {
        if (approvalAttemptRef.current !== attempt) return
        setApprovalRespondingId(undefined)
        setApprovalError(errorMessage(cause))
      })
  }, [adapter, approvalRespondingId, selectedApproval, selectedApprovalSelection])

  const closePendingResponseDetail = useCallback(() => {
    if (responseBusy) return
    responseAttemptRef.current += 1
    setSelectedPendingResponse(undefined)
    setQuestionIndex(0)
    setQuestionDrafts({})
    setResponseError(undefined)
    restoreManagedFocus(responseReturnFocusRef.current)
  }, [responseBusy])

  const openQuestionDetail = useCallback(() => {
    const pending = allPendingQuestions[0]
    if (pending === undefined) return
    const request = pending.item
    if (document.activeElement instanceof HTMLElement) {
      responseReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'command-questions'
    }
    setSelectedApprovalSelection(undefined)
    setSelectedPendingResponse({ kind: 'question', taskId: pending.taskId, requestId: request.requestId })
    setQuestionIndex(0)
    setQuestionDrafts(Object.fromEntries(request.questions.map(question => [question.id, {
      selected: [],
      custom: '',
      skipped: false,
    }])))
    setResponseBusy(false)
    setResponseError(undefined)
    setCommandCenterOpen(true)
  }, [allPendingQuestions])

  const openPlanReviewDetail = useCallback(() => {
    const pending = allPendingPlanReviews[0]
    if (pending === undefined) return
    const review = pending.item
    if (document.activeElement instanceof HTMLElement) {
      responseReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'command-plan-reviews'
    }
    setSelectedApprovalSelection(undefined)
    setSelectedPendingResponse({ kind: 'plan-review', taskId: pending.taskId, requestId: review.requestId })
    setResponseBusy(false)
    setResponseError(undefined)
    setCommandCenterOpen(true)
  }, [allPendingPlanReviews])

  const settlePendingResponse = useCallback((operation: () => Promise<void>) => {
    if (responseBusy) return
    const attempt = responseAttemptRef.current + 1
    responseAttemptRef.current = attempt
    setResponseBusy(true)
    setResponseError(undefined)
    void operation().catch(cause => {
      if (responseAttemptRef.current !== attempt) return
      setResponseBusy(false)
      setResponseError(errorMessage(cause))
    })
  }, [responseBusy])

  const submitQuestionRequest = useCallback((drafts: QuestionDrafts) => {
    if (selectedPendingResponse?.kind !== 'question' || selectedQuestionRequest === undefined) return
    const answer = buildQuestionAnswer(selectedQuestionRequest, drafts)
    settlePendingResponse(() => adapter.respondToQuestion(selectedPendingResponse.taskId, selectedQuestionRequest.requestId, answer))
  }, [adapter, selectedPendingResponse, selectedQuestionRequest, settlePendingResponse])

  const updateSelectedQuestionOption = useCallback((label: string) => {
    if (selectedQuestion === undefined) return
    setQuestionDrafts(current => {
      const draft = current[selectedQuestion.id] ?? { selected: [], custom: '', skipped: false }
      const selected = selectedQuestion.multiSelect === true
        ? draft.selected.includes(label)
          ? draft.selected.filter(value => value !== label)
          : [...draft.selected, label]
        : [label]
      return {
        ...current,
        [selectedQuestion.id]: {
          ...draft,
          selected,
          ...(selectedQuestion.multiSelect === true ? {} : { custom: '' }),
          skipped: false,
        },
      }
    })
  }, [selectedQuestion])

  const updateSelectedQuestionCustom = useCallback((custom: string) => {
    if (selectedQuestion === undefined) return
    setQuestionDrafts(current => ({
      ...current,
      [selectedQuestion.id]: {
        ...(current[selectedQuestion.id] ?? { selected: [], custom: '', skipped: false }),
        custom,
        skipped: false,
      },
    }))
  }, [selectedQuestion])

  const advanceQuestion = useCallback((skip: boolean) => {
    if (selectedQuestionRequest === undefined || selectedQuestion === undefined) return
    const nextDrafts = skip
      ? {
          ...questionDrafts,
          [selectedQuestion.id]: { selected: [], custom: '', skipped: true },
        }
      : questionDrafts
    if (questionIndex < selectedQuestionRequest.questions.length - 1) {
      setQuestionDrafts(nextDrafts)
      setQuestionIndex(current => current + 1)
      restoreManagedFocus('question-option-0')
      return
    }
    submitQuestionRequest(nextDrafts)
  }, [questionDrafts, questionIndex, selectedQuestion, selectedQuestionRequest, submitQuestionRequest])

  const cancelPendingResponse = useCallback(() => {
    const requestId = selectedPendingResponse?.requestId
    if (requestId === undefined) return
    settlePendingResponse(() => adapter.cancelQuestion(requestId))
  }, [adapter, selectedPendingResponse?.requestId, settlePendingResponse])

  const decidePlanReview = useCallback((label: string) => {
    if (selectedPendingResponse?.kind !== 'plan-review' || selectedPlanReview === undefined) return
    settlePendingResponse(() => adapter.respondToQuestion(selectedPendingResponse.taskId, selectedPlanReview.requestId, {
      answers: [{ id: selectedPlanReview.id, selected: [label] }],
    }))
  }, [adapter, selectedPendingResponse, selectedPlanReview, settlePendingResponse])

  const toggleCommandCenter = useCallback(() => {
    if (settingsOpen || projectCenterOpen) return
    if (commandCenterOpen) {
      closeCommandCenter()
      return
    }
    if (document.activeElement instanceof HTMLElement) {
      commandReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'settings-toggle'
    }
    setArtifactConfirmation(undefined)
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    setArtifactMutationError(undefined)
    setCommandCenterOpen(true)
  }, [closeCommandCenter, commandCenterOpen, projectCenterOpen, settingsOpen])

  useEffect(() => {
    if (selectedApprovalSelection === undefined || selectedApproval !== undefined) return
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    const next = allPendingApprovals[0]
    if (next !== undefined) {
      setSelectedApprovalSelection({ taskId: next.taskId, approvalId: next.item.approvalId })
      restoreManagedFocus('approval-reject')
      return
    }
    setSelectedApprovalSelection(undefined)
    restoreManagedFocus(commandCenterOpen ? 'command-current-task' : commandReturnFocusRef.current)
  }, [allPendingApprovals, commandCenterOpen, selectedApproval, selectedApprovalSelection])

  useEffect(() => {
    if (selectedPendingResponse === undefined) return
    const stillPending = selectedPendingResponse.kind === 'question'
      ? selectedQuestionRequest !== undefined
      : selectedPlanReview !== undefined
    if (stillPending) return
    setResponseBusy(false)
    setResponseError(undefined)
    setSelectedPendingResponse(undefined)
    setQuestionIndex(0)
    setQuestionDrafts({})
    restoreManagedFocus(commandCenterOpen ? 'command-current-task' : commandReturnFocusRef.current)
  }, [commandCenterOpen, selectedPendingResponse, selectedPlanReview, selectedQuestionRequest])

  const openSettingsFromCommand = useCallback(() => {
    approvalAttemptRef.current += 1
    settingsReturnFocusRef.current = commandReturnFocusRef.current
    setCommandCenterOpen(false)
    setSelectedApprovalSelection(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    loadSettings()
  }, [loadSettings])

  const closeProjectCenter = useCallback(() => {
    if (projectBusy) return
    setProjectCenterOpen(false)
    setProjectName('')
    setProjectError(undefined)
    restoreManagedFocus(projectReturnFocusRef.current)
  }, [projectBusy])

  const openProjectCenter = useCallback(() => {
    projectReturnFocusRef.current = commandCenterOpen
      ? commandReturnFocusRef.current
      : document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.focusId ?? 'settings-toggle'
        : 'settings-toggle'
    taskSelectionRef.current.invalidate()
    setCommandCenterOpen(false)
    setSettingsOpen(false)
    setSelectedApprovalSelection(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    const currentProject = workspaceCatalog.projects.find(p => p.path === workspacePath)
    setProjectPermissionMode(currentProject?.permissionMode ?? projection?.permissionMode ?? 'standard')
    setProjectCenterOpen(true)
    setProjectError(undefined)
    void loadWorkspaceCatalog()
  }, [commandCenterOpen, loadWorkspaceCatalog, projection?.permissionMode, workspaceCatalog.projects, workspacePath])

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await operation()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  const ensureRuntimeReady = useCallback(async (path: string) => {
    let runtimeReady = false
    try {
      await adapter.healthCheck()
      runtimeReady = true
      setConnection('connected')
    } catch {
      setConnection('connecting')
    }
    if (!runtimeReady) {
      await startManagedRuntime(path)
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await delay(500)
        try {
          await adapter.healthCheck()
          runtimeReady = true
          break
        } catch {
          // Runtime startup is bounded by the loop.
        }
      }
      if (!runtimeReady) throw new Error('运行时启动超时')
      setConnection('connected')
    }
  }, [adapter])

  const activateWorkspace = useCallback(async (path: string, permissionMode: TaskPermissionMode) => {
    updateComposingNewSession(false)
    setWorkspacePath(path)
    setProjectPermissionMode(permissionMode)
    await ensureRuntimeReady(path)
    const tasks = await adapter.listTasks()
    setAllTasks(tasks)
    const visible = visibleTasks(tasks, taskArchiveState)
    const existing = visible.find(task => task.workspacePath === path)
    let task: TaskSession
    if (existing !== undefined) {
      await restoreTask(existing)
      task = existing
    } else {
      task = await adapter.createTask({ workspacePath: path })
      await adapter.setTaskPermission(task.id, permissionMode)
      setAllTasks(current => [task, ...current.filter(t => t.id !== task.id)])
      setActiveTaskId(task.id)
      setProjections(current => ({
        ...current,
        [task.id]: { ...createTaskProjection(task.id), permissionMode },
      }))
      setArtifactBaseline(undefined)
      setArtifactSnapshot(undefined)
      setSelectedArtifactChangeId(undefined)
      setArtifactCommitFlow(undefined)
      setTaskInput('')
      setPendingImages([])
      setError(undefined)
      await loadTaskArtifacts(task, true)
    }
    setProjectCenterOpen(false)
    setProjectName('')
    restoreManagedFocus('task-input')
  }, [adapter, ensureRuntimeReady, loadTaskArtifacts, restoreTask, taskArchiveState, updateComposingNewSession])

  const runProject = useCallback(async (operation: () => Promise<void>) => {
    setProjectBusy(true)
    setProjectError(undefined)
    try {
      await operation()
    } catch (cause) {
      setProjectError(errorMessage(cause))
    } finally {
      setProjectBusy(false)
    }
  }, [])

  const handleChooseWorkspaceBase = () => void runProject(async () => {
    const path = await chooseWorkspaceDirectory('选择工作区根目录')
    if (path === undefined) return
    setWorkspaceCatalog(await setWorkspaceBase(path))
  })

  const handleOpenWorkspaceFolder = () => void runProject(async () => {
    const path = await chooseWorkspaceDirectory('打开项目文件夹')
    if (path === undefined) return
    const selection = await rememberWorkspaceProject(path, projectPermissionMode)
    setWorkspaceCatalog(selection.catalog)
    await activateWorkspace(selection.path, projectPermissionMode)
  })

  const handleCreateWorkspaceProject = () => void runProject(async () => {
    const selection = await createWorkspaceProject(projectName.trim(), projectPermissionMode)
    setWorkspaceCatalog(selection.catalog)
    await activateWorkspace(selection.path, projectPermissionMode)
  })

  const handleSelectWorkspaceProject = (path: string) => void runProject(async () => {
    const permissionMode = workspaceCatalog.projects.find(project => project.path === path)?.permissionMode ?? 'standard'
    setProjectPermissionMode(permissionMode)
    const selection = await rememberWorkspaceProject(path, permissionMode)
    setWorkspaceCatalog(selection.catalog)
    await activateWorkspace(selection.path, permissionMode)
  })

  const handleChangeWorkspaceProjectPermission = (path: string, permissionMode: WorkspacePermissionMode) => void runProject(async () => {
    const selection = await rememberWorkspaceProject(path, permissionMode)
    setWorkspaceCatalog(selection.catalog)
    if (path === workspacePath) {
      setProjectPermissionMode(permissionMode)
    }
  })

  const handleSelectProject = useCallback((path: string) => {
    if (path === workspacePath) return
    updateComposingNewSession(false)
    taskSelectionRef.current.invalidate()
    artifactAttemptRef.current += 1
    setWorkspacePath(path)
    setActiveTaskId(undefined)
    setArtifactBaseline(undefined)
    setArtifactSnapshot(undefined)
    setSelectedArtifactChangeId(undefined)
    const projectIndex = workspaceCatalog.projects.findIndex(p => p.path === path)
    if (projectIndex >= 0) {
      restoreManagedFocus(`project-tab-${projectIndex}`)
    }
    const visible = visibleTasks(allTasks, taskArchiveState)
    const projectTasks = visible.filter(t => t.workspacePath === path)
    const proj = workspaceCatalog.projects.find(p => p.path === path)
    const mode = proj?.permissionMode ?? projectPermissionMode
    setProjectPermissionMode(mode)
    if (projectTasks.length > 0) {
      const first = projectTasks[0]
      if (first !== undefined) void restoreTask(first)
    }
  }, [allTasks, projectPermissionMode, restoreTask, taskArchiveState, updateComposingNewSession, workspaceCatalog.projects, workspacePath])

  const handlePreviousProject = useCallback(() => {
    const projectList = workspaceCatalog.projects
    if (projectList.length <= 1) return
    const currentIndex = projectList.findIndex(p => p.path === workspacePath)
    const prevIndex = cycleProjectIndex(currentIndex, projectList.length, 'previous')
    const target = projectList[prevIndex]
    if (target !== undefined) handleSelectProject(target.path)
  }, [handleSelectProject, workspaceCatalog.projects, workspacePath])

  const handleNextProject = useCallback(() => {
    const projectList = workspaceCatalog.projects
    if (projectList.length <= 1) return
    const currentIndex = projectList.findIndex(p => p.path === workspacePath)
    const nextIndex = cycleProjectIndex(currentIndex, projectList.length, 'next')
    const target = projectList[nextIndex]
    if (target !== undefined) handleSelectProject(target.path)
  }, [handleSelectProject, workspaceCatalog.projects, workspacePath])

  const handleSelectSession = useCallback((taskId: string) => {
    if (taskId === activeTaskId && !composingNewSession) return
    updateComposingNewSession(false)
    setTaskInput('')
    setPendingImages([])
    setError(undefined)
    const sessionIndex = currentProjectTasks.findIndex(candidate => candidate.id === taskId)
    if (sessionIndex >= 0) {
      restoreManagedFocus(`session-card-${sessionIndex}`)
    }
    const task = currentProjectTasks.find(candidate => candidate.id === taskId)
    if (task !== undefined) void restoreTask(task)
  }, [activeTaskId, composingNewSession, currentProjectTasks, restoreTask, updateComposingNewSession])

  const handleHorizontalWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const track = event.currentTarget
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || track.scrollWidth <= track.clientWidth) return
    event.preventDefault()
    track.scrollBy({ left: event.deltaY, behavior: 'smooth' })
  }, [])

  const handlePreviousSession = useCallback(() => {
    if (currentProjectTasks.length <= 1 || activeTask === undefined) return
    const currentIndex = currentProjectTasks.findIndex(t => t.id === activeTask.id)
    const prevIndex = currentIndex <= 0 ? currentProjectTasks.length - 1 : currentIndex - 1
    const target = currentProjectTasks[prevIndex]
    if (target !== undefined) handleSelectSession(target.id)
  }, [activeTask, currentProjectTasks, handleSelectSession])

  const handleNextSession = useCallback(() => {
    if (currentProjectTasks.length <= 1 || activeTask === undefined) return
    const currentIndex = currentProjectTasks.findIndex(t => t.id === activeTask.id)
    const nextIndex = currentIndex < 0 || currentIndex >= currentProjectTasks.length - 1 ? 0 : currentIndex + 1
    const target = currentProjectTasks[nextIndex]
    if (target !== undefined) handleSelectSession(target.id)
  }, [activeTask, currentProjectTasks, handleSelectSession])

  const handleArchiveTask = useCallback(() => {
    if (activeTask === undefined
      || activeTask.running
      || pendingApprovals.length > 0
      || pendingQuestions.length > 0
      || pendingPlanReviews.length > 0) return
    const nextState = archiveTask(taskArchiveState, activeTask.id)
    saveTaskArchiveState(nextState)
    setTaskArchiveState(nextState)
    const nextTask = currentProjectTasks.find(task => task.id !== activeTask.id)
    setActiveTaskId(nextTask?.id)
    closeCommandCenter()
    if (nextTask !== undefined) void restoreTask(nextTask)
  }, [activeTask, closeCommandCenter, currentProjectTasks, pendingApprovals.length, pendingPlanReviews.length, pendingQuestions.length, restoreTask, taskArchiveState])

  const handleRestoreArchivedTask = useCallback((task: TaskSession) => {
    const nextState = restoreArchivedTask(taskArchiveState, task.id)
    saveTaskArchiveState(nextState)
    setTaskArchiveState(nextState)
    setArchiveViewOpen(false)
    setCommandCenterOpen(false)
    updateComposingNewSession(false)
    void restoreTask(task)
  }, [restoreTask, taskArchiveState, updateComposingNewSession])

  const handleNewSession = useCallback(() => {
    const targetPath = workspacePath.trim() || workspaceCatalog.projects[0]?.path || ''
    if (targetPath === '') {
      openProjectCenter()
      return
    }
    taskSelectionRef.current.invalidate()
    artifactAttemptRef.current += 1
    if (targetPath !== workspacePath) {
      setWorkspacePath(targetPath)
    }
    updateComposingNewSession(true)
    setActiveTaskId(undefined)
    setArtifactBaseline(undefined)
    setArtifactSnapshot(undefined)
    setSelectedArtifactChangeId(undefined)
    setArtifactCommitFlow(undefined)
    setTaskInput('')
    setPendingImages([])
    setError(undefined)
    restoreManagedFocus('task-input')
  }, [openProjectCenter, updateComposingNewSession, workspaceCatalog.projects, workspacePath])

  const applyActiveSessionPermission = useCallback(async (nextMode: TaskPermissionMode) => {
    if (activeTask === undefined || permissionChangeBusy || nextMode === activePermissionMode) return
    setPermissionChangeBusy(true)
    setPermissionChangeError(undefined)
    setError(undefined)
    try {
      await adapter.setTaskPermission(activeTask.id, nextMode)
      setProjections(current => {
        const existing = current[activeTask.id] ?? createTaskProjection(activeTask.id)
        return {
          ...current,
          [activeTask.id]: { ...existing, permissionMode: nextMode },
        }
      })
      setPermissionConfirmationOpen(false)
      setCommandCenterOpen(false)
    } catch (cause) {
      const message = errorMessage(cause)
      setPermissionChangeError(message)
      setError(message)
    } finally {
      setPermissionChangeBusy(false)
    }
  }, [activePermissionMode, activeTask, adapter, permissionChangeBusy])

  const handleToggleActiveSessionPermission = useCallback(() => {
    if (activeTask === undefined || permissionChangeBusy) return
    if (activePermissionMode === 'full-access') {
      void applyActiveSessionPermission('standard')
      return
    }
    if (!commandCenterOpen && document.activeElement instanceof HTMLElement) {
      commandReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'task-permission-toggle'
    }
    setPermissionChangeError(undefined)
    setPermissionConfirmationOpen(true)
    setCommandCenterOpen(true)
  }, [activePermissionMode, activeTask, applyActiveSessionPermission, commandCenterOpen, permissionChangeBusy])

  const closePermissionConfirmation = useCallback(() => {
    if (permissionChangeBusy) return
    setPermissionConfirmationOpen(false)
    setPermissionChangeError(undefined)
    restoreManagedFocus('command-toggle-permission')
  }, [permissionChangeBusy])

  const handleNewProject = useCallback(() => {
    openProjectCenter()
  }, [openProjectCenter])

  const handleRuntime = () => void run(async () => {
    if (connection === 'connected') {
      await stopManagedRuntime()
      setConnection('disconnected')
      return
    }
    if (workspacePath.trim() === '') throw new Error('请先填写工作空间路径')
    await startManagedRuntime(workspacePath.trim())
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(500)
      if (await reconnect()) return
    }
    throw new Error('运行时启动超时')
  })

  const handleRemoveImage = useCallback((id: string) => {
    setPendingImages(current => current.filter(img => img.id !== id))
  }, [])

  const openImageLightbox = useCallback((image: LightboxImage) => {
    lightboxReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setLightboxImage(image)
  }, [])

  const closeImageLightbox = useCallback(() => {
    const returnTarget = lightboxReturnFocusRef.current
    setLightboxImage(null)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus()
      })
    })
  }, [])

  const handlePreviewPendingImage = useCallback((img: ImageAttachmentInput) => {
    openImageLightbox({
      src: img.data.startsWith('data:') ? img.data : `data:${img.mediaType};base64,${img.data}`,
      name: img.name,
      alt: img.name,
      bytes: img.size,
    })
  }, [openImageLightbox])

  const handleAddImageFiles = useCallback((files: FileList | File[]) => {
    const validMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    const list = Array.from(files)
    for (const file of list) {
      if (!validMimes.has(file.type)) continue
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          const resultStr = reader.result
          const id = `att-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          setPendingImages(current => [
            ...current,
            {
              id,
              mediaType: file.type as ImageMediaType,
              data: resultStr,
              name: file.name,
              size: file.size,
            },
          ])
        }
      }
      reader.readAsDataURL(file)
    }
  }, [])

  const handlePaste = useCallback((event: React.ClipboardEvent | ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault()
      handleAddImageFiles(imageFiles)
    }
  }, [handleAddImageFiles])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer?.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.contains(event.relatedTarget as Node)) return
    setIsDraggingOver(false)
  }, [])

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsDraggingOver(false)
    const files = event.dataTransfer?.files
    if (files && files.length > 0) {
      handleAddImageFiles(files)
    }
  }, [handleAddImageFiles])

  const handleTriggerScreenshot = useCallback(async () => {
    if (screenshotBusy) return
    setScreenshotBusy(true)
    setError(undefined)
    try {
      const dataUrl = await captureScreenImage()
      const blob = dataUrlToBlob(dataUrl)
      const copied = await writeImageToClipboard(blob)

      const now = Date.now()
      setPendingImages(current => [
        ...current,
        {
          id: `att-screenshot-${now}-${Math.random().toString(36).slice(2, 8)}`,
          mediaType: 'image/png',
          data: dataUrl,
          name: `screenshot-${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
          size: blob.size,
        },
      ])
      if (!copied) setError('截图已添加，但无法写入系统剪贴板')
      requestAnimationFrame(() => focusManagedElement('task-input'))
    } catch (cause) {
      const cancelled = cause instanceof DOMException
        && (cause.name === 'NotAllowedError' || cause.name === 'AbortError')
      if (!cancelled) setError(errorMessage(cause))
    } finally {
      setScreenshotBusy(false)
    }
  }, [screenshotBusy])

  const handlePasteFromClipboard = useCallback(async () => {
    const file = await readImageFromClipboard()
    if (file) {
      handleAddImageFiles([file])
    }
  }, [handleAddImageFiles])

  const handleSend = useCallback(() => {
    if (sendBusy) return
    const text = taskInput.trim()
    const imagesToSend = [...pendingImages]
    if (text === '' && imagesToSend.length === 0) return

    setSendBusy(true)
    setError(undefined)

    void (async () => {
      let currentTask = activeTask
      const now = Date.now()
      const optimisticMsg: TaskProjectionMessage = {
        id: `user-input-${now}`,
        role: 'user',
        content: text,
        time: now,
        isSystemInjection: false,
        isCommand: text.startsWith('/'),
        ...(imagesToSend.length > 0
          ? {
              images: imagesToSend.map(img => ({
                id: img.id,
                dataUrl: img.data.startsWith('data:') ? img.data : `data:${img.mediaType};base64,${img.data}`,
                mediaType: img.mediaType,
                name: img.name,
                bytes: img.size,
              })),
            }
          : {}),
      }

      try {
        if (currentTask === undefined) {
          const targetPath = workspacePath.trim() || workspaceCatalog.projects[0]?.path || ''
          if (targetPath === '') {
            openProjectCenter()
            throw new Error('请先选择或创建一个项目')
          }
          if (targetPath !== workspacePath) {
            setWorkspacePath(targetPath)
          }
          taskSelectionRef.current.invalidate()
          const proj = workspaceCatalog.projects.find(p => p.path === targetPath)
          const targetPermission: TaskPermissionMode = proj?.permissionMode ?? projectPermissionMode ?? 'standard'
          if (connection !== 'connected') {
            await ensureRuntimeReady(targetPath)
          }
          const newTask = await adapter.createTask({ workspacePath: targetPath })
          await adapter.setTaskPermission(newTask.id, targetPermission)
          setAllTasks(current => [newTask, ...current.filter(t => t.id !== newTask.id)])
          setActiveTaskId(newTask.id)
          updateComposingNewSession(false)
          const newProj: TaskProjection = {
            ...createTaskProjection(newTask.id),
            permissionMode: targetPermission,
          }
          setProjections(current => ({ ...current, [newTask.id]: newProj }))
          setArtifactBaseline(undefined)
          setArtifactSnapshot(undefined)
          setSelectedArtifactChangeId(undefined)
          setArtifactCommitFlow(undefined)
          void loadTaskArtifacts(newTask, true)
          currentTask = newTask
        }

        const taskId = currentTask.id
        setProjections(current => {
          const existing = current[taskId] ?? createTaskProjection(taskId)
          const { failure: _failure, ...clean } = existing
          return {
            ...current,
            [taskId]: {
              ...clean,
              status: 'running',
              output: '',
              messages: [...clean.messages, optimisticMsg],
            },
          }
        })
        setAllTasks(current => current.map(t => t.id === taskId ? { ...t, running: true } : t))
        setTaskInput('')
        setPendingImages([])
        await adapter.sendInput(taskId, text, imagesToSend)
      } catch (cause) {
        const message = errorMessage(cause)
        setError(message)
        setTaskInput(current => current === '' ? text : current)
        setPendingImages(current => current.length === 0 ? imagesToSend : [...imagesToSend, ...current])
        if (currentTask !== undefined) {
          const taskId = currentTask.id
          setAllTasks(current => current.map(t => t.id === taskId ? { ...t, running: false } : t))
          setProjections(current => {
            const existing = current[taskId]
            if (existing === undefined) return current
            return {
              ...current,
              [taskId]: {
                ...existing,
                status: 'failed',
                failure: { message },
                messages: existing.messages.map(candidate => candidate.id === optimisticMsg.id
                  ? { ...candidate, status: 'failed', failure: { message } }
                  : candidate),
              },
            }
          })
        }
      } finally {
        setSendBusy(false)
      }
    })()
  }, [activeTask, adapter, connection, ensureRuntimeReady, loadTaskArtifacts, openProjectCenter, pendingImages, projectPermissionMode, sendBusy, taskInput, updateComposingNewSession, workspaceCatalog.projects, workspacePath])

  const handleVoiceInputTrigger = useCallback((action: 'tap' | 'press' | 'release' = 'tap') => {
    if (!voiceConfig.enabled) return

    const active = document.activeElement
    if (!isEditableVoiceInputTarget(active)) {
      focusManagedElement('task-input')
    }

    if (action === 'press') setIsVoicePressed(true)
    if (action === 'release') setIsVoicePressed(false)

    const target = action === 'release'
      ? pressedVoiceTargetRef.current ?? voiceConfig
      : voiceConfig
    if (action === 'press') pressedVoiceTargetRef.current = target
    if (action === 'release') pressedVoiceTargetRef.current = null

    voiceActionQueueRef.current = voiceActionQueueRef.current
      .catch(() => undefined)
      .then(() => simulateKeyAction(target.targetKey, action, target.customKeyCode))
      .catch(err => {
        setIsVoicePressed(false)
        setError(errorMessage(err))
        void refreshVoiceCapabilities()
        console.error(`模拟按键${action === 'press' ? '按下' : action === 'release' ? '释放' : ''}失败`, err)
      })
  }, [refreshVoiceCapabilities, voiceConfig])

  const handlePauseTask = useCallback(() => void run(async () => {
    if (activeTask === undefined) return
    await adapter.pauseTask(activeTask.id)
  }), [activeTask, adapter, run])

  const handleToggleFullscreen = useCallback(() => {
    void toggleWindowFullscreen().then(setIsFullscreen)
  }, [])

  const applyArtifactSnapshot = useCallback((
    nextSnapshot: TaskArtifactSnapshot,
    previousChanges: readonly TaskFileChange[],
    removedChangeId?: string,
  ): string | undefined => {
    const nextSelection = selectArtifactChangeAfterMutation(
      selectedArtifactChangeId,
      previousChanges,
      nextSnapshot.changes,
      removedChangeId,
    )
    setArtifactBaseline(nextSnapshot.baseline)
    setArtifactSnapshot(nextSnapshot)
    setSelectedArtifactChangeId(nextSelection)
    return nextSelection
  }, [selectedArtifactChangeId])

  const handleArtifactFailure = useCallback((
    cause: unknown,
    previousChanges: readonly TaskFileChange[],
  ) => {
    if (cause instanceof ArtifactOperationException && cause.latestSnapshot !== undefined) {
      applyArtifactSnapshot(cause.latestSnapshot, previousChanges)
    }
    setArtifactMutationError(errorMessage(cause))
  }, [applyArtifactSnapshot])

  const handleAcceptArtifactChange = useCallback((changeId: string) => {
    if (!canReviewArtifacts || activeTask?.workspacePath === undefined || artifactSnapshot?.availability !== 'ready') return
    const previousChanges = artifactSnapshot.changes
    setArtifactMutationBusy(true)
    setArtifactMutationError(undefined)
    void reviewTaskArtifactFile(
      activeTask.id,
      activeTask.workspacePath,
      artifactSnapshot.snapshotToken,
      changeId,
      'accept',
    )
      .then(result => {
        applyArtifactSnapshot(result.latestSnapshot, previousChanges)
        restoreManagedFocus(`inspector-file-${changeId}`)
      })
      .catch(cause => handleArtifactFailure(cause, previousChanges))
      .finally(() => setArtifactMutationBusy(false))
  }, [activeTask, applyArtifactSnapshot, artifactSnapshot, canReviewArtifacts, handleArtifactFailure])

  const requestRejectArtifactChange = useCallback((changeId: string) => {
    if (!canReviewArtifacts || artifactSnapshot?.availability !== 'ready') return
    const change = artifactSnapshot.changes.find(candidate => candidate.changeId === changeId)
    if (change === undefined) return
    commandReturnFocusRef.current = `inspector-file-${changeId}`
    setSelectedApprovalSelection(undefined)
    setArtifactMutationError(undefined)
    setArtifactConfirmation({ kind: 'reject-file', changeId, path: change.path, returnTo: 'inspector' })
    setCommandCenterOpen(true)
  }, [artifactSnapshot, canReviewArtifacts])

  const requestRollbackTaskArtifacts = useCallback(() => {
    if (!canRollbackArtifacts) return
    setSelectedApprovalSelection(undefined)
    setArtifactMutationError(undefined)
    setArtifactConfirmation({ kind: 'rollback-task', returnTo: 'command' })
  }, [canRollbackArtifacts])

  const closeArtifactConfirmation = useCallback(() => {
    if (artifactMutationBusy || artifactConfirmation === undefined) return
    setArtifactConfirmation(undefined)
    setArtifactMutationError(undefined)
    if (artifactConfirmation.returnTo === 'command') {
      restoreManagedFocus('command-rollback-artifacts')
      return
    }
    setCommandCenterOpen(false)
    restoreManagedFocus(commandReturnFocusRef.current)
  }, [artifactConfirmation, artifactMutationBusy])

  const confirmArtifactMutation = useCallback(() => {
    if (artifactMutationBusy
      || artifactConfirmation === undefined
      || activeTask?.workspacePath === undefined
      || artifactSnapshot?.availability !== 'ready') return
    const confirmation = artifactConfirmation
    const previousChanges = artifactSnapshot.changes
    const removedChangeId = confirmation.kind === 'reject-file' ? confirmation.changeId : undefined
    const operation = confirmation.kind === 'reject-file'
      ? reviewTaskArtifactFile(
          activeTask.id,
          activeTask.workspacePath,
          artifactSnapshot.snapshotToken,
          confirmation.changeId,
          'reject',
        )
      : rollbackTaskArtifacts(activeTask.id, activeTask.workspacePath, artifactSnapshot.snapshotToken)

    setArtifactMutationBusy(true)
    setArtifactMutationError(undefined)
    void operation
      .then(result => {
        const nextSelection = applyArtifactSnapshot(result.latestSnapshot, previousChanges, removedChangeId)
        const focusId = nextSelection === undefined ? 'inspector-tab-changes' : `inspector-file-${nextSelection}`
        commandReturnFocusRef.current = focusId
        setArtifactConfirmation(undefined)
        setCommandCenterOpen(false)
        restoreManagedFocus(focusId)
      })
      .catch(cause => handleArtifactFailure(cause, previousChanges))
      .finally(() => setArtifactMutationBusy(false))
  }, [activeTask, applyArtifactSnapshot, artifactConfirmation, artifactMutationBusy, artifactSnapshot, handleArtifactFailure])

  const beginArtifactCommitProposal = useCallback(() => {
    if (!canCommitArtifacts
      || activeTask?.workspacePath === undefined
      || artifactSnapshot?.availability !== 'ready') return
    const task = activeTask
    const taskWorkspacePath = activeTask.workspacePath
    const snapshot = artifactSnapshot
    const previousChanges = snapshot.changes
    const acceptedCount = acceptedArtifactCount
    const attempt = commitAttemptRef.current + 1
    commitAttemptRef.current = attempt
    setSelectedApprovalSelection(undefined)
    setArtifactConfirmation(undefined)
    setArtifactMutationError(undefined)
    setArtifactCommitFlow({
      phase: 'generating',
      acceptedCount,
      snapshotToken: snapshot.snapshotToken,
    })

    void (async () => {
      try {
        const { proposalId } = await requestTaskCommitProposal(
          task.id,
          taskWorkspacePath,
          snapshot.snapshotToken,
        )
        for (let poll = 0; poll < 240; poll += 1) {
          if (commitAttemptRef.current !== attempt) return
          const resolution = await resolveTaskCommitProposal(proposalId, {
            taskId: task.id,
            workspacePath: taskWorkspacePath,
          })
          if (commitAttemptRef.current !== attempt) return
          if (resolution.status === 'generating') {
            await delay(500)
            continue
          }
          if (resolution.status === 'failed') {
            if (resolution.latestSnapshot !== undefined) {
              applyArtifactSnapshot(resolution.latestSnapshot, previousChanges)
            }
            setArtifactCommitFlow({ phase: 'failed', acceptedCount, message: resolution.message })
            return
          }
          if (resolution.status === 'completed') {
            setArtifactCommitFlow({ phase: 'completed', acceptedCount, revision: resolution.revision })
            return
          }
          const { proposal } = resolution
          if (proposal.proposalId !== proposalId
            || (proposal.taskId !== undefined && proposal.taskId !== task.id)
            || (proposal.workspacePath !== undefined && proposal.workspacePath !== taskWorkspacePath)
            || (proposal.snapshotToken !== undefined && proposal.snapshotToken !== snapshot.snapshotToken)) {
            throw new ArtifactOperationException('operation-failed', '提交说明提案与当前任务成果不匹配')
          }
          setArtifactCommitFlow({
            phase: 'editing',
            acceptedCount,
            proposal,
            message: proposal.message,
          })
          return
        }
        throw new ArtifactOperationException('operation-failed', '生成提交说明超时，请重试')
      } catch (cause) {
        if (commitAttemptRef.current !== attempt) return
        if (cause instanceof ArtifactOperationException && cause.latestSnapshot !== undefined) {
          applyArtifactSnapshot(cause.latestSnapshot, previousChanges)
        }
        setArtifactCommitFlow({ phase: 'failed', acceptedCount, message: errorMessage(cause) })
      }
    })()
  }, [acceptedArtifactCount, activeTask, applyArtifactSnapshot, artifactSnapshot, canCommitArtifacts])

  const closeArtifactCommitFlow = useCallback(() => {
    if (artifactCommitFlow?.phase === 'committing') return
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    restoreManagedFocus(canCommitArtifacts ? 'command-commit-artifacts' : 'command-current-task')
  }, [artifactCommitFlow?.phase, canCommitArtifacts])

  const updateArtifactCommitMessage = useCallback((message: string) => {
    setArtifactCommitFlow(current => current?.phase === 'editing'
      ? { ...current, message }
      : current)
  }, [])

  const requestArtifactCommitConfirmation = useCallback(() => {
    setArtifactCommitFlow(current => {
      if (current?.phase !== 'editing') return current
      const message = current.message.trim()
      if (message === '') return current
      return { ...current, phase: 'confirming', message }
    })
  }, [])

  const cancelArtifactCommitConfirmation = useCallback(() => {
    setArtifactCommitFlow(current => current?.phase === 'confirming'
      ? { ...current, phase: 'editing' }
      : current)
    restoreManagedFocus('commit-continue')
  }, [])

  const confirmArtifactCommit = useCallback(() => {
    if (artifactCommitFlow?.phase !== 'confirming'
      || activeTask?.workspacePath === undefined
      || artifactSnapshot?.availability !== 'ready') return
    const flow = artifactCommitFlow
    const task = activeTask
    const taskWorkspacePath = activeTask.workspacePath
    const previousChanges = artifactSnapshot.changes
    const attempt = commitAttemptRef.current
    setArtifactCommitFlow({ ...flow, phase: 'committing' })
    void commitTaskArtifacts(flow.proposal.proposalId, flow.message, {
      taskId: task.id,
      workspacePath: taskWorkspacePath,
    })
      .then(async result => {
        if (commitAttemptRef.current !== attempt) return
        if (result.latestSnapshot !== undefined) {
          applyArtifactSnapshot(result.latestSnapshot, previousChanges)
        } else {
          await loadTaskArtifacts(task, false)
        }
        if (commitAttemptRef.current !== attempt) return
        setArtifactCommitFlow({
          phase: 'completed',
          acceptedCount: flow.acceptedCount,
          revision: result.revision,
          ...(result.warning === undefined ? {} : { warning: result.warning }),
        })
      })
      .catch(cause => {
        if (commitAttemptRef.current !== attempt) return
        if (cause instanceof ArtifactOperationException && cause.latestSnapshot !== undefined) {
          applyArtifactSnapshot(cause.latestSnapshot, previousChanges)
        }
        setArtifactCommitFlow({
          phase: 'failed',
          acceptedCount: flow.acceptedCount,
          message: errorMessage(cause),
        })
      })
  }, [activeTask, applyArtifactSnapshot, artifactCommitFlow, artifactSnapshot, loadTaskArtifacts])

  const handleInspectorPageChange = useCallback((page: InspectorPage) => {
    setInspectorPage(page)
    if (page === 'activity' || activeTask === undefined || artifactsLoading) return
    if (projection?.status === 'running' || projection?.status === 'waiting-approval') return
    if (artifactBaseline !== undefined || artifactSnapshot === undefined) {
      void loadTaskArtifacts(activeTask, false)
    }
  }, [activeTask, artifactBaseline, artifactSnapshot, artifactsLoading, loadTaskArtifacts, projection?.status])

  const handleSelectArtifactChange = useCallback((changeId: string) => {
    setSelectedArtifactChangeId(changeId)
    setArtifactMutationError(undefined)
  }, [])

  const handleEstablishBaseline = useCallback(() => {
    if (activeTask === undefined) return
    void loadTaskArtifacts(activeTask, true)
  }, [activeTask, loadTaskArtifacts])

  const moveInspectorPage = useCallback((offset: -1 | 1) => {
    const current = INSPECTOR_PAGES.indexOf(inspectorPage)
    const next = (current + offset + INSPECTOR_PAGES.length) % INSPECTOR_PAGES.length
    const page = INSPECTOR_PAGES[next]
    if (page !== undefined) handleInspectorPageChange(page)
  }, [handleInspectorPageChange, inspectorPage])

  useEffect(() => {
    const previous = previousArtifactStatusRef.current
    const current = projection?.status
    previousArtifactStatusRef.current = current
    const executionStopped = previous === 'running' || previous === 'waiting-approval' || previous === 'waiting-response'
    const workspaceStable = current !== 'running' && current !== 'waiting-approval' && current !== 'waiting-response'
    if (!executionStopped || !workspaceStable || activeTask === undefined || artifactBaseline === undefined) return
    void loadTaskArtifacts(activeTask, false)
  }, [activeTask, artifactBaseline, loadTaskArtifacts, projection?.status])

  const handleApplyModel = () => {
    const provider = PROVIDERS[selectedProvider]
    const credentialStatus = credentialStatuses[selectedProvider]
    const value = apiKeyDraft.trim()
    const baseUrl = baseUrlDrafts[selectedProvider].trim()
    if (credentialStatus === undefined) {
      setSettingsError('尚未读取到凭据状态')
      return
    }
    if (!credentialStatus.configured && value === '') {
      setSettingsError(`请输入 ${provider.name} API Key`)
      return
    }
    if (value !== '') {
      const validationError = validateApiKey(value)
      if (validationError !== undefined) {
        setSettingsError(validationError)
        return
      }
    }
    const baseUrlError = validateBaseUrl(baseUrl)
    if (baseUrlError !== undefined) {
      setSettingsError(baseUrlError)
      return
    }
    const model = selectedModel.trim()
    if (selectedProvider === 'openai') {
      const modelError = validateModelId(model)
      if (modelError !== undefined) {
        setSettingsError(modelError)
        return
      }
    }
    const selection: ModelSelection = {
      provider: selectedProvider,
      model: selectedProvider === 'openai' ? model : provider.defaultModel,
    }
    setSettingsBusy(true)
    setSettingsError(undefined)
    setSettingsMessage(undefined)
    void (async () => {
      if (value !== '') await adapter.setCredential(provider.credentialRef, value)
      await adapter.configureProvider(selectedProvider, provider.credentialRef, baseUrl)
      await adapter.setDefaultModel(selection)
      if (activeTask !== undefined) await adapter.selectTaskModel(activeTask.id, selection)
      const refreshedStatus = await adapter.describeCredential(provider.credentialRef)
      setCredentialStatuses(current => ({
        ...current,
        [selectedProvider]: refreshedStatus,
      }))
      setApiKeyDraft('')
      setShowApiKey(false)
      setSettingsMessage(`${provider.name} 已启用${activeTask === undefined ? '，将用于新任务。' : '，下一条消息将使用所选模型。'}`)
    })()
      .catch(cause => setSettingsError(errorMessage(cause)))
      .finally(() => setSettingsBusy(false))
  }

  const credentialStatus = credentialStatuses[selectedProvider]
  const provider = PROVIDERS[selectedProvider]
  const baseUrlDraft = baseUrlDrafts[selectedProvider]
  const canApplyModel = credentialStatus !== undefined
    && (credentialStatus.configured || apiKeyDraft.trim() !== '')
    && (selectedProvider !== 'openai' || selectedModel.trim() !== '')

  const connected = connection === 'connected'
  const events = projection?.events ?? []
  const activityItems = useMemo(() => aggregateActivityItems(events), [events])
  const canPauseTask = (projection?.status === 'running'
    || projection?.status === 'waiting-approval'
    || projection?.status === 'waiting-response') && !busy
  const focusGraph = useMemo(() => createAppFocusGraph({
    connected,
    hasActiveTask: activeTask !== undefined || composingNewSession,
    hasFailureAction: projection?.failure?.code === 'MISSING_CREDENTIAL',
    busy,
    canPauseTask,
    canSend: (taskInput.trim() !== '' || pendingImages.length > 0) && !sendBusy,
    settingsOpen,
    commandCenterOpen,
    approvalDetailOpen: selectedApproval !== undefined,
    archiveViewOpen,
    archivedTaskCount: archivedTaskList.length,
    canArchiveTask: activeTask !== undefined && !activeTask.running && !canPauseTask,
    permissionConfirmationOpen,
    artifactConfirmationOpen: artifactConfirmation !== undefined,
    ...(artifactCommitFlow === undefined ? {} : { commitPhase: artifactCommitFlow.phase }),
    approvalResponding: approvalRespondingId !== undefined,
    pendingApprovalCount: allPendingApprovals.length,
    pendingQuestionCount: allPendingQuestions.length,
    pendingPlanReviewCount: allPendingPlanReviews.length,
    ...(selectedPendingResponse === undefined ? {} : { pendingResponseKind: selectedPendingResponse.kind }),
    questionOptionCount: selectedQuestion?.options?.length ?? 0,
    questionAnswered: selectedQuestionAnswered,
    questionHasPrevious: questionIndex > 0,
    questionHasNext: selectedQuestionRequest !== undefined && questionIndex < selectedQuestionRequest.questions.length - 1,
    planReviewHasDecline: selectedPlanReview?.decline !== undefined,
    projectCenterOpen,
    projectPermissionMode,
    projectCount: workspaceCatalog.projects.length,
    activeProjectIndex: activeProjectIndex >= 0 ? activeProjectIndex : 0,
    sessionCount: currentProjectTasks.length,
    activeSessionIndex: activeSessionIndex >= 0 ? activeSessionIndex : 0,
    draftSession: composingNewSession,
    hasWorkspaceBase: workspaceCatalog.baseDirectory !== undefined,
    canCreateProject: projectName.trim() !== '' && !projectBusy,
    selectedProvider,
    settingsReady: credentialStatus !== undefined,
    credentialWritable: credentialStatus?.writable === true,
    canSaveSettings: canApplyModel && !settingsBusy,
    voicePermissionActionAvailable: voiceCapabilities?.permissionRequired === true && voiceCapabilities.permissionGranted !== true,
    inspectorPage,
    inspectorOpen,
    artifactChangeIds: artifactSnapshot?.changes.map(change => change.changeId) ?? [],
    ...(selectedArtifactChangeId === undefined ? {} : { selectedArtifactChangeId }),
    selectedArtifactAccepted: selectedArtifactChange?.review === 'accepted',
    canReviewArtifacts,
    canRollbackArtifacts,
    canCommitArtifacts,
    canContinueCommit: artifactCommitFlow?.phase === 'editing' && artifactCommitFlow.message.trim() !== '',
    lightboxOpen: lightboxImage !== null,
    pendingAttachmentIds: pendingImages.map(img => img.id),
    ...(gamepadSelect === null ? {} : {
      gamepadSelectOptionIds: gamepadSelect.choices.map(choice => `gamepad-select-option-${choice.optionIndex}`),
      gamepadSelectSelectedId: `gamepad-select-option-${gamepadSelect.choices.find(choice => choice.selected)?.optionIndex ?? gamepadSelect.choices[0]?.optionIndex ?? 0}`,
    }),
  }), [activeProjectIndex, activeSessionIndex, activeTask, allPendingApprovals.length, allPendingPlanReviews.length, allPendingQuestions.length, approvalRespondingId, archiveViewOpen, archivedTaskList.length, artifactCommitFlow, artifactConfirmation, artifactSnapshot?.changes, busy, canApplyModel, canCommitArtifacts, canPauseTask, canReviewArtifacts, canRollbackArtifacts, commandCenterOpen, composingNewSession, connected, credentialStatus, currentProjectTasks.length, gamepadSelect, inspectorOpen, inspectorPage, lightboxImage, pendingImages, permissionConfirmationOpen, projectBusy, projectCenterOpen, projectName, projectPermissionMode, projection?.failure?.code, questionIndex, selectedApproval, selectedArtifactChange?.review, selectedArtifactChangeId, selectedPendingResponse, selectedPlanReview?.decline, selectedProvider, selectedQuestion?.options?.length, selectedQuestionAnswered, selectedQuestionRequest, sendBusy, settingsBusy, settingsOpen, taskInput, voiceCapabilities, workspaceCatalog])

  useSemanticNavigation({
    graph: focusGraph,
    enabled: true,
    ...(lightboxImage === null && gamepadSelect === null ? { onCommandCenter: toggleCommandCenter } : {}),
    onOpenSelect: openGamepadSelect,
    onPauseTask: handlePauseTask,
    ...(lightboxImage === null ? { onVoiceInput: handleVoiceInputTrigger } : {}),
    voiceInputGamepadButton: voiceConfig.gamepadButton,
    ...(lightboxImage === null && gamepadSelect === null ? {
      onPreviousProject: handlePreviousProject,
      onNextProject: handleNextProject,
      onPreviousSession: handlePreviousSession,
      onNextSession: handleNextSession,
      onNewSession: handleNewSession,
      onNewProject: handleNewProject,
      onScreenshot: () => void handleTriggerScreenshot(),
    } : {}),
    ...(!settingsOpen && !projectCenterOpen && !commandCenterOpen && lightboxImage === null && gamepadSelect === null && inspectorPage === 'changes' && selectedArtifactChangeId !== undefined
      ? {
          onPrimaryAction: () => handleAcceptArtifactChange(selectedArtifactChangeId),
          onMoreActions: () => requestRejectArtifactChange(selectedArtifactChangeId),
        }
      : !settingsOpen && !projectCenterOpen && !commandCenterOpen && lightboxImage === null && gamepadSelect === null
        ? {
            onPrimaryAction: handleNewProject,
            onMoreActions: () => void handleNewSession(),
          }
        : {}),
    ...(!settingsOpen && !projectCenterOpen && !commandCenterOpen && lightboxImage === null && gamepadSelect === null && activeTask !== undefined && inspectorOpen
      ? {
          onPreviousPage: () => moveInspectorPage(-1),
          onNextPage: () => moveInspectorPage(1),
        }
      : {}),
    ...(gamepadSelect !== null
      ? { onBack: closeGamepadSelect }
      : lightboxImage !== null
      ? { onBack: closeImageLightbox }
      : projectCenterOpen
      ? { onBack: closeProjectCenter }
      : commandCenterOpen && permissionConfirmationOpen
        ? { onBack: closePermissionConfirmation }
      : commandCenterOpen && artifactConfirmation !== undefined
        ? { onBack: closeArtifactConfirmation }
      : commandCenterOpen && artifactCommitFlow !== undefined
        ? artifactCommitFlow.phase === 'confirming'
          ? { onBack: cancelArtifactCommitConfirmation }
          : artifactCommitFlow.phase === 'committing'
            ? {}
            : { onBack: closeArtifactCommitFlow }
      : commandCenterOpen && selectedPendingResponse !== undefined
        ? { onBack: closePendingResponseDetail }
      : commandCenterOpen && selectedApproval !== undefined
        ? { onBack: closeApprovalDetail }
        : commandCenterOpen
          ? { onBack: closeCommandCenter }
        : settingsOpen ? { onBack: closeSettings } : {}),
  })

  const voiceGamepadConflict = gamepadButtonConflict(voiceConfig.gamepadButton)
  const composerForm = (
    <>
      <form
        className={`composer ${isDraggingOver ? 'composer--dragover' : ''}`}
        onSubmit={(event) => { event.preventDefault(); handleSend() }}
      >
        <label htmlFor="task-input">{composingNewSession ? '这条消息会开启新会话' : '告诉 JoyDSH 要完成什么'}</label>
        <AttachmentRail
          images={pendingImages}
          onRemove={handleRemoveImage}
          onPreview={handlePreviewPendingImage}
        />
        <div className="composer-input-wrap">
          <textarea
            data-focus-id="task-input"
            id="task-input"
            value={taskInput}
            onChange={event => setTaskInput(event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                if ((taskInput.trim() !== '' || pendingImages.length > 0) && !sendBusy) handleSend()
              }
            }}
            placeholder={composingNewSession
              ? (pendingImages.length > 0 ? '附加说明（可选），发送后开启新会话' : '描述新任务，发送后会开启独立会话')
              : (pendingImages.length > 0 ? '附加说明（可选）或按 Cmd+Enter 发送' : '输入任务目标，或粘贴 / 拖入图片')}
            rows={5}
          />
        </div>
        <div className="composer-actions">
          <div className="composer-actions__left">
            {canPauseTask ? (
              <button data-focus-id="pause-task" className="icon-button icon-button--danger" type="button" onClick={handlePauseTask} title="立即暂停" aria-label="立即暂停当前执行">
                <CirclePause aria-hidden="true" />
              </button>
            ) : null}
            <button
              data-focus-id="voice-input"
              className={`button button--voice ${isVoicePressed ? 'button--voice-pressed' : ''}`}
              type="button"
              onClick={() => void handleVoiceInputTrigger('tap')}
              title={`语音输入 (手柄 ${GAMEPAD_BUTTON_OPTIONS.find(option => option.index === voiceConfig.gamepadButton)?.label ?? voiceConfig.gamepadButton} / 快捷键 Cmd+Shift+V)\n模拟按键: ${voiceConfig.targetKey}`}
              aria-label="触发语音输入模拟按键"
              aria-pressed={isVoicePressed}
            >
              <Mic className={`voice-icon ${isVoicePressed ? 'voice-icon--pressed' : ''}`} aria-hidden="true" />
              <span>{isVoicePressed ? '按键已按下' : '语音输入'}</span>
            </button>
            <button
              data-focus-id="screenshot-button"
              className={`button button--secondary ${screenshotBusy ? 'is-loading' : ''}`}
              type="button"
              onClick={() => void handleTriggerScreenshot()}
              disabled={screenshotBusy}
              title="截取当前 JoyDSH 页面 (快捷键 F7 / PrintScreen / Cmd+Shift+S)"
              aria-label="截取当前 JoyDSH 页面"
            >
              <Camera aria-hidden="true" />
              <span>{screenshotBusy ? '截图中...' : '截图'}</span>
            </button>
            <button
              data-focus-id="paste-image"
              className="button button--secondary"
              type="button"
              onClick={() => void handlePasteFromClipboard()}
              title="从系统剪贴板粘贴图片 (Cmd+V)"
              aria-label="从剪贴板粘贴图片"
            >
              <ClipboardPaste aria-hidden="true" />
              <span>粘贴</span>
            </button>
          </div>
          <button
            data-focus-id="send-task"
            className="button button--primary button--tv"
            type="submit"
            disabled={(taskInput.trim() === '' && pendingImages.length === 0) || sendBusy}
          >
            <Send aria-hidden="true" />
            {composingNewSession ? '开启会话' : '发送'}
          </button>
        </div>
      </form>
      {error === undefined ? null : <div className="inline-error" role="alert">{error}</div>}
    </>
  )

  return (
    <main
      className="app-shell"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {isDraggingOver ? (
        <div className="window-drop-overlay" aria-hidden="true">
          <ImageIcon aria-hidden="true" className="composer-drop-icon" />
          <span>松开即可添加图片</span>
        </div>
      ) : null}
      <header className="topbar">
        <div className="brand-lockup">
          <strong className="brand">JoyDSH</strong>
          <span>智能体工作空间</span>
        </div>

        {/* PS5 Project Bar (Top Ribbon) */}
        {workspaceCatalog.projects.length > 0 ? (
          <div className="ps5-project-bar" role="tablist" aria-label="项目列表">
            <span className="ps5-bumper-badge" title="按 L1 切换前一个项目"><kbd>L1</kbd></span>
            <div
              ref={projectTrackRef}
              className="ps5-project-track"
              onWheel={handleHorizontalWheel}
            >
              {workspaceCatalog.projects.map((project, index) => {
                const isActive = project.path === workspacePath
                const projectTasks = allTasks.filter(task => task.workspacePath === project.path)
                const projectRunning = projectTasks.some(task => task.running || projections[task.id]?.status === 'running')
                const projectResponses = projectTasks.reduce((count, task) => {
                  const taskProjection = projections[task.id]
                  return count
                    + (taskProjection?.pendingApprovals.length ?? 0)
                    + (taskProjection?.pendingQuestions.length ?? 0)
                    + (taskProjection?.pendingPlanReviews.length ?? 0)
                }, 0)
                return (
                  <button
                    key={project.path}
                    id={`project-tab-${index}`}
                    data-focus-id={`project-tab-${index}`}
                    className={`ps5-project-tab${isActive ? ' ps5-project-tab--active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => handleSelectProject(project.path)}
                    title={project.path}
                  >
                    <Folder className="ps5-project-tab__icon" aria-hidden="true" />
                    <div className="ps5-project-tab__info">
                      <strong>{project.name}</strong>
                    </div>
                    <div className="ps5-project-tab__badge">
                      {projectResponses > 0 ? (
                        <span className="ps5-pill ps5-pill--warning">
                          <ShieldAlert aria-hidden="true" />
                          {projectResponses}
                        </span>
                      ) : projectRunning ? (
                        <span className="ps5-pill ps5-pill--running">
                          <span className="ps5-pulse-dot" />
                          运行中
                        </span>
                      ) : (
                        <span className="ps5-pill ps5-pill--idle">
                          {projectTasks.length} 会话
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
              <button
                data-focus-id="project-tab-new"
                className="ps5-project-tab ps5-project-tab--new"
                type="button"
                onClick={openProjectCenter}
                title="管理工作区"
              >
                <Plus aria-hidden="true" />
                <span>管理工作区</span>
              </button>
            </div>
            <span className="ps5-bumper-badge" title="按 R1 切换后一个项目"><kbd>R1</kbd></span>
          </div>
        ) : null}

        <div className="system-actions">
          <div className={`runtime-state runtime-state--${connection}`} aria-live="polite">
            <span className="state-dot" />
            {connectionLabel(connection)}
          </div>
          <button data-focus-id="settings-toggle" className="icon-button icon-button--quiet" type="button" onClick={openSettings} title="模型设置" aria-label="打开模型设置">
            <KeyRound aria-hidden="true" />
          </button>
          {connected ? (
            <button data-focus-id="runtime-toggle" className="icon-button icon-button--quiet" type="button" onClick={handleRuntime} disabled={busy} title="停止运行时" aria-label="停止运行时">
              <Power aria-hidden="true" />
            </button>
          ) : (
            <button data-focus-id="runtime-toggle" className="icon-button icon-button--quiet" type="button" onClick={() => void reconnect()} disabled={busy} title="重新连接" aria-label="重新连接">
              <RefreshCw aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <div className={`workspace-grid${workspacePath ? ' workspace-grid--with-sidebar' : ''}${inspectorOpen ? '' : ' workspace-grid--inspector-hidden'}`}>
        {workspacePath ? (
          <aside className="sessions-sidebar" aria-label="会话列表">
            <div className="sessions-sidebar__header">
              <div className="sessions-sidebar__title">
                <Layers3 className="sessions-sidebar__icon" aria-hidden="true" />
                <span>会话</span>
                <span className="sessions-sidebar__count">{currentProjectTasks.length}</span>
              </div>
              <button
                data-focus-id="session-card-new"
                className={`icon-button icon-button--quiet sessions-sidebar__add${composingNewSession ? ' sessions-sidebar__add--active' : ''}`}
                type="button"
                onClick={() => handleNewSession()}
                disabled={busy}
                title="新建任务会话 (快捷键 △)"
                aria-label="新建任务会话"
                aria-pressed={composingNewSession}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>

            <div className="sessions-sidebar__list" role="tablist" aria-label="任务会话" data-scroll-region="sessions-sidebar">
              {currentProjectTasks.map((task, index) => {
                const isSessionActive = !composingNewSession && activeTask?.id === task.id
                const taskProj = projections[task.id]
                const taskStatus = taskProj?.status ?? (task.running ? 'running' : 'idle')
                const taskPendingCount = (taskProj?.pendingApprovals.length ?? 0)
                  + (taskProj?.pendingQuestions.length ?? 0)
                  + (taskProj?.pendingPlanReviews.length ?? 0)
                return (
                  <button
                    key={task.id}
                    id={`session-card-${index}`}
                    data-focus-id={`session-card-${index}`}
                    className={`session-card-item${isSessionActive ? ' session-card-item--active' : ''}`}
                    type="button"
                    role="tab"
                    aria-selected={isSessionActive}
                    onClick={() => handleSelectSession(task.id)}
                    title={`${task.title ?? '会话'} · ${task.id} · ${projectionStatusLabel(taskStatus)}`}
                  >
                    <span className={`ps5-status-dot ps5-status-dot--${taskStatus}`} />
                    <div className="session-card-item__content">
                      <span className="session-card-item__title">{task.title ?? shortId(task.id)}</span>
                    </div>
                    {taskPendingCount > 0 ? (
                      <em className="ps5-chip-badge">{taskPendingCount}</em>
                    ) : null}
                  </button>
                )
              })}

              {currentProjectTasks.length === 0 ? (
                <div className="sessions-sidebar__empty">
                  <span>暂无会话</span>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}

        <section className="task-panel" aria-labelledby="task-heading">
          <div className="panel-heading">
            <div className="panel-heading__title">
              <h1 id="task-heading">{activeProject?.name ?? (activeTask === undefined && !composingNewSession ? '项目' : composingNewSession ? '新会话' : '当前任务')}</h1>
              {composingNewSession
                ? <span className="session-id">尚未发送</span>
                : activeTask === undefined ? null : <span className="session-id">{activeTask.title ?? shortId(activeTask.id)}</span>}
            </div>
            <button
              data-focus-id="inspector-toggle"
              className="icon-button icon-button--quiet inspector-toggle"
              type="button"
              onClick={() => setInspectorOpen(open => !open)}
              title={inspectorOpen ? '隐藏任务检查器' : '显示任务检查器'}
              aria-label={inspectorOpen ? '隐藏任务检查器' : '显示任务检查器'}
              aria-pressed={inspectorOpen}
              aria-controls="task-inspector"
            >
              {inspectorOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
            </button>
          </div>

          <div className="task-surface">
            {activeTask === undefined && !composingNewSession ? (
              <div className="empty-state empty-state--action">
                <span className="step-label">{activeProject ? '项目工作区' : '工作空间'}</span>
                <h2>{activeProject ? `${activeProject.name} · 暂无活跃会话` : '选择一个项目'}</h2>
                <p>{activeProject ? activeProject.path : (workspaceCatalog.baseDirectory ?? '尚未设置工作区根目录')}</p>
                {activeProject ? (
                  <div className="empty-state__actions">
                    <button
                      data-focus-id="empty-new-session"
                      className="button button--primary button--tv"
                      type="button"
                      onClick={() => void handleNewSession()}
                      disabled={busy}
                    >
                      <Plus aria-hidden="true" />
                      新建会话 (△)
                    </button>
                    <button
                      data-focus-id="open-project-center"
                      className="button button--quiet button--tv"
                      type="button"
                      onClick={openProjectCenter}
                      disabled={busy}
                    >
                      <FolderKanban aria-hidden="true" />
                      管理项目
                    </button>
                  </div>
                ) : (
                  <button data-focus-id="open-project-center" className="button button--primary button--tv" type="button" onClick={openProjectCenter} disabled={busy}>
                    <FolderKanban aria-hidden="true" />
                    选择项目
                  </button>
                )}
                {error === undefined ? null : <div className="inline-error" role="alert">{error}</div>}
              </div>
            ) : composingNewSession ? (
              <div className="new-session-canvas">
                <div className="new-session-canvas__intro">
                  <span className="step-label">新会话</span>
                  <h2>开始一项新任务</h2>
                  <p>{activeProject ? `${activeProject.name} · 这条消息会开启独立会话，不会发到现有历史里。` : '这条消息会开启独立会话，不会发到现有历史里。'}</p>
                </div>
                {composerForm}
              </div>
            ) : (
              <div className={`active-task${projection !== undefined && projection.plan.length > 0 ? ' active-task--with-plan' : ''}`}>
                <div className="task-status">
                  <span className={`task-status__pulse task-status__pulse--${projection?.status ?? 'idle'}`} />
                  <div>
                    <span>任务状态</span>
                    <strong>{projectionStatusLabel(projection?.status)}</strong>
                  </div>
                  <button
                    data-focus-id="task-permission-toggle"
                    className={`permission-badge permission-badge--${activePermissionMode} permission-badge--interactive`}
                    type="button"
                    onClick={() => void handleToggleActiveSessionPermission()}
                    disabled={permissionChangeBusy}
                    title={`当前为${permissionLabel(activePermissionMode)}，点击切换为${activePermissionMode === 'full-access' ? '标准权限（敏感操作需要审批）' : '完全访问（免审批自动执行）'}`}
                  >
                    <ShieldCheck aria-hidden="true" />
                    <span>{permissionLabel(activePermissionMode)}</span>
                    <small className="permission-badge__hint">{permissionChangeBusy ? '切换中' : '点击切换'}</small>
                  </button>
                  <span className="event-count">{activityItems.length} 条动态</span>
                </div>
                {pendingQuestions.length > 0 || pendingPlanReviews.length > 0 ? (
                  <section className="task-approval-alert task-response-alert" aria-labelledby="task-response-title" role="status">
                    {pendingPlanReviews.length > 0 ? <FileCheck2 aria-hidden="true" /> : <CircleHelp aria-hidden="true" />}
                    <div>
                      <span>需要你的回应</span>
                      <strong id="task-response-title">
                        {pendingPlanReviews.length > 0
                          ? pendingPlanReviews[0]?.question ?? '审阅实施方案'
                          : pendingQuestions[0]?.questions[0]?.question ?? '补充任务信息'}
                      </strong>
                      <p>{pendingPlanReviews.length} 项方案审阅 · {pendingQuestions.length} 组问题</p>
                    </div>
                    <button
                      data-focus-id="task-response-open"
                      className="button button--primary"
                      type="button"
                      onClick={pendingPlanReviews.length > 0 ? openPlanReviewDetail : openQuestionDetail}
                    >
                      查看并回应
                    </button>
                  </section>
                ) : null}
                {pendingApprovals.length > 0 ? (
                  <section className="task-approval-alert" aria-labelledby="task-approval-title" role="status">
                    <ShieldAlert aria-hidden="true" />
                    <div>
                      <span>需要你的审批</span>
                      <strong id="task-approval-title">{pendingApprovals[0]?.toolName ?? '敏感操作'}</strong>
                      <p>{pendingApprovals[0]?.reason ?? '该操作需要你的明确许可。'}</p>
                    </div>
                    <button data-focus-id="task-approval-open" className="button button--warning" type="button" onClick={openApprovalDetail}>
                      查看并处理
                    </button>
                  </section>
                ) : null}
                {projection !== undefined && projection.plan.length > 0 ? (
                  <section className="task-plan" aria-labelledby="task-plan-heading">
                    <header>
                      <div>
                        <span>执行计划</span>
                        <strong id="task-plan-heading">{planProgressLabel(projection.plan)}</strong>
                      </div>
                      <span>{projection.plan.length} 项</span>
                    </header>
                    <ol>
                      {projection.plan.map((item, index) => (
                        <li key={`${index}:${item.content}`} className={`task-plan__item task-plan__item--${item.status}`}>
                          <span className="task-plan__icon">
                            {item.status === 'completed' ? <Check aria-hidden="true" /> : item.status === 'in_progress' ? <LoaderCircle aria-hidden="true" /> : <Circle aria-hidden="true" />}
                          </span>
                          <span>{item.content}</span>
                        </li>
                      ))}
                    </ol>
                  </section>
                ) : null}
                <div className={`output-surface${projection?.failure === undefined ? '' : ' output-surface--error'}`} ref={outputSurfaceRef} data-scroll-region="task-output" aria-live="polite">
                  {conversationMessages.length > 0 ? (
                    <div className="conversation-stream">
                      {conversationMessages.map((msg, index) => {
                        if (msg.role === 'user') {
                          return (
                            <div key={msg.id || index} className={`chat-message chat-message--user${msg.isCommand ? ' chat-message--command' : ''}`}>
                              <div className="chat-message__header">
                                <span className="chat-message__sender">
                                  <User aria-hidden="true" />
                                  <span>你</span>
                                </span>
                                {msg.time ? <time className="chat-message__time">{formatTime(msg.time)}</time> : null}
                              </div>
                              <div className="chat-bubble chat-bubble--user">
                                {msg.images && msg.images.length > 0 ? (
                                  <MessageImages
                                    images={msg.images}
                                    taskId={activeTask?.id}
                                    adapter={adapter}
                                    onPreviewImage={openImageLightbox}
                                  />
                                ) : null}
                                {msg.isCommand ? (
                                  <div className="chat-command-content">
                                    <Terminal aria-hidden="true" />
                                    <code>{msg.content}</code>
                                  </div>
                                ) : msg.content ? (
                                  <p>{msg.content}</p>
                                ) : null}
                              </div>
                            </div>
                          )
                        }

                        if (msg.role === 'assistant') {
                          const isLatest = index === conversationMessages.length - 1
                          const isStreaming = isLatest && (msg.status === 'streaming' || projection?.status === 'running')
                          const isFailed = isLatest ? (msg.status === 'failed' || projection?.status === 'failed') : msg.status === 'failed'
                          const failure = isLatest ? (msg.failure ?? projection?.failure) : msg.failure

                          return (
                            <div key={msg.id || index} className={`chat-message chat-message--assistant${isFailed ? ' chat-message--error' : ''}`}>
                              <div className="chat-message__header">
                                <span className="chat-message__sender">
                                  <Sparkles aria-hidden="true" />
                                  <span>JoyDSH</span>
                                </span>
                                {isStreaming ? (
                                  <span className="chat-message__status chat-message__status--streaming">
                                    <LoaderCircle aria-hidden="true" className="spin-icon" />
                                    <span>正在生成...</span>
                                  </span>
                                ) : isFailed ? (
                                  <span className="chat-message__status chat-message__status--error">
                                    <ShieldAlert aria-hidden="true" />
                                    <span>执行异常</span>
                                  </span>
                                ) : msg.time ? (
                                  <time className="chat-message__time">{formatTime(msg.time)}</time>
                                ) : null}
                              </div>
                              <div className="chat-bubble chat-bubble--assistant">
                                {msg.images && msg.images.length > 0 ? (
                                  <MessageImages
                                    images={msg.images}
                                    taskId={activeTask?.id}
                                    adapter={adapter}
                                    onPreviewImage={openImageLightbox}
                                  />
                                ) : null}
                                {msg.content ? (
                                  <MarkdownContent content={msg.content} onPreviewImage={openImageLightbox} />
                                ) : isStreaming ? (
                                  <div className="chat-bubble__streaming-placeholder">
                                    <LoaderCircle aria-hidden="true" className="spin-icon" />
                                    <span>正在思考并组织回复...</span>
                                  </div>
                                ) : null}
                                {failure !== undefined ? (
                                  <div className="failure-message failure-message--inline">
                                    <span>{failure.code ?? 'RUNTIME_ERROR'}</span>
                                    <h2>{failureTitle(failure.code)}</h2>
                                    <p>{failureDescription(failure.code, failure.message)}</p>
                                    {failure.code === 'MISSING_CREDENTIAL' ? (
                                      <button data-focus-id="failure-model-settings" className="button failure-action" type="button" onClick={openSettings}>
                                        <KeyRound aria-hidden="true" />
                                        配置模型
                                      </button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          )
                        }

                        // Fallback / System message
                        return (
                          <div key={msg.id || index} className="chat-message chat-message--system">
                            <span className="chat-system-tag">
                              <Terminal aria-hidden="true" />
                              <span>{msg.content}</span>
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  ) : projection?.failure !== undefined ? (
                    <div className="failure-message">
                      <span>{projection.failure.code ?? 'RUNTIME_ERROR'}</span>
                      <h2>{failureTitle(projection.failure.code)}</h2>
                      <p>{failureDescription(projection.failure.code, projection.failure.message)}</p>
                      {projection.failure.code === 'MISSING_CREDENTIAL' ? (
                        <button data-focus-id="failure-model-settings" className="button failure-action" type="button" onClick={openSettings}>
                          <KeyRound aria-hidden="true" />
                          配置模型
                        </button>
                      ) : null}
                    </div>
                  ) : projection?.output ? (
                    <div className="conversation-stream">
                      <div className="chat-message chat-message--assistant">
                        <div className="chat-message__header">
                          <span className="chat-message__sender">
                            <Sparkles aria-hidden="true" />
                            <span>JoyDSH</span>
                          </span>
                          {projection.status === 'running' ? (
                            <span className="chat-message__status chat-message__status--streaming">
                              <LoaderCircle aria-hidden="true" className="spin-icon" />
                              <span>正在生成...</span>
                            </span>
                          ) : null}
                        </div>
                        <div className="chat-bubble chat-bubble--assistant">
                          <MarkdownContent content={projection.output} onPreviewImage={openImageLightbox} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="output-placeholder">
                      {projection?.status === 'running'
                        ? '正在生成回复...'
                        : projection?.status === 'waiting-approval'
                          ? '正在等待你处理审批'
                          : projection?.status === 'waiting-response'
                            ? '正在等待你回应问题或审阅方案'
                          : '发送任务后，回复会显示在这里'}
                    </div>
                  )}
                </div>
                {composerForm}
              </div>
            )}
          </div>
        </section>

        {inspectorOpen ? (
          <TaskInspector
            page={inspectorPage}
            onPageChange={handleInspectorPageChange}
            events={events}
            snapshot={artifactSnapshot}
            loading={artifactsLoading}
            selectedChangeId={selectedArtifactChangeId}
            mutationBusy={artifactMutationBusy}
            {...(artifactMutationError === undefined ? {} : { mutationError: artifactMutationError })}
            canReview={canReviewArtifacts}
            onSelectChange={handleSelectArtifactChange}
            onAcceptChange={handleAcceptArtifactChange}
            onRequestRejectChange={requestRejectArtifactChange}
            onEstablishBaseline={handleEstablishBaseline}
          />
        ) : null}
      </div>

      <footer className="ps5-footer-hud">
        <div className="ps5-hud-hints">
          <span className="ps5-hud-item"><kbd>L1</kbd><kbd>R1</kbd> 切换项目</span>
          <span className="ps5-hud-item"><kbd>L2</kbd><kbd>R2</kbd> 检查器分页</span>
          <span className="ps5-hud-item"><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 空间导航</span>
          <span className="ps5-hud-item"><kbd className="glyph-cross">✕</kbd> 确认</span>
          <span className="ps5-hud-item"><kbd className="glyph-circle">◯</kbd> 返回</span>
          <span className="ps5-hud-item"><kbd className="glyph-triangle">△</kbd> 新建会话</span>
          <span className="ps5-hud-item"><kbd>Options</kbd> 命令中心</span>
          <span className="ps5-hud-item"><kbd>R-Stick</kbd> 滚动浏览</span>
        </div>
        <div className="ps5-hud-meta">
          <span>DSH {DSH_VERSION}</span>
          <span>{activeTask?.workspacePath ?? workspacePath}</span>
        </div>
      </footer>

      {commandCenterOpen ? (
        <div className="command-overlay" role="presentation" onMouseDown={event => {
          if (event.currentTarget !== event.target) return
          if (artifactCommitFlow?.phase === 'confirming') {
            cancelArtifactCommitConfirmation()
          } else {
            closeCommandCenter()
          }
        }}>
          <section className={selectedApproval === undefined && selectedPendingResponse === undefined && !permissionConfirmationOpen && artifactConfirmation === undefined && artifactCommitFlow === undefined && !archiveViewOpen ? 'command-sheet' : 'command-sheet command-sheet--approval'} role="dialog" aria-modal="true" aria-labelledby="command-title">
            {archiveViewOpen ? (
              <>
                <header className="command-header approval-header">
                  <button data-focus-id="archive-back" className="icon-button icon-button--quiet" type="button" onClick={() => setArchiveViewOpen(false)} title="返回命令中心" aria-label="返回命令中心">
                    <ArrowLeft aria-hidden="true" />
                  </button>
                  <div>
                    <span className="step-label">任务管理</span>
                    <h2 id="command-title">已归档任务</h2>
                  </div>
                  <span className="command-runtime">{archivedTaskList.length} 项</span>
                </header>
                <div className="command-list archive-list" data-scroll-region="archives">
                  {archivedTaskList.length === 0 ? (
                    <div className="archive-empty">暂无已归档任务</div>
                  ) : archivedTaskList.map((task, index) => (
                    <button key={task.id} data-focus-id={`archive-restore-${index}`} className="command-item" type="button" onClick={() => handleRestoreArchivedTask(task)}>
                      <ArchiveRestore aria-hidden="true" />
                      <span><strong>{task.title ?? shortId(task.id)}</strong><small>{task.workspacePath ?? task.id}</small></span>
                    </button>
                  ))}
                </div>
              </>
            ) : permissionConfirmationOpen ? (
              <>
                <header className="command-header permission-confirmation__header">
                  <ShieldAlert aria-hidden="true" />
                  <div>
                    <span className="step-label">会话权限</span>
                    <h2 id="command-title">启用完全访问</h2>
                  </div>
                </header>
                <div className="permission-confirmation__body">
                  <strong>当前任务将不再逐项请求审批</strong>
                  <p>智能体会继承当前系统用户的文件、网络和命令执行权限，也不会额外拦截破坏性操作。仅在你信任当前任务时启用。</p>
                  {permissionChangeError === undefined ? null : <div className="inline-error" role="alert">{permissionChangeError}</div>}
                </div>
                <div className="approval-actions">
                  <button data-focus-id="permission-cancel" className="button button--tv" type="button" disabled={permissionChangeBusy} onClick={closePermissionConfirmation}>
                    取消
                  </button>
                  <button data-focus-id="permission-confirm" className="button button--warning button--tv" type="button" disabled={permissionChangeBusy} onClick={() => void applyActiveSessionPermission('full-access')}>
                    <ShieldAlert aria-hidden="true" />
                    {permissionChangeBusy ? '正在切换' : '启用完全访问'}
                  </button>
                </div>
              </>
            ) : artifactConfirmation !== undefined ? (
              <>
                <header className="command-header artifact-confirmation__header">
                  <div>
                    <span className="step-label">成果操作</span>
                    <h2 id="command-title">
                      {artifactConfirmation.kind === 'reject-file' ? '拒绝文件变更' : '回滚任务成果'}
                    </h2>
                  </div>
                  <RotateCcw aria-hidden="true" />
                </header>
                <div className="artifact-confirmation__body">
                  <strong>
                    {artifactConfirmation.kind === 'reject-file'
                      ? artifactConfirmation.path
                      : `${artifactSnapshot?.changes.length ?? 0} 个文件变更`}
                  </strong>
                  <p>
                    {artifactConfirmation.kind === 'reject-file'
                      ? '当前文件会恢复到任务开始时的内容；任务创建的新文件会被移除。'
                      : '当前任务产生的所有文件变更都会恢复到任务开始边界。'}
                  </p>
                  {artifactMutationError === undefined ? null : <div className="inline-error" role="alert">{artifactMutationError}</div>}
                </div>
                <div className="approval-actions">
                  <button data-focus-id="artifact-cancel" className="button button--tv" type="button" disabled={artifactMutationBusy} onClick={closeArtifactConfirmation}>
                    <X aria-hidden="true" />
                    取消
                  </button>
                  <button data-focus-id="artifact-confirm" className="button button--danger button--tv" type="button" disabled={artifactMutationBusy} onClick={confirmArtifactMutation}>
                    <RotateCcw aria-hidden="true" />
                    {artifactMutationBusy ? '正在处理' : '确认恢复'}
                  </button>
                </div>
              </>
            ) : artifactCommitFlow !== undefined ? (
              <ArtifactCommitPanel
                flow={artifactCommitFlow}
                canRetry={canCommitArtifacts}
                onBack={closeArtifactCommitFlow}
                onRetry={beginArtifactCommitProposal}
                onMessageChange={updateArtifactCommitMessage}
                onContinue={requestArtifactCommitConfirmation}
                onCancelConfirmation={cancelArtifactCommitConfirmation}
                onConfirm={confirmArtifactCommit}
                onDone={closeCommandCenter}
              />
            ) : selectedQuestionRequest !== undefined && selectedQuestion !== undefined && selectedQuestionDraft !== undefined ? (
              <>
                <header className="command-header approval-header response-header">
                  <button data-focus-id="question-back" className="icon-button icon-button--quiet" type="button" disabled={responseBusy} onClick={closePendingResponseDetail} title="返回命令中心" aria-label="返回命令中心">
                    <ArrowLeft aria-hidden="true" />
                  </button>
                  <div>
                    <span className="step-label">待回答问题</span>
                    <h2 id="command-title">{selectedQuestion.header ?? '需要补充信息'}</h2>
                  </div>
                  <span className="response-progress">{questionIndex + 1} / {selectedQuestionRequest.questions.length}</span>
                </header>
                <div className="question-response-body" data-scroll-region="question-response">
                  <section className="question-copy" aria-labelledby="question-prompt">
                    <h3 id="question-prompt">{selectedQuestion.question}</h3>
                    {selectedQuestion.detail === undefined ? null : <p>{selectedQuestion.detail}</p>}
                  </section>
                  {selectedQuestion.options === undefined || selectedQuestion.options.length === 0 ? null : (
                    <div className="question-options" role={selectedQuestion.multiSelect === true ? 'group' : 'radiogroup'} aria-label="可选回答">
                      {selectedQuestion.options.map((option, index) => {
                        const selected = selectedQuestionDraft.selected.includes(option.label)
                        return (
                          <button
                            key={option.label}
                            data-focus-id={`question-option-${index}`}
                            className={`question-option${selected ? ' question-option--selected' : ''}`}
                            type="button"
                            role={selectedQuestion.multiSelect === true ? 'checkbox' : 'radio'}
                            aria-checked={selected}
                            disabled={responseBusy}
                            onClick={() => updateSelectedQuestionOption(option.label)}
                          >
                            <span className="question-option__mark">{selected ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}</span>
                            <span><strong>{option.label}</strong>{option.description === undefined ? null : <small>{option.description}</small>}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <label className="question-custom" htmlFor="question-custom">
                    <span>其他回答</span>
                    <textarea
                      data-focus-id="question-custom"
                      id="question-custom"
                      rows={3}
                      value={selectedQuestionDraft.custom}
                      disabled={responseBusy}
                      onChange={event => updateSelectedQuestionCustom(event.target.value)}
                      placeholder="输入补充信息"
                    />
                  </label>
                  {responseError === undefined ? null : <div className="inline-error" role="alert">{responseError}</div>}
                </div>
                <div className="response-actions">
                  <button data-focus-id="question-cancel" className="button button--danger button--tv" type="button" disabled={responseBusy} onClick={cancelPendingResponse}>
                    <X aria-hidden="true" />
                    放弃整组问题
                  </button>
                  {questionIndex > 0 ? (
                    <button data-focus-id="question-previous" className="button button--tv" type="button" disabled={responseBusy} onClick={() => setQuestionIndex(current => Math.max(0, current - 1))}>
                      <ChevronLeft aria-hidden="true" />
                      上一题
                    </button>
                  ) : null}
                  <button data-focus-id="question-skip" className="button button--tv" type="button" disabled={responseBusy} onClick={() => advanceQuestion(true)}>
                    跳过
                  </button>
                  <button
                    data-focus-id={questionIndex < selectedQuestionRequest.questions.length - 1 ? 'question-next' : 'question-submit'}
                    className="button button--primary button--tv"
                    type="button"
                    disabled={responseBusy || !selectedQuestionAnswered}
                    onClick={() => advanceQuestion(false)}
                  >
                    {questionIndex < selectedQuestionRequest.questions.length - 1 ? <ChevronRight aria-hidden="true" /> : <Send aria-hidden="true" />}
                    {responseBusy ? '正在提交' : questionIndex < selectedQuestionRequest.questions.length - 1 ? '下一题' : '提交回答'}
                  </button>
                </div>
              </>
            ) : selectedPlanReview !== undefined ? (
              <>
                <header className="command-header approval-header response-header response-header--plan">
                  <button data-focus-id="plan-review-back" className="icon-button icon-button--quiet" type="button" disabled={responseBusy} onClick={closePendingResponseDetail} title="返回命令中心" aria-label="返回命令中心">
                    <ArrowLeft aria-hidden="true" />
                  </button>
                  <div>
                    <span className="step-label">方案审阅</span>
                    <h2 id="command-title">{selectedPlanReview.question}</h2>
                  </div>
                  <FileCheck2 aria-hidden="true" />
                </header>
                <div className="plan-review-body" data-scroll-region="plan-review">
                  <MarkdownContent content={selectedPlanReview.plan} onPreviewImage={openImageLightbox} />
                  {responseError === undefined ? null : <div className="inline-error" role="alert">{responseError}</div>}
                </div>
                <div className="response-actions response-actions--plan">
                  <button data-focus-id="plan-review-discuss" className="button button--tv" type="button" disabled={responseBusy} onClick={cancelPendingResponse}>
                    继续讨论
                  </button>
                  {selectedPlanReview.decline === undefined ? null : (
                    <button data-focus-id="plan-review-decline" className="button button--danger button--tv" type="button" disabled={responseBusy} onClick={() => decidePlanReview(selectedPlanReview.decline?.label ?? '')} title={selectedPlanReview.decline.description}>
                      <X aria-hidden="true" />
                      {selectedPlanReview.decline.label}
                    </button>
                  )}
                  <button data-focus-id="plan-review-approve" className="button button--primary button--tv" type="button" disabled={responseBusy} onClick={() => decidePlanReview(selectedPlanReview.approve.label)} title={selectedPlanReview.approve.description}>
                    <Check aria-hidden="true" />
                    {responseBusy ? '正在提交' : selectedPlanReview.approve.label}
                  </button>
                </div>
              </>
            ) : selectedApproval === undefined ? (
              <>
                <header className="command-header">
                  <div>
                    <span className="step-label">快捷操作</span>
                    <h2 id="command-title">命令中心</h2>
                  </div>
                  <div className="command-header__meta">
                    <span className={`permission-badge permission-badge--${activePermissionMode}`}>
                      <ShieldCheck aria-hidden="true" />
                      {permissionLabel(activePermissionMode)}
                    </span>
                    <span className={`command-runtime command-runtime--${connection}`}>{connectionLabel(connection)}</span>
                  </div>
                </header>
                <div className="command-list" data-scroll-region="command-center">
                  <button data-focus-id="command-current-task" className="command-item" type="button" onClick={closeCommandCenter}>
                    <ArrowLeft aria-hidden="true" />
                    <span><strong>返回当前任务</strong><small>{activeTask === undefined ? '返回工作空间' : shortId(activeTask.id)}</small></span>
                  </button>
                  {allPendingApprovals.length > 0 ? (
                    <button data-focus-id="command-approvals" className="command-item command-item--warning" type="button" onClick={openApprovalDetail}>
                      <ShieldAlert aria-hidden="true" />
                      <span>
                        <strong>待审批 {allPendingApprovals.length} 项</strong>
                        <small>{approvalSummary(allPendingApprovals[0]?.item)}</small>
                      </span>
                    </button>
                  ) : null}
                  {allPendingQuestions.length > 0 ? (
                    <button data-focus-id="command-questions" className="command-item command-item--response" type="button" onClick={openQuestionDetail}>
                      <CircleHelp aria-hidden="true" />
                      <span>
                        <strong>待回答问题 {allPendingQuestions.length} 组</strong>
                        <small>{allPendingQuestions[0]?.item.questions[0]?.question ?? '运行时正在等待补充信息'}</small>
                      </span>
                    </button>
                  ) : null}
                  {allPendingPlanReviews.length > 0 ? (
                    <button data-focus-id="command-plan-reviews" className="command-item command-item--review" type="button" onClick={openPlanReviewDetail}>
                      <FileCheck2 aria-hidden="true" />
                      <span>
                        <strong>待审阅方案 {allPendingPlanReviews.length} 项</strong>
                        <small>{allPendingPlanReviews[0]?.item.question ?? '实施前需要你的决定'}</small>
                      </span>
                    </button>
                  ) : null}
                  <button data-focus-id="command-projects" className="command-item" type="button" onClick={openProjectCenter}>
                    <FolderKanban aria-hidden="true" />
                    <span><strong>选择项目</strong><small>{workspaceCatalog.baseDirectory ?? '设置工作区根目录'}</small></span>
                  </button>
                  {activeTask === undefined ? null : (
                    <button
                      data-focus-id="command-toggle-permission"
                      className="command-item"
                      type="button"
                      disabled={permissionChangeBusy}
                      onClick={handleToggleActiveSessionPermission}
                    >
                      <ShieldCheck aria-hidden="true" />
                      <span>
                        <strong>切换会话权限（当前：{permissionLabel(activePermissionMode)}）</strong>
                        <small>{activePermissionMode === 'full-access' ? '点击切为标准权限（敏感工具操作需审批）' : '点击切为完全访问（自动执行全部工具不弹审批）'}</small>
                      </span>
                    </button>
                  )}
                  {activeTask === undefined ? null : (
                    <button data-focus-id="command-archive-task" className="command-item" type="button" disabled={activeTask.running || canPauseTask} onClick={handleArchiveTask}>
                      <Archive aria-hidden="true" />
                      <span><strong>归档当前任务</strong><small>{activeTask.running || canPauseTask ? '请先暂停任务' : '从工作区隐藏，可随时恢复'}</small></span>
                    </button>
                  )}
                  <button data-focus-id="command-archives" className="command-item" type="button" onClick={() => setArchiveViewOpen(true)}>
                    <ArchiveRestore aria-hidden="true" />
                    <span><strong>已归档任务</strong><small>{archivedTaskList.length} 项，可恢复到原工作空间</small></span>
                  </button>
                  {canPauseTask ? (
                    <button
                      data-focus-id="command-pause-task"
                      className="command-item command-item--warning"
                      type="button"
                      onClick={() => {
                        closeCommandCenter()
                        handlePauseTask()
                      }}
                    >
                      <CirclePause aria-hidden="true" />
                      <span><strong>立即暂停</strong><small>中断当前执行，下次发送继续会话</small></span>
                    </button>
                  ) : null}
                  {hasAcceptedArtifacts ? (
                    <button
                      data-focus-id="command-commit-artifacts"
                      className="command-item"
                      type="button"
                      disabled={!canCommitArtifacts}
                      onClick={beginArtifactCommitProposal}
                    >
                      <GitCommitHorizontal aria-hidden="true" />
                      <span>
                        <strong>提交成果</strong>
                        <small>{acceptedArtifactCount} 个已接受文件</small>
                      </span>
                    </button>
                  ) : null}
                  {canRollbackArtifacts ? (
                    <button data-focus-id="command-rollback-artifacts" className="command-item command-item--danger" type="button" onClick={requestRollbackTaskArtifacts}>
                      <RotateCcw aria-hidden="true" />
                      <span>
                        <strong>回滚任务成果</strong>
                        <small>{artifactSnapshot?.changes.length ?? 0} 个文件变更</small>
                      </span>
                    </button>
                  ) : null}
                  <button data-focus-id="command-fullscreen" className="command-item" type="button" onClick={handleToggleFullscreen}>
                    {isFullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
                    <span>
                      <strong>{isFullscreen ? '退出全屏' : '进入全屏'}</strong>
                      <small>{isFullscreen ? '恢复窗口显示' : '全屏显示工作空间'}</small>
                    </span>
                  </button>
                  <button data-focus-id="command-model-settings" className="command-item" type="button" onClick={openSettingsFromCommand}>
                    <KeyRound aria-hidden="true" />
                    <span><strong>模型设置</strong><small>{PROVIDERS[selectedProvider].name} · {selectedProvider === 'openai' ? selectedModel : PROVIDERS[selectedProvider].defaultModel}</small></span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <header className="command-header approval-header">
                  <button data-focus-id="approval-back" className="icon-button icon-button--quiet" type="button" onClick={closeApprovalDetail} title="返回命令中心" aria-label="返回命令中心">
                    <ArrowLeft aria-hidden="true" />
                  </button>
                  <div>
                    <span className="step-label">待处理审批</span>
                    <h2 id="command-title">审批详情</h2>
                  </div>
                  <span className={`permission-badge permission-badge--${activePermissionMode}`}>
                    <ShieldCheck aria-hidden="true" />
                    {permissionLabel(activePermissionMode)}
                  </span>
                </header>
                <div className="approval-body" data-scroll-region="approval">
                  <dl className="approval-facts">
                    <div><dt>工具</dt><dd>{selectedApproval.toolName}</dd></div>
                    <div><dt>原因</dt><dd>{selectedApproval.reason ?? '该操作需要你的明确许可。'}</dd></div>
                    <div><dt>任务</dt><dd>{activeTask === undefined ? '未知任务' : shortId(activeTask.id)}</dd></div>
                    <div><dt>权限</dt><dd>{permissionDescription(activePermissionMode)}</dd></div>
                  </dl>
                  {selectedApprovalEvidence?.command === undefined ? null : (
                    <section className="approval-command" aria-labelledby="approval-command-label">
                      <span id="approval-command-label">命令</span>
                      <code>{selectedApprovalEvidence.command}</code>
                    </section>
                  )}
                  <section className="approval-arguments" aria-labelledby="approval-arguments-label">
                    <span id="approval-arguments-label">完整参数</span>
                    <pre tabIndex={0}><code>{selectedApprovalEvidence?.arguments ?? '未提供可关联的工具调用参数。'}</code></pre>
                  </section>
                  {approvalError === undefined ? null : <div className="inline-error" role="alert">{approvalError}</div>}
                </div>
                <div className="approval-actions">
                  <button data-focus-id="approval-reject" className="button button--danger button--tv" type="button" disabled={approvalRespondingId !== undefined} onClick={() => respondToSelectedApproval('rejected')}>
                    <X aria-hidden="true" />
                    {approvalRespondingId === selectedApproval.approvalId ? '正在处理' : '拒绝'}
                  </button>
                  <button data-focus-id="approval-allow" className="button button--primary button--tv" type="button" disabled={approvalRespondingId !== undefined} onClick={() => respondToSelectedApproval('allowed-once')}>
                    <Check aria-hidden="true" />
                    {approvalRespondingId === selectedApproval.approvalId ? '正在处理' : '允许一次'}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {projectCenterOpen ? (
        <ProjectCenter
          activePath={workspacePath}
          busy={projectBusy}
          catalog={workspaceCatalog}
          {...(projectError === undefined ? {} : { error: projectError })}
          permissionMode={projectPermissionMode}
          projectName={projectName}
          onChangePermissionMode={setProjectPermissionMode}
          onChangeProjectName={setProjectName}
          onChangeProjectPermission={handleChangeWorkspaceProjectPermission}
          onChooseBase={handleChooseWorkspaceBase}
          onClose={closeProjectCenter}
          onCreate={handleCreateWorkspaceProject}
          onOpenFolder={handleOpenWorkspaceFolder}
          onSelect={handleSelectWorkspaceProject}
        />
      ) : null}

      {settingsOpen ? (
        <div className="settings-overlay" role="presentation" onMouseDown={event => {
          if (event.currentTarget === event.target) closeSettings()
        }}>
          <section className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-header">
              <div>
                <span className="step-label">模型连接</span>
                <h2 id="settings-title">模型设置</h2>
              </div>
              <button data-focus-id="settings-close" className="icon-button icon-button--quiet" type="button" onClick={closeSettings} title="关闭" aria-label="关闭模型设置">
                <X aria-hidden="true" />
              </button>
            </header>

            <div className="settings-body" data-scroll-region="settings">
              <div className="provider-segment" role="group" aria-label="模型提供方">
                {(Object.keys(PROVIDERS) as ModelProvider[]).map(id => (
                  <button
                    key={id}
                    data-focus-id={`provider-${id}`}
                    type="button"
                    className={selectedProvider === id ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
                    aria-pressed={selectedProvider === id}
                    onClick={() => {
                      setSelectedProvider(id)
                      setApiKeyDraft('')
                      setShowApiKey(false)
                      setSettingsError(undefined)
                      setSettingsMessage(undefined)
                    }}
                  >
                    {PROVIDERS[id].name}
                  </button>
                ))}
              </div>

              {settingsBusy && credentialStatus === undefined ? (
                <p className="settings-loading">正在读取配置状态...</p>
              ) : credentialStatus !== undefined ? (
                <form className="credential-form" onSubmit={event => { event.preventDefault(); handleApplyModel() }}>
                  <div className={credentialStatus.configured ? 'credential-state credential-state--ready' : 'credential-state'}>
                    <span className="state-dot" />
                    <div>
                      <strong>{credentialStatus.source === 'env' ? '已由启动环境配置' : credentialStatus.configured ? '凭据已保存' : '尚未配置凭据'}</strong>
                      <p>
                        {credentialStatus.source === 'env'
                          ? `JoyDSH 已检测到 ${provider.credentialRef}，密钥不会显示在界面中。`
                          : `凭据只会写入 DSH 的 ${provider.credentialRef} 存储，保存后不会回显。`}
                      </p>
                    </div>
                  </div>

                  {credentialStatus.writable ? (
                    <>
                      <label htmlFor="api-key">{provider.name} API Key</label>
                      <div className="secret-entry">
                        <input
                          data-focus-id="api-key"
                          id="api-key"
                          type={showApiKey ? 'text' : 'password'}
                          value={apiKeyDraft}
                          onChange={event => {
                            setApiKeyDraft(event.target.value)
                            setSettingsError(undefined)
                          }}
                          placeholder={credentialStatus.configured ? '留空以保留现有 Key' : `输入 ${provider.name} API Key`}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button data-focus-id="api-key-visibility" className="icon-button icon-button--quiet" type="button" onClick={() => setShowApiKey(value => !value)} title={showApiKey ? '隐藏 API Key' : '显示 API Key'} aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}>
                          {showApiKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                        </button>
                      </div>
                    </>
                  ) : null}

                  <div className="model-field">
                    <label htmlFor="base-url">Base URL</label>
                    <input
                      data-focus-id="base-url"
                      id="base-url"
                      value={baseUrlDraft}
                      onChange={event => {
                        setBaseUrlDrafts(current => ({
                          ...current,
                          [selectedProvider]: event.target.value,
                        }))
                        setSettingsError(undefined)
                      }}
                      placeholder="留空使用官方地址"
                      inputMode="url"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p>可填写兼容服务或代理地址；清空后恢复默认地址。</p>
                  </div>

                  {selectedProvider === 'openai' ? (
                    <div className="model-field">
                      <label htmlFor="codex-model">Codex 模型</label>
                      <input
                        data-focus-id="codex-model"
                        id="codex-model"
                        value={selectedModel}
                        onChange={event => {
                          setSelectedModel(event.target.value)
                          setSettingsError(undefined)
                        }}
                        placeholder="例如 gpt-5.6-sol"
                        autoCapitalize="none"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p>使用 OpenAI Platform API 计费，不消耗 ChatGPT 套餐额度。</p>
                    </div>
                  ) : null}

                  <button data-focus-id="settings-save" className="button button--primary button--tv settings-save" type="submit" disabled={settingsBusy || !canApplyModel}>
                    <KeyRound aria-hidden="true" />
                    保存并使用
                  </button>
                </form>
              ) : null}

              <div className="settings-section">
                <div className="settings-section__header">
                  <span className="step-label">外设与输入法</span>
                  <h3>语音输入与按键映射</h3>
                  <p>指定手柄触发键，并通过底层按键模拟联动 Spokenly、Superwhisper 或系统听写。</p>
                </div>
                {voiceCapabilities?.permissionRequired === true ? (
                  voiceCapabilities.permissionGranted === true ? (
                    <div className="voice-permission-state voice-permission-state--granted" role="status">
                      <ShieldCheck aria-hidden="true" />
                      <span>macOS 辅助功能权限已授权。</span>
                    </div>
                  ) : (
                    <div className="voice-permission-state voice-permission-state--denied" role="alert">
                      <ShieldAlert aria-hidden="true" />
                      <div>
                        <strong>需要辅助功能权限</strong>
                        <p>请在“系统设置 &gt; 隐私与安全性 &gt; 辅助功能”中允许 JoyDSH，然后返回此窗口。</p>
                      </div>
                      <button
                        data-focus-id="voice-input-permission"
                        type="button"
                        className="button button--secondary"
                        disabled={voicePermissionBusy}
                        onClick={async () => {
                          setVoicePermissionBusy(true)
                          setVoiceTestStatus(undefined)
                          try {
                            const capabilities = await requestKeySimulationPermission()
                            setVoiceCapabilities(capabilities)
                            setVoiceTestStatus(capabilities.permissionGranted === true
                              ? '辅助功能权限已授权'
                              : '请在系统设置中打开 JoyDSH 的辅助功能权限')
                          } catch (err) {
                            setVoiceTestStatus(`权限申请失败：${errorMessage(err)}`)
                          } finally {
                            setVoicePermissionBusy(false)
                          }
                        }}
                      >
                        <ShieldCheck aria-hidden="true" />
                        {voicePermissionBusy ? '等待系统授权…' : '授权辅助功能'}
                      </button>
                    </div>
                  )
                ) : null}
                <div className="model-field">
                  <label htmlFor="voice-input-gamepad-button">手柄触发键</label>
                  <select
                    data-focus-id="voice-input-gamepad-button"
                    id="voice-input-gamepad-button"
                    value={voiceConfig.gamepadButton}
                    onChange={event => {
                      const next = { ...voiceConfig, gamepadButton: Number(event.target.value) as VoiceInputGamepadButton }
                      setVoiceConfig(next)
                      saveVoiceInputConfig(next)
                      setVoiceTestStatus(undefined)
                    }}
                  >
                    {GAMEPAD_BUTTON_OPTIONS.map(option => (
                      <option key={option.index} value={option.index}>{option.label}</option>
                    ))}
                  </select>
                  {voiceGamepadConflict === undefined ? null : (
                    <p className="input-mapping-warning" role="status">
                      语音输入将替代该键原有的“{voiceGamepadConflict}”动作。
                    </p>
                  )}
                </div>
                <div className="model-field">
                  <label htmlFor="voice-input-key">听写软件触发键</label>
                  <select
                    data-focus-id="voice-input-key"
                    id="voice-input-key"
                    value={voiceConfig.targetKey}
                    onChange={event => {
                      const next = { ...voiceConfig, targetKey: event.target.value as VoiceInputTargetKey }
                      setVoiceConfig(next)
                      saveVoiceInputConfig(next)
                      setVoiceTestStatus(undefined)
                    }}
                  >
                    {TARGET_KEY_OPTIONS.map(opt => (
                      <option key={opt.key} value={opt.key}>{opt.label} — {opt.description}</option>
                    ))}
                  </select>
                </div>
                <div className="voice-test-actions">
                  <button
                    data-focus-id="voice-input-test"
                    type="button"
                    className="button button--secondary"
                    disabled={voiceCapabilities?.permissionRequired === true && voiceCapabilities.permissionGranted !== true}
                    onClick={async () => {
                      try {
                        await simulateKeyAction(voiceConfig.targetKey, 'tap', voiceConfig.customKeyCode)
                        setVoiceTestStatus(`已发送模拟按键：${voiceConfig.targetKey}`)
                      } catch (err) {
                        setVoiceTestStatus(`模拟失败：${errorMessage(err)}`)
                      }
                    }}
                  >
                    <Mic aria-hidden="true" />
                    测试模拟按键
                  </button>
                  {voiceTestStatus !== undefined ? (
                    <span className="voice-test-status">{voiceTestStatus}</span>
                  ) : null}
                </div>
              </div>

              {settingsError === undefined ? null : <div className="inline-error" role="alert">{settingsError}</div>}
              {settingsMessage === undefined ? null : <div className="inline-success" role="status">{settingsMessage}</div>}
            </div>
          </section>
        </div>
      ) : null}
      {gamepadSelect === null ? null : (
        <GamepadSelectOverlay
          session={gamepadSelect}
          onChoose={chooseGamepadSelectOption}
          onClose={closeGamepadSelect}
        />
      )}
      <ImageLightbox
        image={lightboxImage}
        onClose={closeImageLightbox}
      />
    </main>
  )
}

interface ArtifactCommitPanelProps {
  flow: ArtifactCommitFlow
  canRetry: boolean
  onBack(): void
  onRetry(): void
  onMessageChange(message: string): void
  onContinue(): void
  onCancelConfirmation(): void
  onConfirm(): void
  onDone(): void
}

function ArtifactCommitPanel({
  flow,
  canRetry,
  onBack,
  onRetry,
  onMessageChange,
  onContinue,
  onCancelConfirmation,
  onConfirm,
  onDone,
}: ArtifactCommitPanelProps) {
  if (flow.phase === 'generating') {
    return (
      <>
        <CommitBackHeader title="生成提交说明" onBack={onBack} />
        <div className="commit-body commit-body--center" data-scroll-region="commit">
          <div className="commit-progress" role="status">
            <LoaderCircle aria-hidden="true" />
            <strong>正在生成提交说明</strong>
            <p>将汇总 {flow.acceptedCount} 个已接受文件</p>
          </div>
        </div>
      </>
    )
  }

  if (flow.phase === 'editing') {
    return (
      <>
        <CommitBackHeader title="提交成果" onBack={onBack} />
        <div className="commit-body" data-scroll-region="commit">
          <div className="commit-editor">
            <label htmlFor="commit-message">提交说明</label>
            <textarea
              data-focus-id="commit-message"
              id="commit-message"
              value={flow.message}
              maxLength={2000}
              onChange={event => onMessageChange(event.target.value)}
              onKeyDown={event => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  if (flow.message.trim() !== '') onContinue()
                }
              }}
            />
          </div>
          <p className="commit-selection">已选择 {flow.acceptedCount} 个已接受文件</p>
        </div>
        <div className="approval-actions approval-actions--single">
          <button
            data-focus-id="commit-continue"
            className="button button--primary button--tv"
            type="button"
            disabled={flow.message.trim() === ''}
            onClick={onContinue}
          >
            <Check aria-hidden="true" />
            继续
          </button>
        </div>
      </>
    )
  }

  if (flow.phase === 'confirming') {
    return (
      <>
        <header className="command-header artifact-confirmation__header">
          <div>
            <span className="step-label">危险操作</span>
            <h2 id="command-title">确认提交成果</h2>
          </div>
          <ShieldAlert aria-hidden="true" />
        </header>
        <div className="commit-body commit-confirmation" data-scroll-region="commit">
          <strong>{flow.acceptedCount} 个已接受文件</strong>
          <p>提交会前进当前 Git 分支；未接受的文件不会进入本次提交。</p>
          <blockquote>{flow.message}</blockquote>
        </div>
        <div className="approval-actions">
          <button data-focus-id="commit-cancel" className="button button--tv" type="button" onClick={onCancelConfirmation}>
            <X aria-hidden="true" />
            取消
          </button>
          <button data-focus-id="commit-confirm" className="button button--danger button--tv" type="button" onClick={onConfirm}>
            <GitCommitHorizontal aria-hidden="true" />
            确认提交
          </button>
        </div>
      </>
    )
  }

  if (flow.phase === 'committing') {
    return (
      <>
        <header className="command-header">
          <div>
            <span className="step-label">成果提交</span>
            <h2 id="command-title">正在提交</h2>
          </div>
        </header>
        <div className="commit-body commit-body--center" data-scroll-region="commit">
          <div data-focus-id="commit-status" className="commit-progress" role="status" tabIndex={0}>
            <LoaderCircle aria-hidden="true" />
            <strong>正在写入当前分支</strong>
            <p>{flow.acceptedCount} 个文件</p>
          </div>
        </div>
      </>
    )
  }

  if (flow.phase === 'failed') {
    return (
      <>
        <CommitBackHeader title="提交未完成" onBack={onBack} />
        <div className="commit-body commit-body--center" data-scroll-region="commit">
          <div className="inline-error" role="alert">{flow.message}</div>
        </div>
        {canRetry ? (
          <div className="approval-actions approval-actions--single">
            <button data-focus-id="commit-retry" className="button button--primary button--tv" type="button" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              重新生成
            </button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <>
      <header className="command-header artifact-commit-complete__header">
        <div>
          <span className="step-label">成果提交</span>
          <h2 id="command-title">提交完成</h2>
        </div>
        <Check aria-hidden="true" />
      </header>
      <div className="commit-body commit-body--center" data-scroll-region="commit">
        <div className="commit-complete" role="status">
          <strong>已提交 {flow.acceptedCount} 个文件</strong>
          <code>{flow.revision}</code>
          {flow.warning === undefined ? null : <p>{flow.warning}</p>}
        </div>
      </div>
      <div className="approval-actions approval-actions--single">
        <button data-focus-id="commit-done" className="button button--primary button--tv" type="button" onClick={onDone}>
          <Check aria-hidden="true" />
          完成
        </button>
      </div>
    </>
  )
}

function CommitBackHeader({ title, onBack }: { title: string; onBack(): void }) {
  return (
    <header className="command-header commit-back-header">
      <button data-focus-id="commit-back" className="icon-button icon-button--quiet" type="button" onClick={onBack} title="返回命令中心" aria-label="返回命令中心">
        <ArrowLeft aria-hidden="true" />
      </button>
      <div>
        <span className="step-label">成果提交</span>
        <h2 id="command-title">{title}</h2>
      </div>
    </header>
  )
}

export function selectArtifactChangeAfterMutation(
  currentChangeId: string | undefined,
  previousChanges: readonly TaskFileChange[],
  nextChanges: readonly TaskFileChange[],
  removedChangeId?: string,
): string | undefined {
  if (currentChangeId !== undefined && nextChanges.some(change => change.changeId === currentChangeId)) {
    return currentChangeId
  }
  const removedIndex = removedChangeId === undefined
    ? -1
    : previousChanges.findIndex(change => change.changeId === removedChangeId)
  if (removedIndex >= 0) {
    return nextChanges[removedIndex]?.changeId ?? nextChanges[removedIndex - 1]?.changeId
  }
  return nextChanges[0]?.changeId
}

function connectionLabel(state: RuntimeConnectionState): string {
  if (state === 'connected') return '运行时已连接'
  if (state === 'connecting') return '正在连接运行时'
  if (state === 'error') return '运行时错误'
  return '运行时未连接'
}

function projectionStatusLabel(status?: TaskProjection['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'waiting-approval') return '等待审批'
  if (status === 'waiting-response') return '等待回应'
  if (status === 'paused') return '已暂停'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'blocked') return '需要处理'
  if (status === 'max-tokens') return '输出已截断'
  if (status === 'interrupted') return '已中断'
  if (status === 'failed') return '失败'
  return '等待输入'
}

export function resolveWorkspaceProjectPermission(
  projects: readonly WorkspaceProject[],
  workspacePath: string,
  fallback: TaskPermissionMode = 'standard',
): TaskPermissionMode {
  const project = projects.find(p => p.path === workspacePath)
  return project?.permissionMode ?? fallback
}

export function permissionLabel(mode: TaskPermissionMode): string {
  return mode === 'full-access' ? '完全访问' : '标准权限'
}

export function permissionDescription(mode: TaskPermissionMode): string {
  return mode === 'full-access'
    ? '完全访问，不再逐项审批'
    : '标准权限，本次操作需要审批'
}

function isEditableVoiceInputTarget(target: Element | null): boolean {
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly
  if (target instanceof HTMLInputElement) {
    return !target.disabled && !target.readOnly && !NON_TEXT_INPUT_TYPES.has(target.type)
  }
  return target instanceof HTMLElement && target.isContentEditable
}

function approvalSummary(approval?: TaskApproval): string {
  if (approval === undefined) return '没有待处理审批'
  return approval.reason === undefined
    ? approval.toolName
    : `${approval.toolName} · ${approval.reason}`
}

function planProgressLabel(plan: TaskProjection['plan']): string {
  let completed = 0
  let active = 0
  for (const item of plan) {
    if (item.status === 'completed') completed += 1
    if (item.status === 'in_progress') active += 1
  }
  if (completed === plan.length) return '全部完成'
  if (active > 0) return `${completed} / ${plan.length} 已完成`
  return `${plan.length - completed} 项待执行`
}

function eventKindLabel(kind: TaskEvent['kind']): string {
  if (kind === 'session') return '会话'
  if (kind === 'host') return '宿主'
  if (kind === 'error') return '错误'
  return '控制'
}

function eventSummary(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    if ('text' in data && typeof data.text === 'string') return data.text
    if ('message' in data && typeof data.message === 'string') return data.message
    if ('chunk' in data && typeof data.chunk === 'object' && data.chunk !== null) {
      if ('text' in data.chunk && typeof data.chunk.text === 'string') return data.chunk.text
      if ('reason' in data.chunk) return eventSummary(data.chunk.reason)
    }
    if ('failure' in data) return eventSummary(data.failure)
    if ('error' in data) return eventSummary(data.error)
  }
  try {
    const text = JSON.stringify(data)
    return text.length > 180 ? `${text.slice(0, 180)}...` : text
  } catch {
    return String(data)
  }
}

function failureTitle(code?: string): string {
  return code === 'MISSING_CREDENTIAL' ? '模型尚未连接' : '本次任务未能完成'
}

function failureDescription(code: string | undefined, message: string): string {
  if (code === 'MISSING_CREDENTIAL') {
    return '运行时已收到任务，但 deepseek-official 尚未配置 API Key。打开模型设置完成配置后即可重试。'
  }
  return message
}

function validateApiKey(value: string): string | undefined {
  if (value === '') return '请输入 API Key'
  if (!/^[\x21-\x7E]+$/.test(value)) return 'API Key 只能包含不带空格的可打印字符'
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return '请只输入 API Key 的值，不要包含变量名和等号'
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return '请去掉 API Key 两端的引号'
  }
  return undefined
}

function validateBaseUrl(value: string): string | undefined {
  if (value === '') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Base URL 格式不正确'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Base URL 仅支持 http 或 https'
  if (url.username !== '' || url.password !== '') return 'Base URL 不能包含用户名或密码'
  return undefined
}

function validateModelId(value: string): string | undefined {
  if (value === '') return '请输入 Codex 模型 ID'
  if (!/^[\x21-\x7E]+$/.test(value)) return '模型 ID 不能包含空格或不可见字符'
  return undefined
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

export function sessionTitleFromProjectionEvent(event: TaskEvent): string | undefined {
  if (event.type !== 'session/projection' || typeof event.data !== 'object' || event.data === null) return undefined
  const projection = event.data as { key?: unknown, value?: unknown }
  return projection.key === 'title' && typeof projection.value === 'string' && projection.value.trim() !== ''
    ? projection.value
    : undefined
}

export function cycleProjectIndex(currentIndex: number, totalCount: number, direction: 'previous' | 'next'): number {
  if (totalCount <= 1) return 0
  if (direction === 'previous') {
    return currentIndex <= 0 ? totalCount - 1 : currentIndex - 1
  }
  return currentIndex < 0 || currentIndex >= totalCount - 1 ? 0 : currentIndex + 1
}

export function resolveDisplayedTask<T extends { id: string }>(
  tasks: readonly T[],
  activeTaskId: string | undefined,
  composingNewSession: boolean,
): T | undefined {
  if (composingNewSession) return undefined
  return tasks.find(task => task.id === activeTaskId) ?? tasks[0]
}

export function resolveReconnectionTask(
  listed: readonly TaskSession[],
  workspacePath: string,
): TaskSession | undefined {
  if (workspacePath === '') {
    return listed[0]
  }
  return listed.find(t => t.workspacePath === workspacePath)
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-5)}` : value
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message === 'Failed to fetch' ? '无法连接本地 DSH 运行时' : message
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
