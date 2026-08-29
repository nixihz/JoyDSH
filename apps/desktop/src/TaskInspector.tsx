import { useMemo } from 'react'
import type {
  FileDiff,
  TaskArtifactSnapshot,
  TaskEvent,
  TaskFileChange,
  TextDiffLine,
} from '@joydsh/domain'
import { Check, Undo2 } from 'lucide-react'

export type InspectorPage = 'activity' | 'changes' | 'artifacts'

export interface TaskInspectorProps {
  page: InspectorPage
  onPageChange: (page: InspectorPage) => void
  events: readonly TaskEvent[]
  snapshot: TaskArtifactSnapshot | undefined
  loading: boolean
  selectedChangeId: string | undefined
  mutationBusy: boolean
  mutationError?: string
  canReview: boolean
  onSelectChange: (changeId: string) => void
  onAcceptChange: (changeId: string) => void
  onRequestRejectChange: (changeId: string) => void
  onEstablishBaseline?: () => void
}

const INSPECTOR_PAGES: readonly { page: InspectorPage; label: string }[] = [
  { page: 'activity', label: '动态' },
  { page: 'changes', label: '变更' },
  { page: 'artifacts', label: '成果' },
]

const EVENT_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function TaskInspector({
  page,
  onPageChange,
  events,
  snapshot,
  loading,
  selectedChangeId,
  mutationBusy,
  mutationError,
  canReview,
  onSelectChange,
  onAcceptChange,
  onRequestRejectChange,
  onEstablishBaseline,
}: TaskInspectorProps) {
  const changes = snapshot?.changes ?? []
  const activityItems = useMemo(() => aggregateActivityItems(events), [events])

  return (
    <section id="task-inspector" className="events-panel task-inspector" aria-label="任务检查器" aria-busy={loading}>
      <header className="inspector-header">
        <div className="inspector-tabs" role="tablist" aria-label="任务检查器页面">
          {INSPECTOR_PAGES.map(item => (
            <button
              key={item.page}
              id={`inspector-tab-${item.page}`}
              data-focus-id={`inspector-tab-${item.page}`}
              className={`inspector-tab${page === item.page ? ' inspector-tab--active' : ''}`}
              type="button"
              role="tab"
              aria-controls={`inspector-panel-${item.page}`}
              aria-selected={page === item.page}
              onClick={() => onPageChange(item.page)}
            >
              {item.label}
              <span aria-hidden="true">{pageCount(item.page, activityItems.length, changes.length)}</span>
            </button>
          ))}
        </div>
      </header>

      {page === 'activity' ? (
        <ActivityPage items={activityItems} />
      ) : page === 'changes' ? (
        <ChangesPage
          snapshot={snapshot}
          loading={loading}
          selectedChangeId={selectedChangeId}
          mutationBusy={mutationBusy}
          {...(mutationError === undefined ? {} : { mutationError })}
          canReview={canReview}
          onSelectChange={onSelectChange}
          onAcceptChange={onAcceptChange}
          onRequestRejectChange={onRequestRejectChange}
          {...(onEstablishBaseline === undefined ? {} : { onEstablishBaseline })}
        />
      ) : (
        <ArtifactsPage
          snapshot={snapshot}
          loading={loading}
          {...(onEstablishBaseline === undefined ? {} : { onEstablishBaseline })}
        />
      )}
    </section>
  )
}

function ActivityPage({ items }: { items: readonly ActivityItem[] }) {
  return (
    <div
      id="inspector-panel-activity"
      className="inspector-panel"
      role="tabpanel"
      aria-labelledby="inspector-tab-activity"
    >
      <ol className="activity-list event-list" data-scroll-region="inspector-activity" aria-live="polite">
        {items.length === 0 ? (
          <li className="activity-empty event-empty">暂无动态记录</li>
        ) : (
          items.map(item => (
            <li key={item.id} className={`activity-item activity-item--${item.kind}`}>
              <div className="activity-item__header">
                <time dateTime={new Date(item.time).toISOString()}>{formatTime(item.time)}</time>
                <span className={`activity-badge activity-badge--${item.badgeKind}`}>{item.badgeLabel}</span>
                <strong className="activity-item__title">{item.title}</strong>
              </div>
              {item.contentKind === 'todos' && item.todoItems && item.todoItems.length > 0 ? (
                <div className="activity-item__body">
                  <ul className="activity-item__todos">
                    {item.todoItems.map((todo, idx) => (
                      <li key={idx} className={`activity-todo activity-todo--${todo.status}`}>
                        <span className="activity-todo__icon" aria-hidden="true">
                          {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '⏳' : '○'}
                        </span>
                        <span>{todo.content}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : item.content ? (
                <div className="activity-item__body">
                  {item.contentKind === 'code' ? (
                    <code className="activity-item__code">{item.content}</code>
                  ) : (
                    <p className="activity-item__text">{item.content}</p>
                  )}
                </div>
              ) : null}
            </li>
          ))
        )}
      </ol>
    </div>
  )
}

interface SnapshotPageProps {
  snapshot: TaskArtifactSnapshot | undefined
  loading: boolean
  onEstablishBaseline?: () => void
}

interface ChangesPageProps extends SnapshotPageProps {
  selectedChangeId: string | undefined
  mutationBusy: boolean
  mutationError?: string
  canReview: boolean
  onSelectChange: (changeId: string) => void
  onAcceptChange: (changeId: string) => void
  onRequestRejectChange: (changeId: string) => void
}

function ChangesPage({
  snapshot,
  loading,
  selectedChangeId,
  mutationBusy,
  mutationError,
  canReview,
  onSelectChange,
  onAcceptChange,
  onRequestRejectChange,
  onEstablishBaseline,
}: ChangesPageProps) {
  if (loading) return <InspectorState page="changes" message="正在检查任务变更..." />
  if (snapshot === undefined) return <InspectorState page="changes" message="任务开始后可查看文件变更" />
  if (snapshot.availability === 'unavailable') {
    const action = (snapshot.reason === 'baseline-missing' || snapshot.reason === 'invalid-baseline') && onEstablishBaseline !== undefined ? (
      <button
        type="button"
        className="inspector-state-btn"
        data-focus-id="artifact-establish-baseline-changes"
        onClick={onEstablishBaseline}
      >
        建立任务基线
      </button>
    ) : undefined
    return (
      <InspectorState
        page="changes"
        title={artifactReasonLabel(snapshot.reason)}
        message={snapshot.message}
        tone="warning"
        {...(action === undefined ? {} : { action })}
      />
    )
  }
  if (snapshot.clean || snapshot.changes.length === 0) {
    return <InspectorState page="changes" title="工作区没有变更" message="当前内容与任务开始时一致" />
  }

  const selectedChange = snapshot.changes.find(change => change.changeId === selectedChangeId) ?? snapshot.changes[0]

  return (
    <div
      id="inspector-panel-changes"
      className="inspector-panel inspector-changes"
      role="tabpanel"
      aria-labelledby="inspector-tab-changes"
    >
      <div className="inspector-file-list" data-scroll-region="inspector-files" aria-label="变更文件">
        {snapshot.changes.map(change => {
          const selected = change.changeId === selectedChange?.changeId
          return (
            <button
              key={`${change.previousPath ?? ''}:${change.path}`}
              data-focus-id={`inspector-file-${change.changeId}`}
              className={`inspector-file${selected ? ' inspector-file--selected' : ''}`}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectChange(change.changeId)}
            >
              <span className={`change-kind change-kind--${change.kind}`}>{fileChangeKindLabel(change.kind)}</span>
              <span className="inspector-file__path">{change.path}</span>
              <small>{fileChangeReviewMeta(change)}</small>
            </button>
          )
        })}
      </div>
      {selectedChange === undefined ? null : (
        <FileDiffView
          change={selectedChange}
          mutationBusy={mutationBusy}
          {...(mutationError === undefined ? {} : { mutationError })}
          canReview={canReview}
          onAcceptChange={onAcceptChange}
          onRequestRejectChange={onRequestRejectChange}
        />
      )}
    </div>
  )
}

interface FileDiffViewProps {
  change: TaskFileChange
  mutationBusy: boolean
  mutationError?: string
  canReview: boolean
  onAcceptChange: (changeId: string) => void
  onRequestRejectChange: (changeId: string) => void
}

function FileDiffView({
  change,
  mutationBusy,
  mutationError,
  canReview,
  onAcceptChange,
  onRequestRejectChange,
}: FileDiffViewProps) {
  return (
    <section className="inspector-diff" aria-labelledby="inspector-diff-heading">
      <header className="inspector-diff__header">
        <div className="inspector-diff__identity">
          <span>{fileChangeKindLabel(change.kind)}</span>
          <h3 id="inspector-diff-heading">{change.path}</h3>
          {change.previousPath === undefined ? null : <small>原路径 {change.previousPath}</small>}
          {mutationError === undefined ? null : <p className="artifact-mutation-error" role="alert" title={mutationError}>{mutationError}</p>}
        </div>
        <div className="inspector-diff__review">
          <DiffTotals diff={change.diff} />
          <span className={`review-state review-state--${change.review}`}>
            {change.review === 'accepted' ? '已接受' : '待评审'}
          </span>
          <div className="inspector-diff__actions">
            <button
              data-focus-id={`artifact-accept-${change.changeId}`}
              className="icon-button artifact-action artifact-action--accept"
              type="button"
              disabled={!canReview || mutationBusy || change.review === 'accepted'}
              onClick={() => onAcceptChange(change.changeId)}
              title="接受当前文件"
              aria-label="接受当前文件"
            >
              <Check aria-hidden="true" />
            </button>
            <button
              data-focus-id={`artifact-reject-${change.changeId}`}
              className="icon-button artifact-action artifact-action--reject"
              type="button"
              disabled={!canReview || mutationBusy}
              onClick={() => onRequestRejectChange(change.changeId)}
              title="拒绝当前文件变更"
              aria-label="拒绝当前文件变更"
            >
              <Undo2 aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <div className="inspector-diff__content" data-scroll-region="inspector-diff" tabIndex={0}>
        <DiffContent diff={change.diff} />
      </div>
    </section>
  )
}

function DiffContent({ diff }: { diff: FileDiff }) {
  if (diff.kind === 'binary') {
    return <DiffState title="二进制文件" message="内容无法按文本差异展示" />
  }
  if (diff.kind === 'too-large') {
    return <DiffState title="文件过大" message={`超过 ${formatBytes(diff.limitBytes)} 的差异展示上限`} />
  }
  if (diff.kind === 'unavailable') {
    return <DiffState title={fileDiffReasonLabel(diff.reason)} message={diff.message} tone="warning" />
  }
  if (diff.hunks.length === 0) {
    return <DiffState title="没有文本差异" message="文件元数据可能发生了变化" />
  }

  return (
    <div className="diff-hunks">
      {diff.hunks.map((hunk, hunkIndex) => (
        <section className="diff-hunk" key={`${hunk.before.start}:${hunk.after.start}:${hunkIndex}`}>
          <div className="diff-hunk__heading">
            <code>{`@@ -${hunk.before.start},${hunk.before.lines} +${hunk.after.start},${hunk.after.lines} @@`}</code>
            {hunk.heading === '' ? null : <span>{hunk.heading}</span>}
          </div>
          <div className="diff-lines">
            {hunk.lines.map((line, lineIndex) => (
              <DiffLine key={`${line.beforeLine ?? ''}:${line.afterLine ?? ''}:${lineIndex}`} line={line} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function DiffLine({ line }: { line: TextDiffLine }) {
  return (
    <div className={`diff-line diff-line--${line.kind}`}>
      <span className="diff-line__marker" aria-hidden="true">{diffLineMarker(line.kind)}</span>
      <span className="diff-line__number">{line.beforeLine ?? ''}</span>
      <span className="diff-line__number">{line.afterLine ?? ''}</span>
      <code>{line.content}</code>
    </div>
  )
}

function DiffTotals({ diff }: { diff: FileDiff }) {
  if (diff.kind !== 'text') return <span className="diff-total">{fileDiffKindLabel(diff)}</span>
  return (
    <span className="diff-total" aria-label={`增加 ${diff.additions} 行，删除 ${diff.deletions} 行`}>
      <b>+{diff.additions}</b>
      <i>-{diff.deletions}</i>
    </span>
  )
}

function ArtifactsPage({ snapshot, loading, onEstablishBaseline }: SnapshotPageProps) {
  if (loading) return <InspectorState page="artifacts" message="正在汇总任务成果..." />
  if (snapshot === undefined) return <InspectorState page="artifacts" message="任务开始后可查看成果汇总" />
  if (snapshot.availability === 'unavailable') {
    const action = (snapshot.reason === 'baseline-missing' || snapshot.reason === 'invalid-baseline') && onEstablishBaseline !== undefined ? (
      <button
        type="button"
        className="inspector-state-btn"
        data-focus-id="artifact-establish-baseline-artifacts"
        onClick={onEstablishBaseline}
      >
        建立任务基线
      </button>
    ) : undefined
    return (
      <InspectorState
        page="artifacts"
        title={artifactReasonLabel(snapshot.reason)}
        message={snapshot.message}
        tone="warning"
        {...(action === undefined ? {} : { action })}
      />
    )
  }

  return (
    <div
      id="inspector-panel-artifacts"
      className="inspector-panel inspector-artifacts"
      role="tabpanel"
      aria-labelledby="inspector-tab-artifacts"
    >
      <section className="artifact-summary" aria-labelledby="artifact-summary-heading">
        <header>
          <span>任务成果</span>
          <h3 id="artifact-summary-heading">{snapshot.clean ? '没有文件变更' : `${snapshot.changes.length} 个文件已变更`}</h3>
        </header>
        <dl className="artifact-metrics">
          <div><dt>文件</dt><dd>{snapshot.changes.length}</dd></div>
          <div><dt>增加</dt><dd className="artifact-metric--added">+{snapshot.additions}</dd></div>
          <div><dt>删除</dt><dd className="artifact-metric--removed">-{snapshot.deletions}</dd></div>
        </dl>
        <dl className="artifact-boundary">
          <div><dt>任务基线</dt><dd>{shortVersion(snapshot.baseline.version)}</dd></div>
          {snapshot.currentVersion === undefined ? null : (
            <div><dt>当前版本</dt><dd>{shortVersion(snapshot.currentVersion)}</dd></div>
          )}
          <div><dt>工作区</dt><dd title={snapshot.workspacePath}>{snapshot.workspacePath}</dd></div>
        </dl>
      </section>

      <ol className="artifact-file-list" data-scroll-region="inspector-artifacts" aria-label="成果文件">
        {snapshot.changes.length === 0 ? (
          <li className="inspector-list-empty">暂无文件变更</li>
        ) : snapshot.changes.map(change => (
          <li key={`${change.previousPath ?? ''}:${change.path}`}>
            <span className={`change-kind change-kind--${change.kind}`}>{fileChangeKindLabel(change.kind)}</span>
            <span>{change.path}</span>
            <small>{fileChangeReviewMeta(change)}</small>
          </li>
        ))}
      </ol>
    </div>
  )
}

interface InspectorStateProps {
  page: Exclude<InspectorPage, 'activity'>
  title?: string
  message: string
  tone?: 'neutral' | 'warning'
  action?: React.ReactNode
}

function InspectorState({ page, title, message, tone = 'neutral', action }: InspectorStateProps) {
  return (
    <div
      id={`inspector-panel-${page}`}
      className={`inspector-panel inspector-state inspector-state--${tone}`}
      role="tabpanel"
      aria-labelledby={`inspector-tab-${page}`}
    >
      {title === undefined ? null : <strong>{title}</strong>}
      <p>{message}</p>
      {action === undefined ? null : <div className="inspector-state__action">{action}</div>}
    </div>
  )
}

function DiffState({ title, message, tone = 'neutral' }: Omit<InspectorStateProps, 'page'>) {
  return (
    <div className={`diff-state diff-state--${tone}`}>
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  )
}

export interface ActivityTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ActivityBadgeKind =
  | 'session'
  | 'assistant'
  | 'user'
  | 'tool'
  | 'plan'
  | 'approval'
  | 'host'
  | 'error'
  | 'control'

export interface ActivityItem {
  id: string
  time: number
  kind: TaskEvent['kind']
  badgeKind: ActivityBadgeKind
  badgeLabel: string
  title: string
  content?: string | undefined
  contentKind?: 'text' | 'code' | 'todos' | undefined
  todoItems?: readonly ActivityTodoItem[] | undefined
  _eventType?: string | undefined
}

export function aggregateActivityItems(events: readonly TaskEvent[]): ActivityItem[] {
  const items: ActivityItem[] = []

  for (const event of events) {
    const lastItem = items.at(-1)

    if (event.type === 'assistant/chunk') {
      const delta = extractTextDelta(event.data)
      const failure = extractFailure(event.data)

      if (lastItem !== undefined && (lastItem._eventType === 'assistant/chunk' || lastItem._eventType === 'assistant/message')) {
        if (delta !== undefined && delta.length > 0) {
          lastItem.content = (lastItem.content ?? '') + delta
        }
        if (failure !== undefined) {
          lastItem.content = (lastItem.content ?? '') + (lastItem.content ? '\n' : '') + failure.message
          lastItem.kind = 'error'
          lastItem.badgeKind = 'error'
          lastItem.badgeLabel = '错误'
          lastItem.title = '助手异常'
        }
      } else {
        if (delta !== undefined && delta.length > 0) {
          items.push({
            id: event.id,
            time: event.time,
            kind: 'session',
            badgeKind: 'assistant',
            badgeLabel: '助手',
            title: '助手回复',
            content: delta,
            contentKind: 'text',
            _eventType: 'assistant/chunk',
          })
        } else if (failure !== undefined) {
          items.push({
            id: event.id,
            time: event.time,
            kind: 'error',
            badgeKind: 'error',
            badgeLabel: '错误',
            title: '助手异常',
            content: failure.message,
            contentKind: 'text',
            _eventType: 'assistant/chunk',
          })
        }
      }
      continue
    }

    if (event.type === 'assistant/message') {
      const message = extractAssistantMessage(event.data)
      if (lastItem !== undefined && (lastItem._eventType === 'assistant/chunk' || lastItem._eventType === 'assistant/message')) {
        if (message !== undefined && message.length > 0) {
          lastItem.content = message
        }
        lastItem._eventType = 'assistant/message'
      } else if (message !== undefined && message.length > 0) {
        items.push({
          id: event.id,
          time: event.time,
          kind: 'session',
          badgeKind: 'assistant',
          badgeLabel: '助手',
          title: '助手回复',
          content: message,
          contentKind: 'text',
          _eventType: 'assistant/message',
        })
      }
      continue
    }

    if (event.type === 'user/message') {
      const message = extractUserMessage(event.data) ?? eventSummary(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: 'session',
        badgeKind: 'user',
        badgeLabel: '用户',
        title: '用户指令',
        content: message,
        contentKind: 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'tool/call') {
      const tool = extractToolCall(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: event.kind,
        badgeKind: 'tool',
        badgeLabel: '工具',
        title: `调用工具 · ${tool.name}`,
        content: tool.command ?? tool.summary ?? tool.raw,
        contentKind: tool.command ? 'code' : 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'tool/result') {
      const result = extractToolResult(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: event.kind,
        badgeKind: 'tool',
        badgeLabel: '工具',
        title: '工具执行结果',
        content: result.code ?? result.summary,
        contentKind: result.code ? 'code' : 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'todo/write') {
      const todos = extractTodos(event.data)
      if (todos !== undefined && todos.length > 0) {
        items.push({
          id: event.id,
          time: event.time,
          kind: event.kind,
          badgeKind: 'plan',
          badgeLabel: '计划',
          title: `更新执行计划 (${todos.length} 项)`,
          todoItems: todos,
          contentKind: 'todos',
          _eventType: event.type,
        })
      }
      continue
    }

    if (event.type === 'approval/requested') {
      const approval = extractRequestedApprovalData(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: event.kind,
        badgeKind: 'approval',
        badgeLabel: '审批',
        title: `请求审批 · ${approval?.toolName ?? '工具'}`,
        content: approval?.reason ?? '需要确认执行操作',
        contentKind: 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'approval/resolved') {
      const resolution = extractResolvedApprovalData(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: event.kind,
        badgeKind: 'approval',
        badgeLabel: '审批',
        title: '审批处理',
        content: resolution?.outcome === 'rejected' ? '已拒绝执行' : '已允许执行',
        contentKind: 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'turn/start') {
      const turnNum = extractTurnNumber(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: 'session',
        badgeKind: 'session',
        badgeLabel: '会话',
        title: turnNum !== undefined ? `回合 #${turnNum} 开始` : '回合开始',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'turn/end') {
      const reasonLabel = extractTurnEndLabel(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: 'session',
        badgeKind: 'session',
        badgeLabel: '会话',
        title: '回合结束',
        content: reasonLabel,
        contentKind: 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'permission/preset') {
      const preset = extractPermissionPreset(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: 'control',
        badgeKind: 'control',
        badgeLabel: '权限',
        title: '权限模式变更',
        content: preset === 'danger-full-access' ? '完全访问模式' : '标准工作区模式',
        contentKind: 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.kind === 'error' || event.type === 'stream/error' || event.type === 'host/agent-error') {
      const failure = extractFailure(event.data)
      items.push({
        id: event.id,
        time: event.time,
        kind: 'error',
        badgeKind: 'error',
        badgeLabel: '错误',
        title: '执行异常',
        content: failure?.message ?? eventSummary(event.data),
        contentKind: 'text',
        _eventType: event.type,
      })
      continue
    }

    if (event.type === 'host/session-status') {
      const running = isRunningData(event.data)
      if (running !== undefined) {
        items.push({
          id: event.id,
          time: event.time,
          kind: 'host',
          badgeKind: 'host',
          badgeLabel: '宿主',
          title: running ? '会话开始运行' : '会话进入空闲',
          _eventType: event.type,
        })
      }
      continue
    }

    // Generic fallback event
    const summary = eventSummary(event.data)
    const fallbackBadge: ActivityBadgeKind = event.kind === 'host' ? 'host' : event.kind === 'session' ? 'session' : 'control'
    items.push({
      id: event.id,
      time: event.time,
      kind: event.kind,
      badgeKind: fallbackBadge,
      badgeLabel: eventKindLabel(event.kind),
      title: event.type,
      content: summary === '{}' || summary === '' ? undefined : summary,
      contentKind: 'text',
      _eventType: event.type,
    })
  }

  return items
}

function extractTextDelta(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.chunk === 'string') return rec.chunk
    if (typeof rec.chunk === 'object' && rec.chunk !== null) {
      const chunk = rec.chunk as Record<string, unknown>
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text
      if (typeof chunk.text === 'string') return chunk.text
      if (typeof chunk.delta === 'string') return chunk.delta
    }
  }
  return undefined
}

function extractAssistantMessage(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.message === 'object' && rec.message !== null) {
      const msg = rec.message as Record<string, unknown>
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
          .map(block => String(block.text))
          .join('')
        if (text) return text
      }
    }
  }
  return undefined
}

function extractUserMessage(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>
    if (typeof rec.text === 'string') return rec.text
    if (typeof rec.message === 'string') return rec.message
    if (typeof rec.content === 'string') return rec.content
    if (Array.isArray(rec.content)) {
      const texts = rec.content
        .map(b => (typeof b === 'object' && b !== null && 'text' in b ? String((b as Record<string, unknown>).text) : ''))
        .join('')
      if (texts) return texts
    }
  }
  return undefined
}

function extractToolCall(data: unknown): { name: string; command?: string | undefined; summary?: string | undefined; raw?: string | undefined } {
  if (typeof data !== 'object' || data === null) return { name: '未知工具' }
  const rec = data as Record<string, unknown>
  const name = typeof rec.name === 'string' ? rec.name : typeof rec.toolName === 'string' ? rec.toolName : '未知工具'
  let rawArgs: unknown = rec.arguments
  if (typeof rawArgs === 'string') {
    try {
      rawArgs = JSON.parse(rawArgs)
    } catch {
      return { name, raw: String(rawArgs) }
    }
  }
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    const args = rawArgs as Record<string, unknown>
    if (typeof args.command === 'string') {
      return { name, command: `$ ${args.command}` }
    }
    if (typeof args.path === 'string') {
      return { name, summary: `路径: ${args.path}` }
    }
    if (typeof args.filePath === 'string') {
      return { name, summary: `文件: ${args.filePath}` }
    }
    if (typeof args.targetPath === 'string') {
      return { name, summary: `目标: ${args.targetPath}` }
    }
    if (typeof args.pattern === 'string') {
      return { name, summary: `模式: ${args.pattern}` }
    }
    if (typeof args.query === 'string') {
      return { name, summary: `查询: ${args.query}` }
    }
    try {
      const str = JSON.stringify(args)
      return { name, summary: str.length > 120 ? `${str.slice(0, 120)}...` : str }
    } catch {
      return { name }
    }
  }
  return { name }
}

function extractToolResult(data: unknown): { status?: string | undefined; summary?: string | undefined; code?: string | undefined } {
  if (typeof data !== 'object' || data === null) return {}
  const rec = data as Record<string, unknown>
  if (typeof rec.output === 'string') {
    const trimmed = rec.output.trim()
    if (trimmed.length > 240) {
      return { code: `${trimmed.slice(0, 240)}...` }
    }
    return { code: trimmed || '执行成功（无输出）' }
  }
  if (typeof rec.error === 'string') {
    return { summary: `错误: ${rec.error}` }
  }
  if (typeof rec.result === 'string') {
    return { summary: rec.result }
  }
  return { summary: '执行完成' }
}

function extractTodos(data: unknown): ActivityTodoItem[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const todos = (data as Record<string, unknown>).todos
  if (!Array.isArray(todos)) return undefined
  const list: ActivityTodoItem[] = []
  for (const item of todos) {
    if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).content === 'string') {
      const status = (item as Record<string, unknown>).status
      list.push({
        content: String((item as Record<string, unknown>).content),
        status: status === 'completed' || status === 'in_progress' ? status : 'pending',
      })
    }
  }
  return list.length > 0 ? list : undefined
}

function extractRequestedApprovalData(data: unknown): { toolName?: string | undefined; reason?: string | undefined } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const rec = data as Record<string, unknown>
  return {
    toolName: typeof rec.toolName === 'string' ? rec.toolName : undefined,
    reason: typeof rec.reason === 'string' ? rec.reason : undefined,
  }
}

function extractResolvedApprovalData(data: unknown): { outcome?: string | undefined } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const rec = data as Record<string, unknown>
  return {
    outcome: typeof rec.outcome === 'string' ? rec.outcome : undefined,
  }
}

function extractTurnNumber(data: unknown): number | undefined {
  if (typeof data === 'object' && data !== null) {
    const turn = (data as Record<string, unknown>).turn
    if (typeof turn === 'number') return turn
  }
  return undefined
}

function extractTurnEndLabel(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const reason = (data as Record<string, unknown>).reason as Record<string, unknown> | undefined
    if (typeof reason === 'object' && reason !== null) {
      if (reason.kind === 'completed') return '执行完成'
      if (reason.kind === 'aborted') {
        const sub = reason.reason as Record<string, unknown> | undefined
        return sub?.kind === 'user' ? '用户暂停任务' : '执行已取消'
      }
      if (reason.kind === 'max-tokens') return '达到最大令牌数限制'
      if (reason.kind === 'blocked') return '任务受阻'
      if (reason.kind === 'interrupted') return '执行中断'
    }
  }
  return '执行结束'
}

function extractPermissionPreset(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null) {
    const preset = (data as Record<string, unknown>).preset
    if (typeof preset === 'string') return preset
  }
  return undefined
}

function isRunningData(data: unknown): boolean | undefined {
  if (typeof data === 'object' && data !== null) {
    const running = (data as Record<string, unknown>).running
    if (typeof running === 'boolean') return running
  }
  return undefined
}

function extractFailure(data: unknown): { code?: string; message: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const value = data as Record<string, unknown>
  const chunkReason = typeof value.chunk === 'object' && value.chunk !== null
    ? (value.chunk as Record<string, unknown>).reason as Record<string, unknown> | undefined
    : undefined
  const turnReason = typeof value.reason === 'object' && value.reason !== null
    ? value.reason as Record<string, unknown>
    : undefined
  const candidate = (chunkReason?.failure as Record<string, unknown> | undefined)
    ?? (turnReason?.error as Record<string, unknown> | undefined)
    ?? (value.error as Record<string, unknown> | undefined)
  if (candidate !== undefined && typeof candidate.message === 'string') {
    return {
      ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
      message: candidate.message,
    }
  }
  if (typeof value.message === 'string') {
    return {
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      message: value.message,
    }
  }
  return undefined
}

function pageCount(page: InspectorPage, eventCount: number, changeCount: number): number | string {
  if (page === 'activity') return eventCount
  if (page === 'changes') return changeCount
  return changeCount === 0 ? '-' : changeCount
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
    if (text === undefined) return String(data)
    return text.length > 180 ? `${text.slice(0, 180)}...` : text
  } catch {
    return String(data)
  }
}

function formatTime(value: number): string {
  return EVENT_TIME_FORMATTER.format(new Date(value))
}

function fileChangeKindLabel(kind: TaskFileChange['kind']): string {
  switch (kind) {
    case 'created': return '新增'
    case 'modified': return '修改'
    case 'deleted': return '删除'
    case 'moved': return '移动'
    case 'copied': return '复制'
    case 'type-changed': return '类型'
    case 'conflicted': return '冲突'
  }
}

function fileChangeMeta(change: TaskFileChange): string {
  const origin = change.previousPath === undefined ? '' : `${change.previousPath} -> `
  if (change.diff.kind === 'text') return `${origin}+${change.diff.additions} / -${change.diff.deletions}`
  return `${origin}${fileDiffKindLabel(change.diff)}`
}

function fileChangeReviewMeta(change: TaskFileChange): string {
  const review = change.review === 'accepted' ? '已接受' : '待评审'
  return `${fileChangeMeta(change)} · ${review}`
}

function fileDiffKindLabel(diff: FileDiff): string {
  if (diff.kind === 'binary') return '二进制'
  if (diff.kind === 'too-large') return '过大'
  if (diff.kind === 'unavailable') return '不可用'
  return `+${diff.additions} / -${diff.deletions}`
}

function fileDiffReasonLabel(reason: Extract<FileDiff, { kind: 'unavailable' }>['reason']): string {
  switch (reason) {
    case 'conflicted': return '文件存在冲突'
    case 'missing': return '文件已不存在'
    case 'unsupported': return '不支持此类差异'
    case 'inspection-failed': return '差异读取失败'
  }
}

function artifactReasonLabel(reason: Extract<TaskArtifactSnapshot, { availability: 'unavailable' }>['reason']): string {
  switch (reason) {
    case 'workspace-unavailable': return '工作区不可用'
    case 'unsupported-workspace': return '暂不支持此工作区'
    case 'invalid-baseline': return '任务基线无效'
    case 'baseline-missing': return '缺少任务基线'
    case 'baseline-mismatch': return '任务基线不匹配'
    case 'workspace-changed': return '工作区版本已变化'
    case 'inspection-failed': return '成果检查失败'
  }
}

function diffLineMarker(kind: TextDiffLine['kind']): string {
  if (kind === 'added') return '+'
  if (kind === 'removed') return '-'
  if (kind === 'note') return '\\'
  return ' '
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(bytes % 1_048_576 === 0 ? 0 : 1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KB`
  return `${bytes} B`
}

function shortVersion(version: string): string {
  return version.length > 14 ? `${version.slice(0, 7)}...${version.slice(-4)}` : version
}
