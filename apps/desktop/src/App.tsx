import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RuntimeConnectionState,
  TaskArtifactBaseline,
  TaskArtifactSnapshot,
  TaskApproval,
  TaskApprovalOutcome,
  TaskEvent,
  TaskFileChange,
  TaskPermissionMode,
  TaskSession,
} from '@joydsh/domain'
import type { CredentialStatus, ModelSelection } from '@joydsh/dsh-adapter'
import {
  createTaskProjection,
  projectTaskEvent,
  synchronizeTaskRunning,
  type TaskProjection,
} from '@joydsh/task-projection'
import {
  ArrowLeft,
  Check,
  Circle,
  CirclePause,
  Eye,
  EyeOff,
  Folder,
  FolderKanban,
  GitCommitHorizontal,
  KeyRound,
  LoaderCircle,
  Maximize,
  Mic,
  Minimize,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  loadVoiceInputConfig,
  saveVoiceInputConfig,
  simulateKeyAction,
  TARGET_KEY_OPTIONS,
  type VoiceInputConfig,
  type VoiceInputMode,
  type VoiceInputTargetKey,
} from './voice-input-service.ts'
import { createRuntimeAdapter } from './dsh-transport.ts'
import { createAppFocusGraph } from './app-focus.ts'
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
} from './workspace-service.ts'
import { aggregateActivityItems, TaskInspector, type InspectorPage } from './TaskInspector.tsx'
import { MarkdownContent } from './MarkdownContent.tsx'

const DSH_VERSION = '0.1.1-rc.2'
const MAX_VISIBLE_EVENTS = 2000
const EMPTY_APPROVALS: readonly TaskApproval[] = []
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
  const [projections, setProjections] = useState<Record<string, TaskProjection>>({})
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>()
  const [inspectorPage, setInspectorPage] = useState<InspectorPage>('activity')
  const [artifactBaseline, setArtifactBaseline] = useState<TaskArtifactBaseline | undefined>()
  const [artifactSnapshot, setArtifactSnapshot] = useState<TaskArtifactSnapshot | undefined>()
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [selectedArtifactChangeId, setSelectedArtifactChangeId] = useState<string | undefined>()
  const [artifactMutationBusy, setArtifactMutationBusy] = useState(false)
  const [artifactMutationError, setArtifactMutationError] = useState<string | undefined>()
  const [artifactConfirmation, setArtifactConfirmation] = useState<ArtifactConfirmation | undefined>()
  const [artifactCommitFlow, setArtifactCommitFlow] = useState<ArtifactCommitFlow | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [commandCenterOpen, setCommandCenterOpen] = useState(false)
  const [projectCenterOpen, setProjectCenterOpen] = useState(false)
  const [workspaceCatalog, setWorkspaceCatalog] = useState<WorkspaceCatalog>({ projects: [] })
  const [projectName, setProjectName] = useState('')
  const [projectPermissionMode, setProjectPermissionMode] = useState<WorkspacePermissionMode>('standard')
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState<string | undefined>()
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | undefined>()
  const [approvalRespondingId, setApprovalRespondingId] = useState<string | undefined>()
  const [approvalError, setApprovalError] = useState<string | undefined>()
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
  const [isVoiceActive, setIsVoiceActive] = useState(false)
  const [voiceTestStatus, setVoiceTestStatus] = useState<string | undefined>()
  const settingsReturnFocusRef = useRef('settings-toggle')
  const commandReturnFocusRef = useRef('settings-toggle')
  const projectReturnFocusRef = useRef('settings-toggle')
  const approvalReturnFocusRef = useRef('command-approvals')
  const approvalAttemptRef = useRef(0)
  const artifactAttemptRef = useRef(0)
  const commitAttemptRef = useRef(0)
  const previousArtifactStatusRef = useRef<TaskProjection['status'] | undefined>(undefined)
  const outputSurfaceRef = useRef<HTMLDivElement>(null)

  const projects = workspaceCatalog.projects
  const activeProject = projects.find(project => project.path === workspacePath)
  const activeProjectIndex = projects.findIndex(project => project.path === workspacePath)
  const currentProjectTasks = useMemo(() => {
    return allTasks.filter(t => t.workspacePath === workspacePath || (!t.workspacePath && !workspacePath))
  }, [allTasks, workspacePath])
  const activeTask = useMemo(() => {
    return currentProjectTasks.find(t => t.id === activeTaskId)
      ?? currentProjectTasks[0]
      ?? allTasks.find(t => t.id === activeTaskId)
      ?? allTasks[0]
  }, [activeTaskId, allTasks, currentProjectTasks])
  const activeSessionIndex = activeTask ? currentProjectTasks.findIndex(t => t.id === activeTask.id) : 0
  const projection = activeTask ? (projections[activeTask.id] ?? createTaskProjection(activeTask.id)) : undefined

  const pendingApprovals = projection?.pendingApprovals ?? EMPTY_APPROVALS
  const selectedApproval = selectedApprovalId === undefined
    ? undefined
    : pendingApprovals.find(approval => approval.approvalId === selectedApprovalId)
  const activePermissionMode = projection?.permissionMode ?? projectPermissionMode
  const selectedArtifactChange = artifactSnapshot?.changes.find(change => change.changeId === selectedArtifactChangeId)
  const artifactExecutionActive = projection?.status === 'running' || projection?.status === 'waiting-approval'
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
        if (running === undefined) return current
        return current.map(t => t.id === taskId ? { ...t, running } : t)
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
      const snapshot = await inspectTaskArtifacts(task.id, path)
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
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    setActiveTaskId(task.id)
    if (task.workspacePath) {
      setWorkspacePath(task.workspacePath)
    }
    setArtifactBaseline(undefined)
    setArtifactSnapshot(undefined)
    setSelectedArtifactChangeId(undefined)
    const history = await adapter.replayTask(task.id)
    const restored = synchronizeTaskRunning(
      history.reduce(projectTaskEvent, createTaskProjection(task.id)),
      task.running,
    )
    const finalProj = { ...restored, events: restored.events.slice(-MAX_VISIBLE_EVENTS) }
    setProjections(current => ({ ...current, [task.id]: finalProj }))
    await loadTaskArtifacts(task, false)
    return finalProj
  }, [adapter, loadTaskArtifacts])

  const reconnect = useCallback(async (reportError = true): Promise<boolean> => {
    setError(undefined)
    setConnection('connecting')
    try {
      const [, listed] = await Promise.all([adapter.healthCheck(), adapter.listTasks()])
      setConnection('connected')
      setAllTasks(listed)
      const current = listed.find(t => t.workspacePath === workspacePath) ?? listed[0]
      if (current !== undefined) await restoreTask(current)
      return true
    } catch (cause) {
      setConnection('disconnected')
      setError(reportError ? errorMessage(cause) : undefined)
      return false
    }
  }, [adapter, restoreTask, workspacePath])

  useEffect(() => {
    const unsubscribe = adapter.subscribe({
      onEvent: appendEvent,
      onConnectionChange: setConnection,
    })
    void reconnect(false)
    return unsubscribe
  }, [adapter, appendEvent, reconnect])

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
    if (outputSurfaceRef.current) {
      outputSurfaceRef.current.scrollTop = outputSurfaceRef.current.scrollHeight
    }
  }, [projection?.output, projection?.status])

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
  }, [adapter])

  const openSettings = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      settingsReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'settings-toggle'
    }
    loadSettings()
  }, [loadSettings])

  const closeCommandCenter = useCallback(() => {
    if (artifactMutationBusy || artifactCommitFlow?.phase === 'committing') return
    approvalAttemptRef.current += 1
    commitAttemptRef.current += 1
    setCommandCenterOpen(false)
    setSelectedApprovalId(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    setArtifactConfirmation(undefined)
    setArtifactCommitFlow(undefined)
    setArtifactMutationError(undefined)
    restoreManagedFocus(commandReturnFocusRef.current)
  }, [artifactCommitFlow?.phase, artifactMutationBusy])

  const closeApprovalDetail = useCallback(() => {
    approvalAttemptRef.current += 1
    setSelectedApprovalId(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    restoreManagedFocus(pendingApprovals.length > 0 ? approvalReturnFocusRef.current : 'command-current-task')
  }, [pendingApprovals.length])

  const openApprovalDetail = useCallback(() => {
    const approval = pendingApprovals[0]
    if (approval === undefined) return
    if (document.activeElement instanceof HTMLElement) {
      approvalReturnFocusRef.current = document.activeElement.dataset.focusId ?? 'command-approvals'
    }
    setApprovalError(undefined)
    setArtifactConfirmation(undefined)
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    setArtifactMutationError(undefined)
    setSelectedApprovalId(approval.approvalId)
  }, [pendingApprovals])

  const respondToSelectedApproval = useCallback((outcome: TaskApprovalOutcome) => {
    if (activeTask === undefined || selectedApproval === undefined || approvalRespondingId !== undefined) return
    const attempt = approvalAttemptRef.current + 1
    approvalAttemptRef.current = attempt
    setApprovalError(undefined)
    setApprovalRespondingId(selectedApproval.approvalId)
    void adapter.respondToApproval(activeTask.id, selectedApproval, outcome)
      .catch(cause => {
        if (approvalAttemptRef.current !== attempt) return
        setApprovalRespondingId(undefined)
        setApprovalError(errorMessage(cause))
      })
  }, [activeTask, adapter, approvalRespondingId, selectedApproval])

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
    if (selectedApprovalId === undefined || selectedApproval !== undefined) return
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    const nextApproval = pendingApprovals[0]
    if (nextApproval !== undefined) {
      setSelectedApprovalId(nextApproval.approvalId)
      restoreManagedFocus('approval-reject')
      return
    }
    setSelectedApprovalId(undefined)
    restoreManagedFocus(commandCenterOpen ? 'command-current-task' : commandReturnFocusRef.current)
  }, [commandCenterOpen, pendingApprovals, selectedApproval, selectedApprovalId])

  const openSettingsFromCommand = useCallback(() => {
    approvalAttemptRef.current += 1
    settingsReturnFocusRef.current = commandReturnFocusRef.current
    setCommandCenterOpen(false)
    setSelectedApprovalId(undefined)
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
    setCommandCenterOpen(false)
    setSelectedApprovalId(undefined)
    setApprovalRespondingId(undefined)
    setApprovalError(undefined)
    commitAttemptRef.current += 1
    setArtifactCommitFlow(undefined)
    setProjectPermissionMode(projection?.permissionMode ?? 'standard')
    setProjectCenterOpen(true)
    setProjectError(undefined)
    void loadWorkspaceCatalog()
  }, [commandCenterOpen, loadWorkspaceCatalog, projection?.permissionMode])

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

  const activateWorkspace = useCallback(async (path: string, permissionMode: TaskPermissionMode) => {
    setWorkspacePath(path)
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
    const tasks = await adapter.listTasks()
    setAllTasks(tasks)
    const existing = tasks.find(task => task.workspacePath === path)
    let task: TaskSession
    if (existing !== undefined) {
      await restoreTask(existing)
      task = existing
    } else {
      task = await adapter.createTask({ workspacePath: path })
      setAllTasks(current => [...current.filter(t => t.id !== task.id), task])
      setActiveTaskId(task.id)
      setProjections(current => ({ ...current, [task.id]: createTaskProjection(task.id) }))
      setArtifactBaseline(undefined)
      setArtifactSnapshot(undefined)
      setSelectedArtifactChangeId(undefined)
      await loadTaskArtifacts(task, true)
    }
    await adapter.setTaskPermission(task.id, permissionMode)
    setProjectCenterOpen(false)
    setProjectName('')
    restoreManagedFocus('task-input')
  }, [adapter, loadTaskArtifacts, restoreTask])

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

  const handleSelectProject = useCallback((path: string) => {
    setWorkspacePath(path)
    const projectTasks = allTasks.filter(t => t.workspacePath === path)
    if (projectTasks.length > 0) {
      const first = projectTasks[0]
      if (first !== undefined) void restoreTask(first)
    } else {
      const proj = workspaceCatalog.projects.find(p => p.path === path)
      const mode = proj?.permissionMode ?? projectPermissionMode
      void activateWorkspace(path, mode)
    }
  }, [activateWorkspace, allTasks, projectPermissionMode, restoreTask, workspaceCatalog.projects])

  const handlePreviousProject = useCallback(() => {
    const projectList = workspaceCatalog.projects
    if (projectList.length <= 1) return
    const currentIndex = projectList.findIndex(p => p.path === workspacePath)
    const prevIndex = currentIndex <= 0 ? projectList.length - 1 : currentIndex - 1
    const target = projectList[prevIndex]
    if (target !== undefined) handleSelectProject(target.path)
  }, [handleSelectProject, workspaceCatalog.projects, workspacePath])

  const handleNextProject = useCallback(() => {
    const projectList = workspaceCatalog.projects
    if (projectList.length <= 1) return
    const currentIndex = projectList.findIndex(p => p.path === workspacePath)
    const nextIndex = currentIndex < 0 || currentIndex >= projectList.length - 1 ? 0 : currentIndex + 1
    const target = projectList[nextIndex]
    if (target !== undefined) handleSelectProject(target.path)
  }, [handleSelectProject, workspaceCatalog.projects, workspacePath])

  const handleSelectSession = useCallback((taskId: string) => {
    const task = allTasks.find(t => t.id === taskId)
    if (task !== undefined) {
      void restoreTask(task)
    }
  }, [allTasks, restoreTask])

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

  const handleNewSession = useCallback(async () => {
    if (workspacePath.trim() === '') {
      openProjectCenter()
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      if (connection !== 'connected') {
        const proj = workspaceCatalog.projects.find(p => p.path === workspacePath)
        const mode = proj?.permissionMode ?? activePermissionMode
        await activateWorkspace(workspacePath, mode)
        return
      }
      const task = await adapter.createTask({ workspacePath: workspacePath.trim() })
      setAllTasks(current => [task, ...current])
      setActiveTaskId(task.id)
      const newProj = createTaskProjection(task.id)
      setProjections(current => ({ ...current, [task.id]: newProj }))
      setArtifactBaseline(undefined)
      setArtifactSnapshot(undefined)
      setSelectedArtifactChangeId(undefined)
      await loadTaskArtifacts(task, true)
      await adapter.setTaskPermission(task.id, activePermissionMode)
      restoreManagedFocus('task-input')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }, [activateWorkspace, activePermissionMode, adapter, connection, loadTaskArtifacts, openProjectCenter, workspaceCatalog.projects, workspacePath])

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

  const handleSend = () => void run(async () => {
    if (activeTask === undefined) throw new Error('请先创建任务会话')
    const text = taskInput.trim()
    if (text === '') return
    const taskId = activeTask.id
    setProjections(current => {
      const existing = current[taskId] ?? createTaskProjection(taskId)
      const { failure: _failure, ...clean } = existing
      return {
        ...current,
        [taskId]: {
          ...clean,
          status: 'running',
          output: '',
        },
      }
    })
    setAllTasks(current => current.map(t => t.id === taskId ? { ...t, running: true } : t))
    await adapter.sendInput(taskId, text)
    setTaskInput('')
  })

  const handleVoiceInputTrigger = useCallback(async (action: 'tap' | 'press' | 'release' = 'tap') => {
    if (!voiceConfig.enabled) return

    const active = document.activeElement
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      focusManagedElement('task-input')
    }

    if (voiceConfig.mode === 'toggle') {
      if (action === 'release') return
      const nextState = !isVoiceActive
      setIsVoiceActive(nextState)
      try {
        await simulateKeyAction(voiceConfig.targetKey, 'tap', voiceConfig.customKeyCode)
      } catch (err) {
        console.error('模拟按键失败', err)
      }
    } else {
      if (action === 'press') {
        setIsVoiceActive(true)
        try {
          await simulateKeyAction(voiceConfig.targetKey, 'press', voiceConfig.customKeyCode)
        } catch (err) {
          console.error('模拟按键按下失败', err)
        }
      } else if (action === 'release') {
        setIsVoiceActive(false)
        try {
          await simulateKeyAction(voiceConfig.targetKey, 'release', voiceConfig.customKeyCode)
        } catch (err) {
          console.error('模拟按键释放失败', err)
        }
      }
    }
  }, [voiceConfig, isVoiceActive])

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
    setSelectedApprovalId(undefined)
    setArtifactMutationError(undefined)
    setArtifactConfirmation({ kind: 'reject-file', changeId, path: change.path, returnTo: 'inspector' })
    setCommandCenterOpen(true)
  }, [artifactSnapshot, canReviewArtifacts])

  const requestRollbackTaskArtifacts = useCallback(() => {
    if (!canRollbackArtifacts) return
    setSelectedApprovalId(undefined)
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
    setSelectedApprovalId(undefined)
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
    const executionStopped = previous === 'running' || previous === 'waiting-approval'
    const workspaceStable = current !== 'running' && current !== 'waiting-approval'
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
  const canPauseTask = (projection?.status === 'running' || projection?.status === 'waiting-approval') && !busy
  const focusGraph = useMemo(() => createAppFocusGraph({
    connected,
    hasActiveTask: activeTask !== undefined,
    hasFailureAction: projection?.failure?.code === 'MISSING_CREDENTIAL',
    busy,
    canPauseTask,
    canSend: taskInput.trim() !== '' && !busy,
    settingsOpen,
    commandCenterOpen,
    approvalDetailOpen: selectedApproval !== undefined,
    artifactConfirmationOpen: artifactConfirmation !== undefined,
    ...(artifactCommitFlow === undefined ? {} : { commitPhase: artifactCommitFlow.phase }),
    approvalResponding: approvalRespondingId !== undefined,
    pendingApprovalCount: pendingApprovals.length,
    projectCenterOpen,
    projectPermissionMode,
    projectCount: workspaceCatalog.projects.length,
    activeProjectIndex: activeProjectIndex >= 0 ? activeProjectIndex : 0,
    sessionCount: currentProjectTasks.length,
    activeSessionIndex: activeSessionIndex >= 0 ? activeSessionIndex : 0,
    hasWorkspaceBase: workspaceCatalog.baseDirectory !== undefined,
    canCreateProject: projectName.trim() !== '' && !projectBusy,
    selectedProvider,
    settingsReady: credentialStatus !== undefined,
    credentialWritable: credentialStatus?.writable === true,
    canSaveSettings: canApplyModel && !settingsBusy,
    inspectorPage,
    artifactChangeIds: artifactSnapshot?.changes.map(change => change.changeId) ?? [],
    ...(selectedArtifactChangeId === undefined ? {} : { selectedArtifactChangeId }),
    selectedArtifactAccepted: selectedArtifactChange?.review === 'accepted',
    canReviewArtifacts,
    canRollbackArtifacts,
    canCommitArtifacts,
    canContinueCommit: artifactCommitFlow?.phase === 'editing' && artifactCommitFlow.message.trim() !== '',
  }), [activeProjectIndex, activeSessionIndex, activeTask, approvalRespondingId, artifactCommitFlow, artifactConfirmation, artifactSnapshot?.changes, busy, canApplyModel, canCommitArtifacts, canPauseTask, canReviewArtifacts, canRollbackArtifacts, commandCenterOpen, connected, credentialStatus, currentProjectTasks.length, inspectorPage, pendingApprovals.length, projectBusy, projectCenterOpen, projectName, projectPermissionMode, projection?.failure?.code, selectedApproval, selectedArtifactChange?.review, selectedArtifactChangeId, selectedProvider, settingsBusy, settingsOpen, taskInput, workspaceCatalog])

  useSemanticNavigation({
    graph: focusGraph,
    onCommandCenter: toggleCommandCenter,
    onPauseTask: handlePauseTask,
    onVoiceInput: handleVoiceInputTrigger,
    onPreviousProject: handlePreviousProject,
    onNextProject: handleNextProject,
    onPreviousSession: handlePreviousSession,
    onNextSession: handleNextSession,
    onNewSession: handleNewSession,
    onNewProject: handleNewProject,
    ...(!settingsOpen && !projectCenterOpen && !commandCenterOpen && inspectorPage === 'changes' && selectedArtifactChangeId !== undefined
      ? {
          onPrimaryAction: () => handleAcceptArtifactChange(selectedArtifactChangeId),
          onMoreActions: () => requestRejectArtifactChange(selectedArtifactChangeId),
        }
      : !settingsOpen && !projectCenterOpen && !commandCenterOpen
        ? {
            onPrimaryAction: handleNewProject,
            onMoreActions: () => void handleNewSession(),
          }
        : {}),
    ...(!settingsOpen && !projectCenterOpen && !commandCenterOpen && activeTask !== undefined
      ? {
          onPreviousPage: () => moveInspectorPage(-1),
          onNextPage: () => moveInspectorPage(1),
        }
      : {}),
    ...(projectCenterOpen
      ? { onBack: closeProjectCenter }
      : commandCenterOpen && artifactConfirmation !== undefined
        ? { onBack: closeArtifactConfirmation }
      : commandCenterOpen && artifactCommitFlow !== undefined
        ? artifactCommitFlow.phase === 'confirming'
          ? { onBack: cancelArtifactCommitConfirmation }
          : artifactCommitFlow.phase === 'committing'
            ? {}
            : { onBack: closeArtifactCommitFlow }
      : commandCenterOpen && selectedApproval !== undefined
        ? { onBack: closeApprovalDetail }
        : commandCenterOpen
          ? { onBack: closeCommandCenter }
        : settingsOpen ? { onBack: closeSettings } : {}),
  })

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <strong className="brand">JoyDSH</strong>
          <span>智能体工作空间</span>
        </div>

        {/* PS5 Project Bar (Top Ribbon) */}
        {workspaceCatalog.projects.length > 0 ? (
          <div className="ps5-project-bar" role="tablist" aria-label="项目列表">
            <span className="ps5-bumper-badge" title="按 L1 切换前一个项目"><kbd>L1</kbd></span>
            <div className="ps5-project-track">
              {workspaceCatalog.projects.map((project, index) => {
                const isActive = project.path === workspacePath
                const pTasks = allTasks.filter(t => t.workspacePath === project.path)
                const pRunning = pTasks.some(t => t.running || projections[t.id]?.status === 'running')
                const pApprovals = pTasks.reduce((acc, t) => acc + (projections[t.id]?.pendingApprovals.length ?? 0), 0)
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
                  >
                    <Folder className="ps5-project-tab__icon" aria-hidden="true" />
                    <div className="ps5-project-tab__info">
                      <strong>{project.name}</strong>
                    </div>
                    <div className="ps5-project-tab__badge">
                      {pApprovals > 0 ? (
                        <span className="ps5-pill ps5-pill--warning">
                          <ShieldAlert aria-hidden="true" />
                          {pApprovals}
                        </span>
                      ) : pRunning ? (
                        <span className="ps5-pill ps5-pill--running">
                          <span className="ps5-pulse-dot" />
                          执行中
                        </span>
                      ) : (
                        <span className="ps5-pill ps5-pill--idle">
                          {pTasks.length} 会话
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
                title="选择或新建项目"
              >
                <Plus aria-hidden="true" />
                <span>新建项目</span>
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

      <div className="workspace-grid">
        <section className="task-panel" aria-labelledby="task-heading">
          <div className="panel-heading">
            <div className="panel-heading__title">
              <h1 id="task-heading">{activeProject?.name ?? (activeTask === undefined ? '项目' : '当前任务')}</h1>
              {activeTask === undefined ? null : <span className="session-id">{shortId(activeTask.id)}</span>}
            </div>

            {/* PS5 Session Activity Strip */}
            {workspacePath ? (
              <div className="ps5-session-quickbar" role="tablist" aria-label="任务会话">
                {currentProjectTasks.map((task, index) => {
                  const isSessionActive = activeTask?.id === task.id
                  const taskProj = projections[task.id]
                  const taskStatus = taskProj?.status ?? (task.running ? 'running' : 'idle')
                  return (
                    <button
                      key={task.id}
                      id={`session-card-${index}`}
                      data-focus-id={`session-card-${index}`}
                      className={`ps5-session-chip${isSessionActive ? ' ps5-session-chip--active' : ''}`}
                      type="button"
                      role="tab"
                      aria-selected={isSessionActive}
                      onClick={() => handleSelectSession(task.id)}
                      title={`会话 ${shortId(task.id)} · ${projectionStatusLabel(taskStatus)}`}
                    >
                      <span className={`ps5-status-dot ps5-status-dot--${taskStatus}`} />
                      <span>{shortId(task.id)}</span>
                      {taskProj && taskProj.pendingApprovals.length > 0 ? (
                        <em className="ps5-chip-badge">{taskProj.pendingApprovals.length}</em>
                      ) : null}
                    </button>
                  )
                })}
                <button
                  data-focus-id="session-card-new"
                  className="ps5-session-chip ps5-session-chip--new"
                  type="button"
                  onClick={() => void handleNewSession()}
                  disabled={busy}
                  title="新建任务会话 (快捷键 △)"
                >
                  <Plus aria-hidden="true" />
                  <span>新建会话</span>
                  <kbd className="glyph-triangle">△</kbd>
                </button>
              </div>
            ) : null}
          </div>

          <div className="task-surface">
            {activeTask === undefined ? (
              <div className="empty-state empty-state--action">
                <span className="step-label">工作空间</span>
                <h2>选择一个项目</h2>
                <p>{workspaceCatalog.baseDirectory ?? '尚未设置工作区根目录'}</p>
                <button data-focus-id="open-project-center" className="button button--primary button--tv" type="button" onClick={openProjectCenter} disabled={busy}>
                  <FolderKanban aria-hidden="true" />
                  选择项目
                </button>
                {error === undefined ? null : <div className="inline-error" role="alert">{error}</div>}
              </div>
            ) : (
              <div className={`active-task${projection !== undefined && projection.plan.length > 0 ? ' active-task--with-plan' : ''}`}>
                <div className="task-status">
                  <span className={`task-status__pulse task-status__pulse--${projection?.status ?? 'idle'}`} />
                  <div>
                    <span>任务状态</span>
                    <strong>{projectionStatusLabel(projection?.status)}</strong>
                  </div>
                  <span className={`permission-badge permission-badge--${activePermissionMode}`}>
                    <ShieldCheck aria-hidden="true" />
                    {permissionLabel(activePermissionMode)}
                  </span>
                  <span className="event-count">{activityItems.length} 条动态</span>
                </div>
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
                  {projection?.failure !== undefined ? (
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
                    <div className="assistant-output">
                      <span>JoyDSH{projection.status === 'running' ? ' · 正在生成...' : ''}</span>
                      <MarkdownContent content={projection.output} />
                    </div>
                  ) : (
                    <div className="output-placeholder">
                      {projection?.status === 'running'
                        ? '正在生成回复...'
                        : projection?.status === 'waiting-approval'
                          ? '正在等待你处理审批'
                          : '发送任务后，回复会显示在这里'}
                    </div>
                  )}
                </div>
                <form className="composer" onSubmit={(event) => { event.preventDefault(); handleSend() }}>
                  <label htmlFor="task-input">告诉 JoyDSH 要完成什么</label>
                  <textarea
                    data-focus-id="task-input"
                    id="task-input"
                    value={taskInput}
                    onChange={event => setTaskInput(event.target.value)}
                    onKeyDown={event => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault()
                        if (taskInput.trim() !== '' && !busy) handleSend()
                      }
                    }}
                    placeholder="输入任务目标或继续说明"
                    rows={5}
                  />
                  <div className="composer-actions">
                    <div className="composer-actions__left">
                      {canPauseTask ? (
                        <button data-focus-id="pause-task" className="icon-button icon-button--danger" type="button" onClick={handlePauseTask} title="立即暂停" aria-label="立即暂停当前执行">
                          <CirclePause aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        data-focus-id="voice-input"
                        className={`button button--voice ${isVoiceActive ? 'button--voice-active' : ''}`}
                        type="button"
                        onClick={() => void handleVoiceInputTrigger('tap')}
                        title={`语音输入 (手柄 Select 键 / 快捷键 Cmd+Shift+V)\n模拟按键: ${voiceConfig.targetKey}`}
                        aria-label="触发语音输入模拟按键"
                      >
                        <Mic className={`voice-icon ${isVoiceActive ? 'voice-icon--active' : ''}`} aria-hidden="true" />
                        <span>{isVoiceActive ? '正在听写...' : '语音输入'}</span>
                      </button>
                    </div>
                    <button data-focus-id="send-task" className="button button--primary button--tv" type="submit" disabled={taskInput.trim() === '' || busy}>
                      <Send aria-hidden="true" />
                      发送
                    </button>
                  </div>
                </form>
                {error === undefined ? null : <div className="inline-error" role="alert">{error}</div>}
              </div>
            )}
          </div>
        </section>

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
        />
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
          <section className={selectedApproval === undefined && artifactConfirmation === undefined && artifactCommitFlow === undefined ? 'command-sheet' : 'command-sheet command-sheet--approval'} role="dialog" aria-modal="true" aria-labelledby="command-title">
            {artifactConfirmation !== undefined ? (
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
                  {pendingApprovals.length > 0 ? (
                    <button data-focus-id="command-approvals" className="command-item command-item--warning" type="button" onClick={openApprovalDetail}>
                      <ShieldAlert aria-hidden="true" />
                      <span>
                        <strong>待审批 {pendingApprovals.length} 项</strong>
                        <small>{approvalSummary(pendingApprovals[0])}</small>
                      </span>
                    </button>
                  ) : null}
                  <button data-focus-id="command-projects" className="command-item" type="button" onClick={openProjectCenter}>
                    <FolderKanban aria-hidden="true" />
                    <span><strong>选择项目</strong><small>{workspaceCatalog.baseDirectory ?? '设置工作区根目录'}</small></span>
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
                  <h3>语音输入与按键模拟</h3>
                  <p>通过底层模拟按键联动 Spokenly、Superwhisper 或系统听写。手柄 Back/Select 键或键盘 Cmd+Shift+V / F5 可直接唤起。</p>
                </div>
                <div className="model-field">
                  <label htmlFor="voice-input-key">触发按键 (Target Key)</label>
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
                <div className="model-field">
                  <label htmlFor="voice-input-mode">触发模式 (Trigger Mode)</label>
                  <select
                    data-focus-id="voice-input-mode"
                    id="voice-input-mode"
                    value={voiceConfig.mode}
                    onChange={event => {
                      const next = { ...voiceConfig, mode: event.target.value as VoiceInputMode }
                      setVoiceConfig(next)
                      saveVoiceInputConfig(next)
                      setVoiceTestStatus(undefined)
                    }}
                  >
                    <option value="toggle">单击切换 (Toggle) — 按一下开始，再按一下结束</option>
                    <option value="push-to-talk">按住说话 (Push-to-Talk) — 按住开始，松开结束</option>
                  </select>
                </div>
                <div className="voice-test-actions">
                  <button
                    data-focus-id="voice-input-test"
                    type="button"
                    className="button button--secondary"
                    onClick={async () => {
                      try {
                        await simulateKeyAction(voiceConfig.targetKey, 'tap', voiceConfig.customKeyCode)
                        setVoiceTestStatus(`已成功模拟按键：${voiceConfig.targetKey}`)
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
  if (status === 'paused') return '已暂停'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已停止'
  if (status === 'blocked') return '需要处理'
  if (status === 'max-tokens') return '输出已截断'
  if (status === 'interrupted') return '已中断'
  if (status === 'failed') return '失败'
  return '等待输入'
}

function permissionLabel(mode: TaskPermissionMode): string {
  return mode === 'full-access' ? '完全访问' : '标准权限'
}

function permissionDescription(mode: TaskPermissionMode): string {
  return mode === 'full-access'
    ? '完全访问，不再逐项审批'
    : '标准权限，本次操作需要审批'
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
