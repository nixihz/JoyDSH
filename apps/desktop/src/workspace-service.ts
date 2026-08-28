import type { TaskPermissionMode } from '@joydsh/domain'
import { isTauri } from './runtime-control.ts'

export type WorkspacePermissionMode = TaskPermissionMode

export interface WorkspaceProject {
  name: string
  path: string
  recent: boolean
  permissionMode: WorkspacePermissionMode
}

export interface WorkspaceCatalog {
  baseDirectory?: string
  projects: WorkspaceProject[]
}

export interface WorkspaceSelection {
  path: string
  catalog: WorkspaceCatalog
}

const EMPTY_CATALOG: WorkspaceCatalog = { projects: [] }

export async function describeWorkspaceCatalog(): Promise<WorkspaceCatalog> {
  if (!isTauri()) return EMPTY_CATALOG
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceCatalog>('describe_workspace_catalog')
}

export async function chooseWorkspaceDirectory(title: string): Promise<string | undefined> {
  if (!isTauri()) throw new Error('文件夹选择需要在 JoyDSH 桌面应用中使用')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title })
  return typeof selected === 'string' ? selected : undefined
}

export async function setWorkspaceBase(path: string): Promise<WorkspaceCatalog> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceCatalog>('set_workspace_base', { path })
}

export async function createWorkspaceProject(name: string, permissionMode: WorkspacePermissionMode): Promise<WorkspaceSelection> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceSelection>('create_workspace_project', { name, permissionMode })
}

export async function rememberWorkspaceProject(path: string, permissionMode: WorkspacePermissionMode): Promise<WorkspaceSelection> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<WorkspaceSelection>('remember_workspace_project', { path, permissionMode })
}
