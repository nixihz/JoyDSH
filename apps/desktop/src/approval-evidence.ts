import type { TaskApproval, TaskEvent } from '@joydsh/domain'

export interface ApprovalEvidence {
  arguments: string
  command?: string
}

export function approvalEvidence(approval: TaskApproval, events: readonly TaskEvent[]): ApprovalEvidence {
  if (approval.callId === undefined) return { arguments: '未提供可关联的工具调用参数。' }
  let data: Record<string, unknown> | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    const candidate = objectRecord(event.data)
    if (candidate?.callId === approval.callId) {
      data = candidate
      break
    }
  }
  if (data === undefined || typeof data.arguments !== 'string') {
    return { arguments: '未提供可关联的工具调用参数。' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(data.arguments)
  } catch {
    return { arguments: data.arguments }
  }
  const details = objectRecord(parsed)
  const command = typeof details?.command === 'string' ? details.command : undefined
  const formatted = JSON.stringify(parsed, null, 2)
  return {
    arguments: formatted ?? data.arguments,
    ...(command === undefined ? {} : { command }),
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
