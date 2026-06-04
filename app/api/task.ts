import type { subsribeType, taskProgressType, runningTaskType, taskType } from '#type/index.js';
import fs from 'fs'
import { toomicsBrowser, bilibiliBrowser, toomicsBrowserNoUser, omegascansBrowser } from '#api/browser';

const taskFile = process.cwd() + '/task.json'
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
export function task_add({ tasks, website, id, name }: { tasks: subsribeType[], website: string, name: string, id: number }) {
  const task = task_read()
  if (tasks) {
    task.push(...tasks)
  } else {
    task.push({ website, id, name })
  }

  task_write(task)
}

/**
 * 移除订阅
 * @param param0
 */
export function task_remove({ website, id }: { website: string, id: number }) {
  const task = task_read()
  const index = task.findIndex((item: any) => item.website === website && item.id === id)
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

  protected clearCurrentTask() {
    this.runningTask = null
  }

  add(task: taskType) {
    this.tasks.push(task)
    this.run()
  }

  remove(mangaId: number) {
    const index = this.tasks.findIndex((item) => item.id === mangaId)
    if (index !== -1) {
      this.tasks.splice(index, 1)
      task_write(this.tasks)
    }
  }

  clear() {
    this.tasks = []
  }
}

import Toomics from '#services/toomics'
import Bilibili from '#services/bilibili'
import Omegascans from '#services/omegascans'
import { end_app, shut_down, write_log } from '#utils/index';
import ToomicsDayUpdate from '#services/toomics-update';
import ToomicsAll from '#services/toomics-all';
import ToZip from '#services/tozip';
import OmegaScansUpdate from '#services/omegascans-update';
import SyncCloud from '#services/sync-cloud';
class BilibiliTask extends Task {
  constructor(tasks: taskType[]) {
    super(tasks)
  }

  async run() {
    if (this.tasks.length === 0) {
      this.clearCurrentTask()
      return;
    }
    if (this.running) return;

    this.running = true
    const task = this.tasks.shift()

    if (!task) {
      this.running = false
      this.clearCurrentTask()
      return
    }

    this.startCurrentTask(task, '执行 Bilibili 任务')
    const reporter = this.createChapterReporter()
    const bilibili = new Bilibili(task, reporter)
    let taskFailed = false

    await bilibili.start()
      .catch((err) => {
        taskFailed = true
        this.failCurrentTask(err)
        bilibili.browser?.close()
        write_log(`[Bilibili] ${task.id} ${task.name} 任务执行失败: ${err.message}`)
      })

    if (!taskFailed) {
      this.finishCurrentTask('Bilibili 任务执行完成')
    }

    this.running = false

    await this.run()
  }
}

class ToomicsTask extends Task {
  constructor(tasks: taskType[]) {
    super(tasks)
  }

  async run() {
    if (this.tasks.length === 0) {
      this.clearCurrentTask()
      return;
    }
    if (this.running) return;

    this.running = true
    const task = this.tasks.shift()

    if (!task) {
      this.running = false
      this.clearCurrentTask()
      return
    }

    this.startCurrentTask(task, '执行 Toomics 任务')
    const reporter = this.createChapterReporter()
    const toomics = new Toomics(task, reporter)
    let taskFailed = false
    await toomics.start()
      .catch((err) => {
        taskFailed = true
        this.failCurrentTask(err)
        write_log(`[Toomics] ${task.id} ${task.name} 任务执行失败: ${err.message}`)
        // 任务放到末尾再次执行
        this.tasks.push(task)
      })

    if (!taskFailed) {
      this.finishCurrentTask('Toomics 任务执行完成')
    }

    this.running = false

    await this.run()
  }
}

class OmegascansTask extends Task {
  running = 0;
  private concurrency: number = 1;
  constructor(tasks: taskType[]) {
    super(tasks)
  }

  async run() {
    if (this.tasks.length === 0) {
      if (this.running === 0) this.clearCurrentTask()
      return;
    }
    if (this.running >= this.concurrency) {
      return;
    }

    this.running++;
    const task = this.tasks.shift()

    if (!task) {
      this.running--
      this.clearCurrentTask()
      return
    }

    this.startCurrentTask(task, '执行 OmegaScans 任务')
    const reporter = this.createChapterReporter()
    const omegascans = new Omegascans(task, reporter)
    let taskFailed = false
    await omegascans.start()
      .catch((err) => {
        taskFailed = true
        this.failCurrentTask(err)
        write_log(`[Omegascans] ${task?.id} ${task.name} 任务执行失败: ${err?.message}`)
        // 任务放到末尾再次执行
        this.tasks.push(task)
      })

    if (!taskFailed) {
      this.finishCurrentTask('OmegaScans 任务执行完成')
    }

    this.running--;

    await this.run()
  }
}

class MangaTask extends Task {
  taskErrors = 0
  constructor(tasks: taskType[]) {
    super(tasks)
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

    this.startCurrentTask(task, '准备任务服务')
    const reporter = this.createChapterReporter()
    let taskService;
    switch (task.website) {
      case 'toomics':
        taskService = new Toomics(task, reporter);
        break;
      case 'bilibili':
        taskService = new Bilibili(task, reporter);
        break;
      case 'omegascans':
        taskService = new Omegascans(task, reporter);
        break;
      case 'gentleman':
        console.log('执行绅士漫画任务')
        taskService = new (await import('#services/gentleman')).default(task, reporter);
        break;
      case 'omegascans-update':
        taskService = new OmegaScansUpdate({}, reporter);
        break;
      case 'toomics-update-sc':
        taskService = new ToomicsDayUpdate('sc', reporter);
        break;
      case 'toomics-update-tc':
        taskService = new ToomicsDayUpdate('tc', reporter);
        break;
      case 'toomics-covers-sc':
        taskService = new ToomicsAll('sc', false, reporter);
        break;
      case 'toomics-covers-tc':
        taskService = new ToomicsAll('tc', false, reporter);
        break;
      case 'toomics-compress-sc':
        taskService = new ToZip('toomics-sc', false, reporter);
        break;
      case 'toomics-compress-tc':
        taskService = new ToZip('toomics-tc', false, reporter);
        break;
      case 'omegascans-compress':
        taskService = new ToZip('omegascans', true, reporter);
        break;
      case 'bilibili-compress':
        taskService = new ToZip('bilibili', true, reporter);
        break;
      case 'sync-toomics-sc':
        taskService = new SyncCloud('toomics-sc', '.', false, reporter);
        break;
      case 'sync-toomics-tc':
        taskService = new SyncCloud('toomics-tc', '.', false, reporter);
        break;
      case 'sync-omegascans':
        taskService = new SyncCloud('omegascans', '.', false, reporter);
        break;
      default:
        write_log(`[MangaTask] 未知网站: ${task.website}`);
        this.failCurrentTask(`未知网站: ${task.website}`)
        this.running = false;
        return;
    }

    reporter.message(`${task.website} ${task.name || task.id} 正在执行`)

    let taskFailed = false
    await taskService.start()
      .catch((err) => {
        taskFailed = true
        this.failCurrentTask(err)
        write_log(`[Task] ${task.id} ${task.name} 任务执行失败: ${err?.message || err}`)
        if (this.taskErrors > 10) {
          write_log(`[Task] 任务重试超过10次,退出`)
          return;
        }
        this.taskErrors++;
        // 任务放到末尾再次执行
        this.tasks.push(task)
      })

    if (!taskFailed) {
      this.taskErrors = 0
      this.finishCurrentTask('任务执行完成')
    }

    end_app();
    this.running = false
    await this.run()
  }
}

const bilibiliTask = new BilibiliTask([])
const toomicsTask = new ToomicsTask([])
const omegascansTask = new OmegascansTask([])
const mangaTask = new MangaTask([])

export { bilibiliTask, toomicsTask, omegascansTask, mangaTask }
