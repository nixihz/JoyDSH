import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ArtifactMutationAvailability,
  ArtifactMutationResult,
  ArtifactOperationError,
  FileDiff,
  FileReviewAction,
  ReadyTaskArtifactSnapshot,
  TaskArtifactSnapshot,
  TaskCommitContext,
  TaskCommitResult,
  TaskFileChange,
  TaskFileChangeKind,
  TaskFileReviewState,
  UnavailableTaskArtifactSnapshot,
} from './index.ts'

const changedFile = {
  changeId: 'opaque-change-1',
  path: 'src/new-name.ts',
  previousPath: 'src/old-name.ts',
  kind: 'moved',
  review: 'pending',
  diff: {
    kind: 'text',
    additions: 1,
    deletions: 1,
    hunks: [
      {
        before: { start: 4, lines: 2 },
        after: { start: 4, lines: 2 },
        heading: 'export function answer()',
        lines: [
          { kind: 'removed', content: '  return 41', beforeLine: 5 },
          { kind: 'added', content: '  return 42', afterLine: 5 },
        ],
      },
    ],
  },
} as const satisfies TaskFileChange

const readySnapshot = {
  availability: 'ready',
  taskId: 'task-1',
  workspacePath: '/workspaces/joydsh',
  baseline: { version: 'opaque-boundary-1', capturedAt: 100 },
  inspectedAt: 200,
  snapshotToken: 'opaque-snapshot-1',
  mutation: { availability: 'ready' },
  currentVersion: 'opaque-current-2',
  clean: false,
  additions: 1,
  deletions: 1,
  changes: [changedFile],
} as const satisfies ReadyTaskArtifactSnapshot

const unavailableSnapshot = {
  availability: 'unavailable',
  taskId: 'task-2',
  workspacePath: '/workspaces/other',
  inspectedAt: 400,
  changes: [],
  reason: 'baseline-missing',
  message: '旧任务没有可用的本地成果基线',
} as const satisfies UnavailableTaskArtifactSnapshot

function describeDiff(diff: FileDiff): string {
  switch (diff.kind) {
    case 'text':
      return `${diff.additions}+ ${diff.deletions}-`
    case 'binary':
      return '二进制文件'
    case 'too-large':
      return `超过 ${diff.limitBytes} 字节`
    case 'unavailable':
      return `${diff.reason}: ${diff.message}`
  }
}

function snapshotAvailability(snapshot: TaskArtifactSnapshot): string {
  if (snapshot.availability === 'ready') {
    return snapshot.clean ? '无变更' : `${snapshot.changes.length} 个文件`
  }
  return `${snapshot.reason}: ${snapshot.message}`
}

function mutationAvailability(mutation: ArtifactMutationAvailability): string {
  if (mutation.availability === 'ready') return '可操作'
  return `${mutation.reason}: ${mutation.message}`
}

function operationRecovery(error: ArtifactOperationError): string {
  switch (error.code) {
    case 'stale-snapshot':
    case 'head-advanced':
    case 'repository-busy':
    case 'conflicted':
    case 'change-not-found':
    case 'unreviewed-changes':
    case 'nothing-to-commit':
      return `刷新 ${error.latestSnapshot.taskId}`
    case 'unsupported':
    case 'operation-failed':
      return error.latestSnapshot === undefined
        ? error.message
        : `刷新 ${error.latestSnapshot.taskId}`
  }
}

describe('任务成果领域契约', () => {
  it('用面向用户的状态表达移动文件和结构化文本差异', () => {
    expectTypeOf<TaskFileChangeKind>().toEqualTypeOf<
      'created' | 'modified' | 'deleted' | 'moved' | 'copied' | 'type-changed' | 'conflicted'
    >()
    expect(changedFile).toMatchObject({
      changeId: 'opaque-change-1',
      kind: 'moved',
      path: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
      review: 'pending',
    })
    expect(changedFile.diff.hunks[0]?.lines).toEqual([
      { kind: 'removed', content: '  return 41', beforeLine: 5 },
      { kind: 'added', content: '  return 42', afterLine: 5 },
    ])
  })

  it('完整区分文本、二进制、过大和不可用差异', () => {
    const variants = [
      changedFile.diff,
      { kind: 'binary' },
      { kind: 'too-large', limitBytes: 2_097_152 },
      { kind: 'unavailable', reason: 'conflicted', message: '文件存在未解决冲突' },
    ] as const satisfies readonly FileDiff[]

    expect(variants.map(describeDiff)).toEqual([
      '1+ 1-',
      '二进制文件',
      '超过 2097152 字节',
      'conflicted: 文件存在未解决冲突',
    ])
  })

  it('成果快照按可用性收窄，并为可用快照携带汇总', () => {
    expectTypeOf(readySnapshot).toMatchTypeOf<TaskArtifactSnapshot>()
    expectTypeOf(unavailableSnapshot).toMatchTypeOf<TaskArtifactSnapshot>()

    expect(snapshotAvailability(readySnapshot)).toBe('1 个文件')
    expect(snapshotAvailability(unavailableSnapshot)).toBe(
      'baseline-missing: 旧任务没有可用的本地成果基线',
    )
    expect(readySnapshot).toMatchObject({
      clean: false,
      additions: 1,
      deletions: 1,
      snapshotToken: 'opaque-snapshot-1',
      mutation: { availability: 'ready' },
    })
    expect(unavailableSnapshot).not.toHaveProperty('baseline')
  })

  it('区分文件评审动作、评审状态和成果变更可用性', () => {
    expectTypeOf<FileReviewAction>().toEqualTypeOf<'accept' | 'reject'>()
    expectTypeOf<TaskFileReviewState>().toEqualTypeOf<'pending' | 'accepted'>()

    const availabilities = [
      { availability: 'ready' },
      {
        availability: 'blocked',
        reason: 'task-running',
        message: '任务仍在运行',
      },
      {
        availability: 'blocked',
        reason: 'head-advanced',
        message: '任务边界之后的版本已变化',
      },
      {
        availability: 'blocked',
        reason: 'conflicted',
        message: '存在冲突成果',
      },
      {
        availability: 'blocked',
        reason: 'unsupported',
        message: '当前工作空间不支持成果变更',
      },
    ] as const satisfies readonly ArtifactMutationAvailability[]

    expect(availabilities.map(mutationAvailability)).toEqual([
      '可操作',
      'task-running: 任务仍在运行',
      'head-advanced: 任务边界之后的版本已变化',
      'conflicted: 存在冲突成果',
      'unsupported: 当前工作空间不支持成果变更',
    ])
  })

  it('成果变更与提交结果始终返回最新快照', () => {
    const mutationResult = {
      affectedChangeIds: ['opaque-change-1'],
      latestSnapshot: readySnapshot,
    } as const satisfies ArtifactMutationResult
    const commitContext = {
      taskId: 'task-1',
      workspacePath: '/workspaces/joydsh',
      snapshotToken: 'opaque-snapshot-1',
      acceptedChangeIds: ['opaque-change-1'],
      additions: 1,
      deletions: 1,
      message: 'feat: 完成任务成果',
    } as const satisfies TaskCommitContext
    const commitResult = {
      revision: 'opaque-revision-3',
      message: commitContext.message,
      committedAt: 300,
      committedChangeIds: commitContext.acceptedChangeIds,
      latestSnapshot: {
        ...readySnapshot,
        snapshotToken: 'opaque-snapshot-2',
        currentVersion: 'opaque-revision-3',
        clean: true,
        additions: 0,
        deletions: 0,
        changes: [],
      },
    } as const satisfies TaskCommitResult

    expect(mutationResult.latestSnapshot.taskId).toBe('task-1')
    expect(commitResult).toMatchObject({
      revision: 'opaque-revision-3',
      committedChangeIds: ['opaque-change-1'],
      latestSnapshot: { clean: true, changes: [] },
    })
  })

  it('结构化操作错误通过错误码收窄需要刷新的最新快照', () => {
    const errors = [
      {
        code: 'stale-snapshot',
        message: '成果快照已过期',
        latestSnapshot: readySnapshot,
      },
      {
        code: 'repository-busy',
        message: '成果正在被其他操作修改',
        latestSnapshot: {
          ...readySnapshot,
          mutation: {
            availability: 'blocked',
            reason: 'task-running',
            message: '任务仍在运行',
          },
        },
      },
      {
        code: 'operation-failed',
        message: '成果操作失败',
      },
      {
        code: 'nothing-to-commit',
        message: '没有可提交的成果',
        latestSnapshot: {
          ...readySnapshot,
          clean: true,
          additions: 0,
          deletions: 0,
          changes: [],
        },
      },
    ] as const satisfies readonly ArtifactOperationError[]

    expect(errors.map(operationRecovery)).toEqual([
      '刷新 task-1',
      '刷新 task-1',
      '成果操作失败',
      '刷新 task-1',
    ])
  })
})
