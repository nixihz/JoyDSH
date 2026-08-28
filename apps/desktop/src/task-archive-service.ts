import type { TaskSession } from '@joydsh/domain'

const STORAGE_KEY = 'joydsh.task-archives.v1'
const STORAGE_VERSION = 1

export interface TaskArchiveEntry {
  taskId: string
  archivedAt: number
}

export interface TaskArchiveState {
  version: 1
  entries: readonly TaskArchiveEntry[]
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const EMPTY_STATE: TaskArchiveState = { version: STORAGE_VERSION, entries: [] }

export function loadTaskArchiveState(storage: StorageLike | undefined = browserStorage()): TaskArchiveState {
  if (storage === undefined) return EMPTY_STATE
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return EMPTY_STATE
    return parseTaskArchiveState(JSON.parse(raw))
  } catch {
    return EMPTY_STATE
  }
}

export function saveTaskArchiveState(
  state: TaskArchiveState,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (storage === undefined) return
  storage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function archiveTask(
  state: TaskArchiveState,
  taskId: string,
  archivedAt = Date.now(),
): TaskArchiveState {
  const entry = state.entries.find(candidate => candidate.taskId === taskId)
  if (entry !== undefined) return state
  return {
    version: STORAGE_VERSION,
    entries: [...state.entries, { taskId, archivedAt }],
  }
}

export function restoreArchivedTask(state: TaskArchiveState, taskId: string): TaskArchiveState {
  const entries = state.entries.filter(entry => entry.taskId !== taskId)
  return entries.length === state.entries.length ? state : { version: STORAGE_VERSION, entries }
}

export function isTaskArchived(state: TaskArchiveState, taskId: string): boolean {
  return state.entries.some(entry => entry.taskId === taskId)
}

export function visibleTasks(tasks: readonly TaskSession[], state: TaskArchiveState): TaskSession[] {
  const archivedIds = new Set(state.entries.map(entry => entry.taskId))
  return tasks.filter(task => !archivedIds.has(task.id))
}

export function archivedTasks(tasks: readonly TaskSession[], state: TaskArchiveState): TaskSession[] {
  const archiveOrder = new Map(state.entries.map(entry => [entry.taskId, entry.archivedAt]))
  return tasks
    .filter(task => archiveOrder.has(task.id))
    .sort((left, right) => (archiveOrder.get(right.id) ?? 0) - (archiveOrder.get(left.id) ?? 0))
}

function parseTaskArchiveState(value: unknown): TaskArchiveState {
  if (typeof value !== 'object' || value === null) return EMPTY_STATE
  const candidate = value as { version?: unknown; entries?: unknown }
  if (candidate.version !== STORAGE_VERSION || !Array.isArray(candidate.entries)) return EMPTY_STATE

  const seen = new Set<string>()
  const entries: TaskArchiveEntry[] = []
  for (const item of candidate.entries) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as { taskId?: unknown; archivedAt?: unknown }
    if (typeof entry.taskId !== 'string' || entry.taskId === '' || seen.has(entry.taskId)) continue
    if (typeof entry.archivedAt !== 'number' || !Number.isFinite(entry.archivedAt)) continue
    seen.add(entry.taskId)
    entries.push({ taskId: entry.taskId, archivedAt: entry.archivedAt })
  }
  return { version: STORAGE_VERSION, entries }
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === 'undefined') return undefined
  return window.localStorage
}
