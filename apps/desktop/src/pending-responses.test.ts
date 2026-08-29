import { describe, expect, it } from 'vitest'
import { createTaskProjection } from '@joydsh/task-projection'
import { collectPendingResponses } from './pending-responses.ts'

describe('待回应聚合', () => {
  it('聚合前台与后台任务并优先排列前台任务', () => {
    const projections = {
      foreground: {
        ...createTaskProjection('foreground'),
        pendingQuestions: [{ requestId: 'question-1', questions: [] }],
      },
      background: {
        ...createTaskProjection('background'),
        pendingPlanReviews: [{
          requestId: 'review-1',
          id: 'review',
          question: '是否执行？',
          plan: '# 方案',
          approve: { label: '批准' },
          decline: { label: '拒绝' },
        }],
      },
    }

    const queue = collectPendingResponses(
      ['background', 'foreground'],
      projections,
      'foreground',
    )

    expect(queue.questions[0]).toMatchObject({ taskId: 'foreground' })
    expect(queue.planReviews[0]).toMatchObject({ taskId: 'background' })
  })
})
