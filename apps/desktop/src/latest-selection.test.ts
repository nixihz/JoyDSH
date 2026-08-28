import { describe, expect, it } from 'vitest'
import { createLatestSelection } from './latest-selection.ts'

describe('latest selection', () => {
  it('只允许最后一次异步选择提交结果', async () => {
    const selection = createLatestSelection()
    const committed: string[] = []
    let finishFirst: (() => void) | undefined

    const restore = async (taskId: string, wait: Promise<void>) => {
      const attempt = selection.begin()
      await wait
      if (selection.isCurrent(attempt)) committed.push(taskId)
    }

    const firstWait = new Promise<void>(resolve => {
      finishFirst = resolve
    })
    const firstRestore = restore('session-a', firstWait)
    await restore('session-b', Promise.resolve())
    finishFirst?.()
    await firstRestore

    expect(committed).toEqual(['session-b'])
  })

  it('失效后拒绝正在进行的恢复结果', async () => {
    const selection = createLatestSelection()
    const attempt = selection.begin()

    selection.invalidate()

    expect(selection.isCurrent(attempt)).toBe(false)
  })
})
