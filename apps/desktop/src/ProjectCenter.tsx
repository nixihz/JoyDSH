import { Folder, FolderCog, FolderOpen, FolderPlus, Plus, ShieldCheck } from 'lucide-react'
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
  onChangeProjectPermission(path: string, value: WorkspacePermissionMode): void
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
          <div className="project-header__info">
            <div className="project-header__title-row">
              <span className="step-label">工作空间</span>
              <h2 id="project-center-title">选择项目</h2>
            </div>
            {hasBase ? (
              <div className="project-header__base" title={props.catalog.baseDirectory}>
                <Folder aria-hidden="true" />
                <strong>{folderName(props.catalog.baseDirectory ?? '')}</strong>
                <span>{props.catalog.baseDirectory}</span>
              </div>
            ) : null}
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
            <form className="project-create-card" onSubmit={event => { event.preventDefault(); props.onCreate() }}>
              <div className="project-create-card__top">
                <div className="project-create-card__title">
                  <FolderPlus aria-hidden="true" />
                  <label htmlFor="project-name">新建项目</label>
                </div>
                <PermissionSelector
                  busy={props.busy}
                  label="新项目默认权限"
                  mode={props.permissionMode}
                  onChange={props.onChangePermissionMode}
                />
              </div>
              <div className="project-create-card__input-row">
                <input
                  data-focus-id="project-name"
                  id="project-name"
                  value={props.projectName}
                  onChange={event => props.onChangeProjectName(event.target.value)}
                  placeholder="输入项目文件夹名..."
                  autoComplete="off"
                  spellCheck={false}
                />
                <button data-focus-id="project-create" className="button button--primary project-create-button" type="submit" disabled={props.busy || props.projectName.trim() === ''} title="创建并打开项目" aria-label="创建并打开项目">
                  <Plus aria-hidden="true" />
                  <span>创建</span>
                </button>
              </div>
            </form>
          ) : (
            <>
              <section className="project-create-card">
                <PermissionSelector
                  busy={props.busy}
                  label="新项目默认权限"
                  mode={props.permissionMode}
                  onChange={props.onChangePermissionMode}
                />
              </section>
              <div className="project-empty">
                <FolderCog aria-hidden="true" />
                <h3>设置工作区</h3>
                <p>选择一个本地目录作为工作区根目录以管理你的项目。</p>
                <button data-focus-id="project-base-empty" className="button button--primary button--tv" type="button" onClick={props.onChooseBase} disabled={props.busy}>
                  <FolderOpen aria-hidden="true" />
                  选择根目录
                </button>
              </div>
            </>
          )}

          {props.catalog.projects.length === 0 ? null : (
            <div className="project-section">
              <div className="project-section__header">
                <span>现有项目 ({props.catalog.projects.length})</span>
              </div>
              <div className="project-list" role="list" aria-label="项目">
                {props.catalog.projects.map((project, index) => (
                  <div
                    key={project.path}
                    className={project.path === props.activePath ? 'project-row project-row--active' : 'project-row'}
                    role="listitem"
                  >
                    <button
                      data-focus-id={`project-item-${index}`}
                      className="project-row__open"
                      type="button"
                      onClick={() => props.onSelect(project.path)}
                      disabled={props.busy}
                    >
                      <div className="project-row__icon">
                        <Folder aria-hidden="true" />
                      </div>
                      <div className="project-row__details">
                        <strong>{project.name}</strong>
                        <small>{project.path}</small>
                      </div>
                    </button>
                    <div className="project-row__controls">
                      <label className={`project-row__permission project-row__permission--${project.permissionMode}`}>
                        <ShieldCheck aria-hidden="true" />
                        <span className="sr-only">{project.name} 的默认权限</span>
                        <select
                          data-focus-id={`project-permission-${index}`}
                          aria-label={`${project.name} 的默认权限`}
                          value={project.permissionMode}
                          disabled={props.busy}
                          onChange={event => props.onChangeProjectPermission(project.path, event.target.value as WorkspacePermissionMode)}
                        >
                          <option value="standard">标准权限</option>
                          <option value="full-access">完全访问</option>
                        </select>
                      </label>
                      {project.recent ? <em className="project-row__badge">最近</em> : null}
                    </div>
                  </div>
                ))}
              </div>
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
  label: string
  mode: WorkspacePermissionMode
  onChange(value: WorkspacePermissionMode): void
}

function PermissionSelector({ busy, label, mode, onChange }: PermissionSelectorProps) {
  return (
    <div className="project-permission-selector" aria-labelledby="project-permission-label">
      <span id="project-permission-label" className="project-permission-label">{label}</span>
      <div className="provider-segment project-permission-segment" role="group" aria-labelledby="project-permission-label">
        <button
          data-focus-id="project-permission-standard"
          type="button"
          aria-pressed={mode === 'standard'}
          className={mode === 'standard' ? 'provider-segment__item provider-segment__item--active' : 'provider-segment__item'}
          disabled={busy}
          onClick={() => onChange('standard')}
          title="标准权限仅写入工作区；敏感操作会先等待你的批准。"
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
          title="完全访问不会逐项审批，可修改工作区外文件并执行高风险操作。"
        >
          完全访问
        </button>
      </div>
    </div>
  )
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
