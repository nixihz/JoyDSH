import { Folder, FolderCog, FolderOpen, Plus } from 'lucide-react'
import type { WorkspaceCatalog, WorkspacePermissionMode } from './workspace-service.ts'

interface ProjectCenterProps {
  activePath: string
  busy: boolean
  catalog: WorkspaceCatalog
  error?: string
  permissionMode: WorkspacePermissionMode
  projectName: string
  onChangePermissionMode(value: WorkspacePermissionMode): void
  onChangeProjectName(value: string): void
  onChooseBase(): void
  onClose(): void
  onCreate(): void
  onOpenFolder(): void
  onSelect(path: string): void
}

export function ProjectCenter(props: ProjectCenterProps) {
  const hasBase = props.catalog.baseDirectory !== undefined
  return (
    <div className="project-overlay" role="presentation" onMouseDown={event => {
      if (event.currentTarget === event.target) props.onClose()
    }}>
      <section className="project-sheet" role="dialog" aria-modal="true" aria-labelledby="project-center-title">
        <header className="project-header">
          <div>
            <span className="step-label">工作空间</span>
            <h2 id="project-center-title">选择项目</h2>
          </div>
          <div className="project-header__actions">
            <button data-focus-id="project-base-picker" className="icon-button icon-button--quiet" type="button" onClick={props.onChooseBase} disabled={props.busy} title="设置工作区根目录" aria-label="设置工作区根目录">
              <FolderCog aria-hidden="true" />
            </button>
            <button data-focus-id="project-open-folder" className="icon-button icon-button--quiet" type="button" onClick={props.onOpenFolder} disabled={props.busy} title="打开其他文件夹" aria-label="打开其他文件夹">
              <FolderOpen aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="project-body" data-scroll-region="projects">
          {hasBase ? (
            <>
              <div className="project-base">
                <Folder aria-hidden="true" />
                <div><strong>{folderName(props.catalog.baseDirectory ?? '')}</strong><span>{props.catalog.baseDirectory}</span></div>
              </div>
              <form className="project-create" onSubmit={event => { event.preventDefault(); props.onCreate() }}>
                <PermissionSelector
                  busy={props.busy}
                  mode={props.permissionMode}
                  onChange={props.onChangePermissionMode}
                />
                <label htmlFor="project-name">新项目</label>
                <div>
                  <input
                    data-focus-id="project-name"
                    id="project-name"
                    value={props.projectName}
                    onChange={event => props.onChangeProjectName(event.target.value)}
                    placeholder="项目文件夹名"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button data-focus-id="project-create" className="icon-button button--primary" type="submit" disabled={props.busy || props.projectName.trim() === ''} title="创建并打开项目" aria-label="创建并打开项目">
                    <Plus aria-hidden="true" />
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              <section className="project-create">
                <PermissionSelector
                  busy={props.busy}
                  mode={props.permissionMode}
                  onChange={props.onChangePermissionMode}
                />
              </section>
              <div className="project-empty">
                <FolderCog aria-hidden="true" />
                <h3>设置工作区</h3>
                <button data-focus-id="project-base-empty" className="button button--primary button--tv" type="button" onClick={props.onChooseBase} disabled={props.busy}>
                  <FolderOpen aria-hidden="true" />
                  选择根目录
                </button>
              </div>
            </>
          )}

          {props.catalog.projects.length === 0 ? null : (
            <div className="project-list" role="list" aria-label="项目">
              {props.catalog.projects.map((project, index) => (
                <button
                  key={project.path}
                  data-focus-id={`project-item-${index}`}
                  className={project.path === props.activePath ? 'project-row project-row--active' : 'project-row'}
                  type="button"
                  role="listitem"
                  onClick={() => props.onSelect(project.path)}
                  disabled={props.busy}
                >
                  <Folder aria-hidden="true" />
                  <span><strong>{project.name}</strong><small>{project.path}</small></span>
                  <em>{project.recent ? '最近 · ' : ''}{permissionLabel(project.permissionMode)}</em>
                </button>
              ))}
            </div>
          )}
          {props.error === undefined ? null : <div className="inline-error" role="alert">{props.error}</div>}
        </div>
      </section>
    </div>
  )
}

interface PermissionSelectorProps {
  busy: boolean
  mode: WorkspacePermissionMode
  onChange(value: WorkspacePermissionMode): void
}

function PermissionSelector({ busy, mode, onChange }: PermissionSelectorProps) {
  return (
    <section className="model-field" aria-labelledby="project-permission-label">
      <label id="project-permission-label">任务权限</label>
      <div className="provider-segment" role="group" aria-labelledby="project-permission-label">
        <button
          data-focus-id="project-permission-standard"
          type="button"
          aria-pressed={mode === 'standard'}
          className={mode === 'standard' ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
          disabled={busy}
          onClick={() => onChange('standard')}
        >
          标准权限
        </button>
        <button
          data-focus-id="project-permission-full-access"
          type="button"
          aria-pressed={mode === 'full-access'}
          className={mode === 'full-access' ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
          disabled={busy}
          onClick={() => onChange('full-access')}
        >
          完全访问
        </button>
      </div>
      <p aria-live="polite">
        {mode === 'full-access'
          ? '完全访问不会逐项审批，可修改工作区外文件并执行高风险操作。'
          : '标准权限仅写入工作区；敏感操作会先等待你的批准。'}
      </p>
    </section>
  )
}

function permissionLabel(mode: WorkspacePermissionMode): string {
  return mode === 'full-access' ? '完全访问' : '标准权限'
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
