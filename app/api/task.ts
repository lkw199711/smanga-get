import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { runningTaskType, subsribeType, taskProgressType, taskType } from '#type/index.js'
import {
  bilibiliBrowser,
  gentlemanBrowser,
  omegascansBrowser,
  toomicsBrowser,
  toomicsBrowserNoUser,
} from '#api/browser'
import Bilibili from '#services/bilibili'
import OmegaScansUpdate from '#services/omegascans-update'
import Omegascans from '#services/omegascans'
import { PassThroughScheduler, AntiBotScheduler, type TaskScheduler } from '#services/scheduler'
import SyncCloud from '#services/sync-cloud'
import Toomics from '#services/toomics'
import ToomicsAll from '#services/toomics-all'
import ToomicsDayUpdate from '#services/toomics-update'
import ToZip from '#services/tozip'
import {
  captureErrorSnapshot,
  dataRoot,
  end_app,
  get_config,
  isTaskAbortError,
  isTaskPauseError,
  isTaskSkipError,
  shut_down,
  write_log,
} from '#utils/index'

const taskFile = path.join(dataRoot || '', 'data', 'task.json')
const maxRetryCount = 10

// ── 优先级缓存 ────────────────────────────────────────────

type PriorityLevel = 'high' | 'medium' | 'low'

interface PriorityCache {
  highIds: Set<number>
  mediumIds: Set<number>
  threshold: number
}

let priorityCache: PriorityCache = {
  highIds: new Set(),
  mediumIds: new Set(),
  threshold: 3,
}

/** 判断是否为 toomics 相关网站的任务 */
function isToomicsWebsite(website: string): boolean {
  return website === 'toomics' || website.startsWith('toomics-')
}

/** 读取 toomics.priority 配置（同步，纯文件读取） */
function readPriorityConfig(): { highPriorityIds: number[]; autoUpgradeThreshold: number } {
  const toomicsConfig = get_config('toomics') || {}
  const priority = toomicsConfig.priority || {}
  return {
    highPriorityIds: (Array.isArray(priority.highPriorityIds) ? priority.highPriorityIds : []) as number[],
    autoUpgradeThreshold: (typeof priority.autoUpgradeThreshold === 'number' ? priority.autoUpgradeThreshold : 3),
  }
}

/** 根据任务 ID 判断优先级（使用缓存） */
function resolveTaskPriority(task: taskType): PriorityLevel {
  const mangaId = typeof task.id === 'number' ? task.id : Number(task.id)
  if (!Number.isFinite(mangaId) || mangaId <= 0) return 'low'

  if (priorityCache.highIds.has(mangaId)) return 'high'
  if (priorityCache.mediumIds.has(mangaId)) return 'medium'
  return 'low'
}

/** 从缓存重新加载 HIGH 优先级配置（同步，无需 DB 查询） */
export function refreshHighPriorityCache(): void {
  const { highPriorityIds, autoUpgradeThreshold } = readPriorityConfig()
  priorityCache = {
    highIds: new Set(highPriorityIds),
    mediumIds: priorityCache.mediumIds,
    threshold: autoUpgradeThreshold,
  }
}

/** 异步刷新 MEDIUM 优先级缓存（查询 manga_results 表） */
export async function refreshMediumPriorityCache(): Promise<void> {
  const { autoUpgradeThreshold } = readPriorityConfig()
  priorityCache.threshold = autoUpgradeThreshold

  try {
    const db = await import('@adonisjs/lucid/services/db')
    const rows = await db.default.rawQuery(
      `SELECT mr.\`id\`, mr.\`chapter_count\`,
        COALESCE((SELECT COUNT(*) FROM manga_chapters mc WHERE mc.manga_result_id = mr.\`id\`), 0) AS indexed_count
       FROM manga_results mr
       WHERE mr.website LIKE 'toomics%'`
    ) as any[]

    const mediumIds = new Set<number>()
    const parsed = Array.isArray(rows) ? rows : (rows[0] || [])
    for (const row of parsed) {
      const mangaId = Number(row.id)
      const chapterCount = Number(row.chapter_count) || 0
      const indexedCount = Number(row.indexed_count) || 0
      if (Number.isFinite(mangaId) && chapterCount - indexedCount >= autoUpgradeThreshold) {
        mediumIds.add(mangaId)
      }
    }

    priorityCache = { ...priorityCache, mediumIds }
    write_log(`[Task] MEDIUM 优先级缓存已刷新，${mediumIds.size} 部漫画自动提级（阈值 >= ${autoUpgradeThreshold} 话）`)
  } catch (error) {
    write_log(`[Task] MEDIUM 优先级缓存刷新失败: ${error instanceof Error ? error.message : error}`)
  }
}

type TaskIdentifier = number | string
type TaskRunResult = 'success' | 'failed' | 'paused' | 'aborted'
type TaskService = {
  start(): Promise<void> | void
}
type TaskServiceFactory = (
  task: taskType,
  reporter: ChapterReporter
) => Promise<TaskService | null> | TaskService | null
type ChapterReporter = {
  setTotal(total: number): void
  report(message: string): void
  message(message: string): void
  subProgress(current: number, total: number): void
}
type TaskAddOptions = {
  tasks?: subsribeType[]
  website?: string
  name?: string
  id?: TaskIdentifier
}
type TaskRemoveOptions = {
  website?: string
  id?: TaskIdentifier
  name?: string
  taskId?: string
  url?: string
}

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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isPresent(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function normalizeId(id: unknown) {
  return isPresent(id) ? String(id).trim() : ''
}

function safeLog(message: string) {
  try {
    write_log(message)
  } catch {
    console.warn(message)
  }
}

function taskHasRealMangaId(task: Partial<taskType>) {
  if (noMangaIdWebsites.has(task.website ?? '')) return false
  if (task.id === null || task.id === undefined || task.id === '') return false
  if (typeof task.id === 'number' && (!Number.isFinite(task.id) || task.id <= 0)) return false
  if (typeof task.id === 'string' && !task.id.trim()) return false

  return true
}

// taskId 是队列内部身份，不再覆盖原始 id，避免订阅删除和 service 参数被污染。
function ensureTaskIdentity(task: taskType): taskType {
  return {
    ...task,
    taskId: task.taskId || randomUUID(),
  }
}

function getTaskIdentity(task: Partial<taskType>) {
  if (task.taskId) return `task:${task.taskId}`

  if (taskHasRealMangaId(task)) {
    return [
      'manga',
      task.website ?? '',
      normalizeId(task.id),
      task.name ?? '',
      task.url ?? '',
    ].join('\u0000')
  }

  return ['job', task.website ?? '', task.name ?? '', task.url ?? ''].join('\u0000')
}

function isSameTask(item: taskType, target: TaskRemoveOptions) {
  if (target.taskId) return item.taskId === target.taskId
  if (target.website && item.website !== target.website) return false

  if (isPresent(target.url) && isPresent(item.url)) {
    return item.url === target.url
  }

  if (target.website === 'gentleman' && isPresent(target.name)) {
    return item.name === target.name
  }

  if (isPresent(target.id) && isPresent(item.id)) {
    return normalizeId(item.id) === normalizeId(target.id)
  }

  if (isPresent(target.name)) {
    return item.name === target.name
  }

  return false
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

function ensureTaskFileDir() {
  fs.mkdirSync(path.dirname(taskFile), { recursive: true })
}

function backupInvalidTaskFile() {
  if (!fs.existsSync(taskFile)) return

  const backupFile = `${taskFile}.invalid-${Date.now()}`
  fs.copyFileSync(taskFile, backupFile)
  safeLog(`[task] 任务文件解析失败，已备份到 ${backupFile}`)
}

function readTaskFile(): taskType[] {
  if (!fs.existsSync(taskFile)) {
    return []
  }

  try {
    const jsonStr = fs.readFileSync(taskFile, 'utf-8').trim()
    if (!jsonStr) return []

    const json = JSON.parse(jsonStr)
    if (!Array.isArray(json)) {
      safeLog('[task] 任务文件不是数组，已按空列表处理')
      return []
    }

    return json.map((task) => ensureTaskIdentity(task))
  } catch (error) {
    backupInvalidTaskFile()
    safeLog(`[task] 读取任务文件失败: ${getErrorMessage(error)}`)

    return []
  }
}

function writeTaskFile(tasks: taskType[]) {
  ensureTaskFileDir()

  const tempFile = `${taskFile}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(tasks, null, 2), 'utf-8')
  fs.renameSync(tempFile, taskFile)
}

/**
 * 读取历史任务文件。
 *
 * 当前实际运行队列由 mangaTask 内存队列负责；这个函数保留给旧调用方。
 */
export function task_read() {
  return readTaskFile()
}

/**
 * 写入完整历史任务文件。
 *
 * 注意：这不是运行队列持久化，只是旧文件 API 的兼容入口。
 */
export function task_write(json: taskType[]) {
  writeTaskFile(json)
}

/**
 * 旧任务文件 API：新增任务到 task.json。
 *
 * 运行中的下载队列请继续使用 mangaTask.add。
 */
export function task_add({ tasks, website, id, name }: TaskAddOptions) {
  const task = task_read()

  if (tasks?.length) {
    task.push(...tasks.map((item) => ensureTaskIdentity(item)))
  } else if (website && isPresent(id) && name !== undefined) {
    task.push(ensureTaskIdentity({ website, id: id as TaskIdentifier, name }))
  }

  task_write(task)
}

/**
 * 旧任务文件 API：从 task.json 移除一条任务。
 */
export function task_remove({ website, id, name, taskId, url }: TaskRemoveOptions) {
  const task = task_read()
  const index = task.findIndex((item) => isSameTask(item, { website, id, name, taskId, url }))

  if (index !== -1) {
    task.splice(index, 1)
    task_write(task)
  }
}

async function closeBrowser(name: string, browser?: { close(): Promise<void> } | null) {
  if (!browser) return

  await browser.close().catch((error) => {
    safeLog(`[browser] 关闭 ${name} 浏览器失败: ${getErrorMessage(error)}`)
  })
}

export async function close_all_browsers() {
  await Promise.all([
    closeBrowser('toomics', toomicsBrowser.browser),
    closeBrowser('bilibili', bilibiliBrowser.browser),
    closeBrowser('toomics-no-user', toomicsBrowserNoUser.browser),
    closeBrowser('omegascans', omegascansBrowser.browser),
    closeBrowser('gentleman', gentlemanBrowser.browser),
  ])
}

class Task {
  tasks: taskType[] = []
  running = false
  protected runningTask: runningTaskType | null = null

  constructor(tasks: taskType[]) {
    this.tasks = tasks.map((task) => ensureTaskIdentity(task))
  }

  run(): void | Promise<void> {}

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
   * 创建固定总数的进度报告器。
   *
   * 目前多数 service 使用 createChapterReporter；此方法保留给已知总数的任务。
   */
  protected createProgressReporter(total: number) {
    let completedCount = 0
    const startPercent = 5
    const endPercent = 95

    return (message: string) => {
      completedCount++
      const percent =
        total > 0
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
   * 创建可动态设置章节总数的进度报告器。
   *
   * service 可先调用 setTotal 设置总章节数，再通过 report/subProgress 推进进度。
   */
  protected createChapterReporter(): ChapterReporter {
    let completedCount = 0
    let totalChapters = 0
    const startPercent = 5
    const endPercent = 95

    const update = () => {
      const percent =
        totalChapters > 0
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
      setTotal: (total: number) => {
        totalChapters = total
        update()
      },
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
      message: (message: string) => {
        this.setProgress({ message })
      },
      subProgress: (current: number, total: number) => {
        this.setProgress({ subCurrent: current, subTotal: total })
      },
    }
  }

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

    const message = getErrorMessage(error)
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

    const message = getErrorMessage(error)
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
    const identityTask = ensureTaskIdentity(task)

    // 仅对 toomics 相关且带真实漫画 ID 的任务按优先级插入
    if (isToomicsWebsite(task.website ?? '') && taskHasRealMangaId(task)) {
      this.insertByPriority(identityTask)
    } else {
      this.tasks.push(identityTask)
    }

    void this.run()
  }

  /** 按优先级插入任务：HIGH → 头部，MEDIUM → HIGH 之后，LOW → 尾部 */
  protected insertByPriority(task: taskType): void {
    const priority = resolveTaskPriority(task)

    if (priority === 'high') {
      this.tasks.unshift(task)
      return
    }

    if (priority === 'medium') {
      // 插入到最后一个 HIGH 任务之后
      let insertIdx = 0
      for (let i = this.tasks.length - 1; i >= 0; i--) {
        if (resolveTaskPriority(this.tasks[i]) === 'high') {
          insertIdx = i + 1
          break
        }
      }
      this.tasks.splice(insertIdx, 0, task)
      return
    }

    // LOW：直接 push 到尾部
    this.tasks.push(task)
  }

  remove(target: Partial<taskType> | TaskIdentifier) {
    const removeTarget: TaskRemoveOptions =
      typeof target === 'object'
        ? {
            taskId: target.taskId,
            id: target.id,
            website: target.website,
            name: target.name,
            url: target.url,
          }
        : { id: target }

    const index = this.tasks.findIndex((item) => isSameTask(item, removeTarget))

    if (index !== -1) {
      this.tasks.splice(index, 1)
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

/**
 * 根据 task.website 创建对应的 service。
 *
 * 工厂集中在这里，MangaTask 只负责调度，不直接关心每个网站的构造细节。
 */
async function createTaskService(
  task: taskType,
  reporter: ReturnType<Task['createChapterReporter']>
): Promise<TaskService | null> {
  switch (task.website) {
    case 'toomics':
      return new Toomics(task, reporter)
    case 'bilibili':
      return new Bilibili(task, reporter)
    case 'omegascans':
      return new Omegascans(task, reporter)
    case 'gentleman': {
      const gentlemanModule = await import('#services/gentleman')
      const Gentleman = gentlemanModule.default
      return new Gentleman(task, reporter)
    }
    case 'omegascans-update':
      return new OmegaScansUpdate({}, reporter)
    case 'toomics-update-sc':
      return new ToomicsDayUpdate('sc', reporter)
    case 'toomics-update-tc':
      return new ToomicsDayUpdate('tc', reporter)
    case 'toomics-covers-sc':
      return new ToomicsAll('sc', false, reporter)
    case 'toomics-covers-tc':
      return new ToomicsAll('tc', false, reporter)
    case 'toomics-compress-sc':
      return new ToZip('toomics-sc', false, reporter)
    case 'toomics-compress-tc':
      return new ToZip('toomics-tc', false, reporter)
    case 'omegascans-compress':
      return new ToZip('omegascans', true, reporter)
    case 'bilibili-compress':
      return new ToZip('bilibili', true, reporter)
    case 'sync-toomics-sc':
      return new SyncCloud('toomics-sc', '.', false, reporter)
    case 'sync-toomics-tc':
      return new SyncCloud('toomics-tc', '.', false, reporter)
    case 'sync-omegascans':
      return new SyncCloud('omegascans', '.', false, reporter)
    default:
      return null
  }
}

export class MangaTask extends Task {
  private retryCounts = new Map<string, number>()
  private serviceFactory: TaskServiceFactory
  scheduler: TaskScheduler

  constructor(tasks: taskType[], serviceFactory: TaskServiceFactory = createTaskService) {
    super(tasks)
    this.serviceFactory = serviceFactory
    this.scheduler = new AntiBotScheduler()
  }

  async run() {
    if (this.running) return

    this.running = true

    try {
      while (true) {
        const task = this.tasks.shift()

        if (!task) {
          await this.finishQueue()
          return
        }

        const result = await this.runTask(task)
        if (result === 'paused' || result === 'aborted') return

        if (!this.scheduler.shouldContinue()) {
          write_log('[MangaTask] 调度器要求暂停，停止任务循环')
          return
        }
      }
    } finally {
      this.running = false
    }
  }

  private async finishQueue() {
    write_log('[MangaTask] 所有任务执行完毕')
    await close_all_browsers()
    this.clearCurrentTask()
    this.shutdownSafely()
  }

  private async runTask(task: taskType): Promise<TaskRunResult> {
    this.startCurrentTask(task, '等待调度')

    let result: TaskRunResult = 'failed'
    let shouldRunCleanup = true

    try {
      await this.scheduler.beforeTask(task)
      this.setProgress({
        stage: '准备任务服务',
        message: `${task.website} ${task.name || task.id} 正在准备`,
      })

      const reporter = this.createChapterReporter()
      const taskService = await this.serviceFactory(task, reporter)

      if (!taskService) {
        const error = new Error(`未知网站: ${task.website}`)
        write_log(`[MangaTask] ${error.message}`)
        this.failCurrentTask(error)
        return result
      }

      reporter.message(`${task.website} ${task.name || task.id} 正在执行`)
      await taskService.start()

      result = 'success'
      this.clearRetryCount(task)
      this.finishCurrentTask('任务执行完成')

      return result
    } catch (error) {
      // ── 错误现场截图（由队列层统一管理）──
      const debugPage = (error as any)?.debugPage
      if (debugPage) {
        const label = (error as any).name === 'TaskPauseError' ? 'mobile-verify' : 'abort'
        await captureErrorSnapshot(debugPage, label).catch(() => {})
        await debugPage.close().catch(() => {})
      }

      if (isTaskPauseError(error)) {
        result = 'paused'
        shouldRunCleanup = false
        this.pauseCurrentTask(error)
        write_log(`[Task] ${task.id} ${task.name} 任务已暂停: ${getErrorMessage(error)}`)
        return result
      }

      if (isTaskSkipError(error)) {
        result = 'failed'
        this.failCurrentTask(error)
        write_log(`[Task] 跳过任务: ${getErrorMessage(error)}`)
        return result
      }

      if (isTaskAbortError(error)) {
        result = 'aborted'
        this.failCurrentTask(error)
        write_log(`[Task] 检测到异常状态，停止当前任务: ${getErrorMessage(error)}`)
        return result
      }

      this.failCurrentTask(error)
      write_log(`[Task] ${task.id} ${task.name} 任务执行失败: ${getErrorMessage(error)}`)
      this.requeueFailedTask(task)

      return result
    } finally {
      if (shouldRunCleanup) {
        await this.afterTaskSafely(task, result === 'success')
        this.endAppSafely()
      }
    }
  }

  private requeueFailedTask(task: taskType) {
    const retryKey = getTaskIdentity(task)
    const retryCount = (this.retryCounts.get(retryKey) ?? 0) + 1

    if (retryCount > maxRetryCount) {
      write_log(`[Task] ${task.id} ${task.name} 任务重试超过${maxRetryCount}次，跳过`)
      this.retryCounts.delete(retryKey)
      return
    }

    this.retryCounts.set(retryKey, retryCount)
    // 重试任务也按优先级插入
    if (isToomicsWebsite(task.website ?? '') && taskHasRealMangaId(task)) {
      this.insertByPriority(task)
    } else {
      this.tasks.push(task)
    }
  }

  private clearRetryCount(task: taskType) {
    this.retryCounts.delete(getTaskIdentity(task))
  }

  private async afterTaskSafely(task: taskType, success: boolean) {
    await this.scheduler.afterTask(task, success).catch((error) => {
      write_log(`[MangaTask] 调度器 afterTask 执行失败: ${getErrorMessage(error)}`)
    })
  }

  private endAppSafely() {
    try {
      end_app()
    } catch (error) {
      write_log(`[MangaTask] end_app 执行失败: ${getErrorMessage(error)}`)
    }
  }

  private shutdownSafely() {
    try {
      shut_down()
    } catch (error) {
      write_log(`[MangaTask] shut_down 执行失败: ${getErrorMessage(error)}`)
    }
  }
}

const mangaTask = new MangaTask([])

export { mangaTask }
