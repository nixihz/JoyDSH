import { describe, expect, it } from 'vitest'
import type { TaskSession } from '@joydsh/domain'
import {
  archiveTask,
  archivedTasks,
  isTaskArchived,
  loadTaskArchiveState,
  restoreArchivedTask,
  saveTaskArchiveState,
  visibleTasks,
} from './task-archive-service.ts'

const tasks: TaskSession[] = [
  { id: 'active', running: false, blank: false, updatedAt: 3 },
  { id: 'older', running: false, blank: false, updatedAt: 2 },
  { id: 'newer', running: false, blank: false, updatedAt: 1 },
]

describe('任务归档状态', () => {
  it('归档幂等，并从可见任务中过滤', () => {
    const once = archiveTask({ version: 1, entries: [] }, 'older', 100)
    const twice = archiveTask(once, 'older', 200)

    expect(twice).toBe(once)
    expect(isTaskArchived(twice, 'older')).toBe(true)
    expect(visibleTasks(tasks, twice).map(task => task.id)).toEqual(['active', 'newer'])
  })

  it('按归档时间倒序展示并可恢复', () => {
    const archived = archiveTask(
      archiveTask({ version: 1, entries: [] }, 'older', 100),
      'newer',
      200,
    )

    expect(archivedTasks(tasks, archived).map(task => task.id)).toEqual(['newer', 'older'])
    expect(restoreArchivedTask(archived, 'newer').entries).toEqual([
      { taskId: 'older', archivedAt: 100 },
    ])
  })

  it('读取时忽略损坏条目和重复任务', () => {
    const storage = memoryStorage(JSON.stringify({
      version: 1,
      entries: [
        { taskId: 'older', archivedAt: 100 },
        { taskId: 'older', archivedAt: 200 },
        { taskId: '', archivedAt: 300 },
        { taskId: 'broken', archivedAt: 'now' },
      ],
    }))

    expect(loadTaskArchiveState(storage)).toEqual({
      version: 1,
      entries: [{ taskId: 'older', archivedAt: 100 }],
    })
  })

  it('未知版本回退为空状态，并持久化版本化数据', () => {
    const invalid = memoryStorage(JSON.stringify({ version: 2, entries: [] }))
    expect(loadTaskArchiveState(invalid)).toEqual({ version: 1, entries: [] })

    const storage = memoryStorage(null)
    saveTaskArchiveState({ version: 1, entries: [{ taskId: 'active', archivedAt: 10 }] }, storage)
    expect(JSON.parse(storage.value ?? '')).toEqual({
      version: 1,
      entries: [{ taskId: 'active', archivedAt: 10 }],
    })
  })
})

function memoryStorage(initial: string | null) {
  return {
    value: initial,
    getItem: () => initial,
    setItem(_key: string, value: string) {
      this.value = value
    },
  }
}
