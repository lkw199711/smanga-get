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
    const bilibili = new Bilibili(task)
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
    const toomics = new Toomics(task)
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
    const omegascans = new Omegascans(task)
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
    let taskService;
    switch (task.website) {
      case 'toomics':
        taskService = new Toomics(task);
        break;
      case 'bilibili':
        taskService = new Bilibili(task);
        break;
      case 'omegascans':
        taskService = new Omegascans(task);
        break;
      case 'gentleman':
        console.log('执行绅士漫画任务')
        taskService = new (await import('#services/gentleman')).default(task);
        break;
      case 'omegascans-update':
        taskService = new OmegaScansUpdate({});
        break;
      case 'toomics-update-sc':
        taskService = new ToomicsDayUpdate('sc');
        break;
      case 'toomics-update-tc':
        taskService = new ToomicsDayUpdate('tc');
        break;
      case 'toomics-covers-sc':
        taskService = new ToomicsAll('sc');
        break;
      case 'toomics-covers-tc':
        taskService = new ToomicsAll('tc');
        break;
      case 'toomics-compress-sc':
        taskService = new ToZip('toomics-sc');
        break;
      case 'toomics-compress-tc':
        taskService = new ToZip('toomics-tc');
        break;
      case 'omegascans-compress':
        taskService = new ToZip('omegascans', true);
        break;
      case 'bilibili-compress':
        taskService = new ToZip('bilibili', true);
        break;
      case 'sync-toomics-sc':
        taskService = new SyncCloud('toomics-sc');
        break;
      case 'sync-toomics-tc':
        taskService = new SyncCloud('toomics-tc');
        break;
      case 'sync-omegascans':
        taskService = new SyncCloud('omegascans');
        break;
      default:
        write_log(`[MangaTask] 未知网站: ${task.website}`);
        this.failCurrentTask(`未知网站: ${task.website}`)
        this.running = false;
        return;
    }

    this.setProgress({
      percent: 5,
      stage: '执行中',
      message: `${task.website} ${task.name || task.id} 正在执行`,
    })

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
