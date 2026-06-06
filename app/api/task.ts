import type { subsribeType, taskProgressType, runningTaskType, taskType } from '#type/index.js';
import fs from 'fs'
import { toomicsBrowser, bilibiliBrowser, toomicsBrowserNoUser, omegascansBrowser } from '#api/browser';
import { randomUUID } from 'node:crypto'

const taskFile = process.cwd() + '/task.json'
type TaskIdentifier = number | string

const noMangaIdWebsites = new Set([
  'toomics-covers-sc',
  'toomics-covers-tc',
  'omegascans-update',
  'toomics-update-sc',
  'toomics-update-tc',
  'toomics-compress-sc',
  'toomics-compress-tc',
  'omegascans-compress',
  'bilibili-compress',
  'sync-toomics-sc',
  'sync-toomics-tc',
  'sync-omegascans',
])

function taskHasRealMangaId(task: Partial<taskType>) {
  if (noMangaIdWebsites.has(task.website ?? '')) return false
  if (task.website === 'gentleman' && String(task.id) === '1') return false
  if (task.id === null || task.id === undefined || task.id === '') return false
  if (typeof task.id === 'number' && (!Number.isFinite(task.id) || task.id <= 0)) return false
  if (typeof task.id === 'string' && !task.id.trim()) return false

  return true
}

function ensureTaskIdentity(task: taskType): taskType {
  const taskId = task.taskId || randomUUID()
  const nextTask = { ...task, taskId }

  if (!taskHasRealMangaId(nextTask)) {
    nextTask.id = taskId
  }

  return nextTask
}

function getTaskIdentity(task: Partial<taskType>) {
  if (task.taskId) return task.taskId

  return [
    task.website ?? '',
    task.id ?? '',
    task.name ?? '',
    task.url ?? '',
  ].join('\u0000')
}

function reorderTasks(current: taskType[], ordered: taskType[]) {
  const buckets = new Map<string, taskType[]>()

  current.forEach((item) => {
    const key = getTaskIdentity(item)
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  })

  const next: taskType[] = []

  ordered.forEach((item) => {
    const key = getTaskIdentity(item)
    const bucket = buckets.get(key)
    const matched = bucket?.shift()

    if (matched) {
      next.push(matched)
    }
  })

  buckets.forEach((items) => {
    next.push(...items)
  })

  return next
}

/**
 * 读取订阅文件
 * @description: 读取订阅文件
 * @returns
 */
export function task_read() {
  const jsonStr = fs.readFileSync(taskFile, 'utf-8')
  const json = JSON.parse(jsonStr)
  return json;
}

/**
 * 写入订阅文件
 * @description: 写入订阅文件
 * @param json
 */
export function task_write(json: any) {
  fs.writeFileSync(taskFile, JSON.stringify(json, null, 2), 'utf-8')
}

/**
 * 新增订阅
 * @param param0
 */
export function task_add({ tasks, website, id, name }: { tasks: subsribeType[], website: string, name: string, id: TaskIdentifier }) {
  const task = task_read()
  if (tasks) {
    task.push(...tasks.map((item) => ensureTaskIdentity(item)))
  } else {
    task.push(ensureTaskIdentity({ website, id, name }))
  }

  task_write(task)
}

/**
 * 移除订阅
 * @param param0
 */
export function task_remove({ website, id, name, taskId }: { website: string, id: TaskIdentifier, name?: string, taskId?: string }) {
  const task = task_read()
  const index = task.findIndex((item: any) => {
    if (taskId) return item.taskId === taskId

    return item.website === website
      && item.id === id
      && (!name || item.name === name)
  })
  if (index !== -1) {
    task.splice(index, 1)
    task_write(task)
  }
}

export async function close_all_browsers() {
  await toomicsBrowser.browser?.close();
  await bilibiliBrowser.browser?.close();
  await toomicsBrowserNoUser.browser?.close();
  await omegascansBrowser.browser?.close();
}

class Task {
  tasks: taskType[] = []
  running: boolean | number = false
  protected runningTask: runningTaskType | null = null

  constructor(tasks: taskType[]) {
    this.tasks = tasks
  }

  run() { }

  get() {
    return this.tasks
  }

  getRunning() {
    return this.runningTask
  }

  protected startCurrentTask(task: taskType, stage = '准备执行') {
    const now = new Date().toISOString()
    this.runningTask = {
      status: 'running',
      task,
      progress: {
        percent: 0,
        stage,
        message: `${task.website} ${task.name || task.id} 任务开始执行`,
        updatedAt: now,
      },
      startedAt: now,
      updatedAt: now,
    }
  }

  protected setProgress(progress: Partial<Omit<taskProgressType, 'updatedAt'>>) {
    if (!this.runningTask) return

    const now = new Date().toISOString()
    this.runningTask = {
      ...this.runningTask,
      progress: {
        ...this.runningTask.progress,
        ...progress,
        percent: Math.max(0, Math.min(progress.percent ?? this.runningTask.progress.percent, 100)),
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  /**
   * 创建进度报告回调，供 service 类在下载过程中调用
   * @param total 总章节数（从 5% 到 95% 的进度空间分配给章节下载）
   * @returns 返回 (current, message) => void
   */
  protected createProgressReporter(total: number) {
    let completedCount = 0
    const startPercent = 5
    const endPercent = 95

    return (message: string) => {
      completedCount++
      const percent = total > 0
        ? startPercent + ((endPercent - startPercent) * completedCount) / total
        : startPercent
      this.setProgress({
        percent: Math.round(percent),
        stage: '下载中',
        message,
        current: completedCount,
        total,
      })
    }
  }

  /**
   * 创建可动态设置 total 的进度报告器
   * 适用于 service 在执行中才发现总章节数的场景
   */
  protected createChapterReporter() {
    let completedCount = 0
    let totalChapters = 0
    const startPercent = 5
    const endPercent = 95

    const update = () => {
      const percent = totalChapters > 0
        ? startPercent + ((endPercent - startPercent) * completedCount) / totalChapters
        : startPercent
      this.setProgress({
        percent: Math.round(percent),
        stage: '下载中',
        current: completedCount,
        total: totalChapters,
      })
    }

    return {
      /** 设置总章节数 */
      setTotal: (total: number) => {
        totalChapters = total
        update()
      },
      /** 报告一个章节下载完成 */
      report: (message: string) => {
        completedCount++
        this.setProgress({
          stage: '下载中',
          message,
          subCurrent: undefined,
          subTotal: undefined,
        })
        update()
      },
      /** 仅更新消息，不推进计数 */
      message: (message: string) => {
        this.setProgress({ message })
      },
      /** 更新副进度（章节内图片下载进度） */
      subProgress: (current: number, total: number) => {
        this.setProgress({ subCurrent: current, subTotal: total })
      },
    }
  }

  /**
   * 更新消息而不推进进度百分比
   */
  protected updateMessage(message: string) {
    this.setProgress({ message })
  }

  protected finishCurrentTask(message = '任务执行完成') {
    if (!this.runningTask) return

    const now = new Date().toISOString()
    this.runningTask = {
      ...this.runningTask,
      status: 'success',
      progress: {
        ...this.runningTask.progress,
        percent: 100,
        stage: '执行完成',
        message,
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  protected failCurrentTask(error: unknown) {
    if (!this.runningTask) return

    const message = error instanceof Error ? error.message : String(error)
    const now = new Date().toISOString()
    this.runningTask = {
      ...this.runningTask,
      status: 'failed',
      error: message,
      progress: {
        ...this.runningTask.progress,
        stage: '执行失败',
        message,
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  protected pauseCurrentTask(error: unknown) {
    if (!this.runningTask) return

    const message = error instanceof Error ? error.message : String(error)
    const now = new Date().toISOString()
    this.runningTask = {
      ...this.runningTask,
      status: 'paused',
      error: message,
      progress: {
        ...this.runningTask.progress,
        stage: '任务已暂停',
        message,
        updatedAt: now,
      },
      updatedAt: now,
    }
  }

  protected clearCurrentTask() {
    this.runningTask = null
  }

  add(task: taskType) {
    this.tasks.push(ensureTaskIdentity(task))
    this.run()
  }

  remove(target: Partial<taskType> | TaskIdentifier) {
    const taskId = typeof target === 'object' ? target.taskId : undefined
    const mangaId = typeof target === 'object' ? target.id : target
    const website = typeof target === 'object' ? target.website : undefined
    const name = typeof target === 'object' ? target.name : undefined

    const index = this.tasks.findIndex((item) => {
      if (taskId) return item.taskId === taskId

      return item.id === mangaId
        && (!website || item.website === website)
        && (!name || item.name === name)
    })
    if (index !== -1) {
      this.tasks.splice(index, 1)
      task_write(this.tasks)
    }
  }

  reorder(tasks: taskType[]) {
    this.tasks = reorderTasks(this.tasks, tasks)

    return this.tasks
  }

  clear() {
    this.tasks = []
  }
}

import Toomics from '#services/toomics'
import Bilibili from '#services/bilibili'
import Omegascans from '#services/omegascans'
import { end_app, isTaskAbortError, isTaskPauseError, shut_down, write_log } from '#utils/index';
import ToomicsDayUpdate from '#services/toomics-update';
import ToomicsAll from '#services/toomics-all';
import ToZip from '#services/tozip';
import OmegaScansUpdate from '#services/omegascans-update';
import SyncCloud from '#services/sync-cloud';
import { PassThroughScheduler, type TaskScheduler } from '#services/scheduler';
/**
 * 根据 task.website 创建对应的 service 实例
 * 所有网站的 service 工厂集中在此，方便扩展和维护
 */
async function createTaskService(task: taskType, reporter: ReturnType<Task['createChapterReporter']>) {
  switch (task.website) {
    case 'toomics':
      return new Toomics(task, reporter);
    case 'bilibili':
      return new Bilibili(task, reporter);
    case 'omegascans':
      return new Omegascans(task, reporter);
    case 'gentleman': {
      const Gentleman = (await import('#services/gentleman')).default;
      return new Gentleman(task, reporter);
    }
    case 'omegascans-update':
      return new OmegaScansUpdate({}, reporter);
    case 'toomics-update-sc':
      return new ToomicsDayUpdate('sc', reporter);
    case 'toomics-update-tc':
      return new ToomicsDayUpdate('tc', reporter);
    case 'toomics-covers-sc':
      return new ToomicsAll('sc', false, reporter);
    case 'toomics-covers-tc':
      return new ToomicsAll('tc', false, reporter);
    case 'toomics-compress-sc':
      return new ToZip('toomics-sc', false, reporter);
    case 'toomics-compress-tc':
      return new ToZip('toomics-tc', false, reporter);
    case 'omegascans-compress':
      return new ToZip('omegascans', true, reporter);
    case 'bilibili-compress':
      return new ToZip('bilibili', true, reporter);
    case 'sync-toomics-sc':
      return new SyncCloud('toomics-sc', '.', false, reporter);
    case 'sync-toomics-tc':
      return new SyncCloud('toomics-tc', '.', false, reporter);
    case 'sync-omegascans':
      return new SyncCloud('omegascans', '.', false, reporter);
    default:
      return null;
  }
}

class MangaTask extends Task {
  taskErrors = 0
  scheduler: TaskScheduler

  constructor(tasks: taskType[]) {
    super(tasks)
    this.scheduler = new PassThroughScheduler()
  }

  async run() {

    if (this.running) {
      return;
    }

    this.running = true
    const task = this.tasks.shift()

    if (!task) {
      write_log('[MangaTask] 所有任务执行完毕')
      await close_all_browsers()
      this.running = false
      this.clearCurrentTask()
      shut_down()
      return
    }

    // 调度器：任务执行前钩子（可阻塞等待时间窗口等）
    await this.scheduler.beforeTask(task)

    this.startCurrentTask(task, '准备任务服务')
    const reporter = this.createChapterReporter()

    const taskService = await createTaskService(task, reporter)
    if (!taskService) {
      write_log(`[MangaTask] 未知网站: ${task.website}`);
      this.failCurrentTask(`未知网站: ${task.website}`)
      this.running = false;
      return;
    }

    reporter.message(`${task.website} ${task.name || task.id} 正在执行`)

    let taskFailed = false
    let taskPaused = false
    await taskService.start()
      .catch((err: unknown) => {
        if (isTaskPauseError(err)) {
          taskPaused = true
          this.pauseCurrentTask(err)
          write_log(`[Task] ${task.id} ${task.name} 任务已暂停: ${err instanceof Error ? err.message : String(err)}`)
          return
        }

        if (isTaskAbortError(err)) {
          write_log(`[Task] 检测到异常状态，清空所有任务: ${err instanceof Error ? err.message : String(err)}`)
          this.tasks = []
          this.running = false
          return
        }

        taskFailed = true
        this.failCurrentTask(err)
        write_log(`[Task] ${task.id} ${task.name} 任务执行失败: ${err instanceof Error ? err.message : String(err)}`)
        if (this.taskErrors > 10) {
          write_log(`[Task] 任务重试超过10次,退出`)
          return;
        }
        this.taskErrors++;
        // 任务放到末尾再次执行
        this.tasks.push(task)
      })

    if (taskPaused) {
      this.running = false
      return
    }

    if (!taskFailed) {
      this.taskErrors = 0
      this.finishCurrentTask('任务执行完成')
    }

    // 调度器：任务执行后钩子
    await this.scheduler.afterTask(task, !taskFailed && !taskPaused)

    end_app();
    this.running = false

    // 调度器：检查是否继续执行
    if (!this.scheduler.shouldContinue()) {
      write_log('[MangaTask] 调度器要求暂停，停止任务循环')
      return
    }

    await this.run()
  }
}

const mangaTask = new MangaTask([])

export { mangaTask }
