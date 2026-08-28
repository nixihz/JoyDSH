import { describe, expect, it } from 'vitest'
import {
  ArtifactOperationException,
  artifactUnavailableReason,
  mapArtifactOperationFailure,
  mapInspection,
  mapTaskArtifactCommitResult,
  mapTaskCommitProposalResolution,
} from './artifact-service.ts'

describe('任务成果适配', () => {
  it('把 Git 状态和结构化差异转换成领域语义', () => {
    const snapshot = mapInspection('task-1', '/workspace', 200, {
      baseline: { repositoryRoot: '/workspace', revision: 'base-1', capturedAt: 100 },
      snapshotToken: 'snapshot-v1-server-token',
      mutation: { availability: 'blocked', reason: 'head-advanced', message: 'HEAD 已前进' },
      inspection: {
        repositoryRoot: '/workspace',
        baselineRevision: 'base-1',
        headRevision: 'head-2',
        clean: false,
        changes: [
        {
          changeId: 'change-v1-renamed',
          review: 'accepted',
          path: 'src/new.ts',
          previousPath: 'src/old.ts',
          status: 'renamed',
          similarity: 90,
          diff: {
            kind: 'text',
            additions: 1,
            deletions: 1,
            hunks: [{
              oldStart: 2,
              oldLines: 1,
              newStart: 2,
              newLines: 1,
              heading: 'answer',
              lines: [
                { kind: 'deletion', content: 'return 41', oldLine: 2 },
                { kind: 'addition', content: 'return 42', newLine: 2 },
                { kind: 'no-newline-marker', content: '\\ No newline at end of file' },
              ],
            }],
          },
        },
        {
          changeId: 'change-v1-created',
          review: 'pending',
          path: 'created.txt',
          status: 'untracked',
          diff: { kind: 'binary' },
        },
        ],
      },
    })

    expect(snapshot).toMatchObject({
      availability: 'ready',
      baseline: { version: 'base-1', capturedAt: 100 },
      snapshotToken: 'snapshot-v1-server-token',
      mutation: { availability: 'blocked', reason: 'head-advanced' },
      currentVersion: 'head-2',
      additions: 1,
      deletions: 1,
      changes: [
        {
          changeId: 'change-v1-renamed',
          kind: 'moved',
          review: 'accepted',
          diff: {
            kind: 'text',
            hunks: [{
              lines: [
                { kind: 'removed', beforeLine: 2 },
                { kind: 'added', afterLine: 2 },
                { kind: 'note' },
              ],
            }],
          },
        },
        { changeId: 'change-v1-created', kind: 'created', review: 'pending', diff: { kind: 'binary' } },
      ],
    })
  })

  it('把后端错误归一成稳定原因码', () => {
    expect(artifactUnavailableReason('该任务没有本地成果基线')).toBe('baseline-missing')
    expect(artifactUnavailableReason('路径不是 Git 工作区')).toBe('unsupported-workspace')
    expect(artifactUnavailableReason('工作区已有未提交变更')).toBe('invalid-baseline')
    expect(artifactUnavailableReason('任务基线属于其他 Git 工作区')).toBe('baseline-mismatch')
    expect(artifactUnavailableReason('Git 检查失败')).toBe('inspection-failed')
  })

  it('保留结构化写操作错误和服务端最新快照', () => {
    const failure = mapArtifactOperationFailure({
      code: 'stale-snapshot',
      message: '成果已经变化，请重新检查',
      latestSnapshot: {
        baseline: { repositoryRoot: '/workspace', revision: 'base-1', capturedAt: 100 },
        snapshotToken: 'snapshot-v1-latest',
        mutation: { availability: 'ready' },
        inspection: {
          repositoryRoot: '/workspace',
          baselineRevision: 'base-1',
          headRevision: 'base-1',
          clean: true,
          changes: [],
        },
      },
    }, 'task-1', '/workspace', 300)

    expect(failure).toBeInstanceOf(ArtifactOperationException)
    expect(failure.message).toBe('成果已经变化，请重新检查')
    expect(failure.code).toBe('stale-snapshot')
    expect(failure.latestSnapshot).toMatchObject({
      availability: 'ready',
      snapshotToken: 'snapshot-v1-latest',
      clean: true,
    })
    expect(String(failure)).not.toContain('[object Object]')
  })

  it('统一解析嵌套与扁平的提交说明提案', () => {
    const proposal = {
      proposalId: 'proposal-1',
      taskId: 'task-1',
      workspacePath: '/workspace',
      snapshotToken: 'snapshot-1',
      acceptedChangeIds: ['change-1'],
      additions: 3,
      deletions: 1,
      message: 'feat: 完成成果提交',
    }

    expect(mapTaskCommitProposalResolution({ status: 'ready', proposal })).toEqual({
      status: 'ready',
      proposal,
    })
    expect(mapTaskCommitProposalResolution({ status: 'ready', ...proposal })).toEqual({
      status: 'ready',
      proposal,
    })
  })

  it('拒绝缺少关键字段的提交响应', () => {
    expect(() => mapTaskCommitProposalResolution({ status: 'ready', proposalId: 'proposal-1' }))
      .toThrow('提交说明提案没有返回提交说明')
    expect(() => mapTaskCommitProposalResolution({ status: 'mystery' }))
      .toThrow('未知的提交说明提案状态')
    expect(() => mapTaskArtifactCommitResult({ status: 'generating' }))
      .toThrow('提交成果没有返回完成状态')
  })

  it('解析最终提交版本并兼容内核直接返回', () => {
    expect(mapTaskArtifactCommitResult({ status: 'completed', revision: 'commit-1' }))
      .toEqual({ revision: 'commit-1' })
    expect(mapTaskArtifactCommitResult({ revision: 'commit-2' }))
      .toEqual({ revision: 'commit-2' })
    expect(mapTaskArtifactCommitResult({ revision: 'commit-3', warning: '  状态收尾异常  ' }))
      .toEqual({ revision: 'commit-3', warning: '状态收尾异常' })
    expect(() => mapTaskArtifactCommitResult({ revision: 'commit-4', warning: ' ' }))
      .toThrow('提交成果警告格式无效')
  })
})
