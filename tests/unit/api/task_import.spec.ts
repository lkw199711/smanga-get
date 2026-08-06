import { test } from '@japa/runner'
import { normalizeImportedTasks } from '#api/task_import'

test.group('Task import', () => {
  test('imports a task array and removes the old taskId', ({ assert }) => {
    const tasks = normalizeImportedTasks([
      {
        website: 'gentleman',
        id: 1,
        name: 'Example',
        url: 'https://example.com/manga',
        chapterCount: 12,
        manual: true,
        taskId: 'old-task-id',
      },
    ])

    assert.deepEqual(tasks, [
      {
        website: 'gentleman',
        id: 1,
        name: 'Example',
        url: 'https://example.com/manga',
        chapterCount: 12,
        manual: true,
      },
    ])
  })

  test('rejects a non-array root', ({ assert }) => {
    assert.throws(
      () => normalizeImportedTasks({ manga: [] }),
      '导入文件的根节点必须是任务数组'
    )
  })

  test('rejects an invalid task without partially normalizing the input', ({ assert }) => {
    assert.throws(
      () => normalizeImportedTasks([{ website: 'gentleman', id: 1 }]),
      '第 1 项缺少有效的 name'
    )
  })
})
