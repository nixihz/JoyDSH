import type { TaskApproval, TaskPlanReview, TaskQuestionRequest } from '@joydsh/domain'
import type { TaskProjection } from '@joydsh/task-projection'

export interface TaskPendingItem<T> {
  taskId: string
  item: T
}

export interface PendingResponseQueue {
  approvals: readonly TaskPendingItem<TaskApproval>[]
  questions: readonly TaskPendingItem<TaskQuestionRequest>[]
  planReviews: readonly TaskPendingItem<TaskPlanReview>[]
}

export function collectPendingResponses(
  taskIds: readonly string[],
  projections: Readonly<Record<string, TaskProjection>>,
  activeTaskId?: string,
): PendingResponseQueue {
  const orderedTaskIds = activeTaskId === undefined
    ? taskIds
    : [activeTaskId, ...taskIds.filter(taskId => taskId !== activeTaskId)]
  const approvals: TaskPendingItem<TaskApproval>[] = []
  const questions: TaskPendingItem<TaskQuestionRequest>[] = []
  const planReviews: TaskPendingItem<TaskPlanReview>[] = []

  for (const taskId of orderedTaskIds) {
    const projection = projections[taskId]
    if (projection === undefined) continue
    approvals.push(...projection.pendingApprovals.map(item => ({ taskId, item })))
    questions.push(...projection.pendingQuestions.map(item => ({ taskId, item })))
    planReviews.push(...projection.pendingPlanReviews.map(item => ({ taskId, item })))
  }

  return { approvals, questions, planReviews }
}
