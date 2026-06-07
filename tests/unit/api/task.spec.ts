import { test } from '@japa/runner'
import { MangaTask, task_read, task_remove, task_write } from '#api/task'
import type { taskType } from '#type/index.js'
import { TaskAbortError, TaskPauseError } from '#utils/index'
import { resetTestDataDir } from '#tests/helpers/test_data_dir'

function makeTask(params: Partial<taskType> = {}): taskType {
  return {
    website: params.website ?? 'unit-test',
    id: params.id ?? 1,
    name: params.name ?? '测试任务',
    url: params.url,
    taskId: params.taskId,
  }
}

function stopAfterCurrentTask(taskQueue: MangaTask) {
  taskQueue.scheduler = {
    async beforeTask() {},
    async afterTask() {},
    shouldContinue() {
      return false
    },
  }
}

function usePassThroughScheduler(taskQueue: MangaTask) {
  taskQueue.scheduler = {
    async beforeTask() {},
    async afterTask() {},
    shouldContinue() {
      return true
    },
  }
}

test.group('task queue', (group) => {
  group.each.setup(() => {
    resetTestDataDir()
  })

  test('历史任务文件不存在时返回空数组', ({ assert }) => {
    assert.deepEqual(task_read(), [])
  })

  test('读取历史任务文件时会补 taskId 且不覆盖原始 id', ({ assert }) => {
    task_write([makeTask({ website: 'omegascans-update', id: 0, name: '扫描任务' })])

    const tasks = task_read()

    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, 0)
    assert.notEqual(tasks[0].taskId, undefined)
  })

  test('旧任务文件 API 可按 taskId 删除', ({ assert }) => {
    task_write([
      makeTask({ taskId: 'task-a', id: 1, name: 'A' }),
      makeTask({ taskId: 'task-b', id: 2, name: 'B' }),
    ])

    task_remove({ website: 'unit-test', id: 1, taskId: 'task-a' })

    const tasks = task_read()

    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].taskId, 'task-b')
  })

  test('内存队列删除任务时不依赖被改写后的 id', ({ assert }) => {
    const taskQueue = new MangaTask([
      makeTask({ website: 'gentleman', id: 1, name: 'A' }),
      makeTask({ website: 'gentleman', id: 2, name: 'B' }),
    ])

    taskQueue.remove({ website: 'gentleman', id: 1, name: 'A' })

    assert.deepEqual(
      taskQueue.get().map((task) => task.name),
      ['B']
    )
  })

  test('任务成功后保留成功运行态', async ({ assert }) => {
    const taskQueue = new MangaTask([makeTask()], () => ({
      async start() {},
    }))
    stopAfterCurrentTask(taskQueue)

    await taskQueue.run()

    assert.equal(taskQueue.running, false)
    assert.equal(taskQueue.getRunning()?.status, 'success')
    assert.equal(taskQueue.get().length, 0)
  })

  test('TaskPauseError 会暂停当前任务且不会继续调度', async ({ assert }) => {
    const taskQueue = new MangaTask([makeTask()], () => ({
      async start() {
        throw new TaskPauseError('需要人工验证')
      },
    }))

    await taskQueue.run()

    assert.equal(taskQueue.running, false)
    assert.equal(taskQueue.getRunning()?.status, 'paused')
    assert.equal(taskQueue.getRunning()?.error, '需要人工验证')
  })

  test('TaskAbortError 会清空队列并标记当前任务失败', async ({ assert }) => {
    const taskQueue = new MangaTask(
      [makeTask({ id: 1, name: 'A' }), makeTask({ id: 2, name: 'B' })],
      () => ({
        async start() {
          throw new TaskAbortError('连续空章节')
        },
      })
    )

    await taskQueue.run()

    assert.equal(taskQueue.running, false)
    assert.equal(taskQueue.get().length, 0)
    assert.equal(taskQueue.getRunning()?.status, 'failed')
    assert.equal(taskQueue.getRunning()?.error, '连续空章节')
  })

  test('普通失败会按单个任务重试，超过上限后跳过', async ({ assert }) => {
    let startCount = 0
    const taskQueue = new MangaTask([makeTask()], () => ({
      async start() {
        startCount++
        throw new Error('下载失败')
      },
    }))
    usePassThroughScheduler(taskQueue)

    await taskQueue.run()

    assert.equal(startCount, 11)
    assert.equal(taskQueue.running, false)
    assert.equal(taskQueue.get().length, 0)
  })
})
