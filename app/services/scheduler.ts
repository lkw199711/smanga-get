import * as fs from 'fs'
import path from 'path'
import type { taskType } from '#type/index.js'
import { delay, get_config, write_log, dataRoot } from '#utils/index'
import { randomInt } from '#utils/human'
import { now } from '#utils/time'

/**
 * 任务调度器接口
 * 在 MangaTask 执行流程中嵌入调度控制点，
 * 后续反爬模型（时间窗口、冷却、每日配额等）通过实现此接口接入。
 */
export interface TaskScheduler {
  /**
   * 任务执行前调用
   * 可用于等待时间窗口、检查每日配额等阻塞操作
   * @param task 即将执行的任务
   */
  beforeTask(task: taskType): Promise<void>

  /**
   * 任务执行后调用
   * 可用于记录执行历史、更新每日计数等
   * @param task 刚完成的任务
   * @param success 是否执行成功
   */
  afterTask(task: taskType, success: boolean): Promise<void>

  /**
   * 是否应继续执行下一个任务
   * @returns false 时中断任务循环
   */
  shouldContinue(): boolean
}

/**
 * 直通调度器（无操作桩）
 * 当前行为不变——所有钩子为空操作，永远继续执行。
 * 用于非 toomics 任务或不启用反爬模型的场景。
 */
export class PassThroughScheduler implements TaskScheduler {
  async beforeTask(_task: taskType): Promise<void> {
    // no-op
  }

  async afterTask(_task: taskType, _success: boolean): Promise<void> {
    // no-op
  }

  shouldContinue(): boolean {
    return true
  }
}

// ── AntiBotScheduler 状态持久化 ────────────────────────────

interface SchedulerState {
  currentDay: string          // 跟踪的日期（用于跨日重置）
  todayDownloaded: number     // 今日已下载章节数
  skipToday: boolean          // 今日是否随机跳过
  sessionStartTime: number    // 当前会话开始时间戳（0 = 无活动会话）
  lastSessionEndTime: number  // 上次会话结束时间戳（用于冷却计算）
}

const STATE_FILE = path.join(dataRoot, 'data', 'scheduler-state.json')

function readState(): SchedulerState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    }
  } catch {
    write_log('[AntiBotScheduler] 读取调度状态失败，使用默认值')
  }

  return {
    currentDay: '',
    todayDownloaded: 0,
    skipToday: false,
    sessionStartTime: 0,
    lastSessionEndTime: 0,
  }
}

function writeState(state: SchedulerState): void {
  try {
    const dir = path.dirname(STATE_FILE)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // 静默失败，不影响主流程
  }
}

// ── 时间窗口工具 ────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

interface TimeWindow {
  start: string  // "HH:MM"
  end: string    // "HH:MM"
}

function getDayName(timestamp: number): string {
  return DAY_NAMES[new Date(timestamp).getDay()]
}

function minutesOfDay(timestamp: number): number {
  const d = new Date(timestamp)
  return d.getHours() * 60 + d.getMinutes()
}

function parseTime(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

/**
 * 核心调度器：AntiBotScheduler
 *
 * 实现反爬行为模型 v2 的调度层：
 *   - 每日独立时间窗口（不同天故意错开，避免规律）
 *   - 窗口随机抖动（±windowJitterMinutes）
 *   - 12% 概率跳过当天
 *   - 每日章节下载配额
 *   - 单次会话时长上限
 *   - 会话间冷却时间
 *
 * 状态持久化到 scheduler-state.json，跨进程重启保持连续性。
 */
export class AntiBotScheduler implements TaskScheduler {
  private state: SchedulerState
  private config: any
  private initialized = false
  /** 当前任务是否为 toomics 任务（由 beforeTask 设置，供 shouldContinue 判断） */
  private currentTaskIsToomics = false

  constructor() {
    this.state = readState()
    this.config = get_config('toomics') || {}
  }

  // ── TaskScheduler 接口实现 ──────────────────────────────

  async beforeTask(task: taskType): Promise<void> {
    // 仅对 toomics 任务生效，其他网站直通；antiBotEnabled=false 时也直通
    this.currentTaskIsToomics = this.isToomicsTask(task)
    if (!this.currentTaskIsToomics || !this.isAntiBotEnabled()) return

    this.ensureInitialized()

    if (this.state.skipToday) {
      write_log('[AntiBotScheduler] 今日随机跳过，任务暂停')
      return
    }

    // 检查每日配额
    if (this.state.todayDownloaded >= this.getTodayQuota()) {
      write_log(
        `[AntiBotScheduler] 今日配额已满 (${this.state.todayDownloaded}/${this.getTodayQuota()})`
      )
      return
    }

    // 检查时间窗口
    if (!this.isInTimeWindow()) {
      const currentTime = new Date().toLocaleTimeString()
      write_log(`[AntiBotScheduler] 当前时间 ${currentTime} 不在允许窗口内`)
      return
    }

    // 开始新会话（如果需要）
    if (this.state.sessionStartTime === 0) {
      await this.startSession()
    }
  }

  async afterTask(task: taskType, success: boolean): Promise<void> {
    if (!this.isToomicsTask(task) || !this.isAntiBotEnabled()) return
    if (!this.ensureInitialized()) return

    if (success) {
      this.state.todayDownloaded++
      write_log(
        `[AntiBotScheduler] 今日进度: ${this.state.todayDownloaded}/${this.getTodayQuota()}`
      )
    }

    this.persist()
  }

  shouldContinue(): boolean {
    // 非 toomics 任务或反爬开关关闭时，不受调度器限制，始终继续
    if (!this.currentTaskIsToomics || !this.isAntiBotEnabled()) return true

    if (!this.ensureInitialized()) return false

    if (this.state.skipToday) {
      write_log('[AntiBotScheduler] 今日跳过，停止执行')
      return false
    }

    // 检查每日配额
    if (this.state.todayDownloaded >= this.getTodayQuota()) {
      write_log(
        `[AntiBotScheduler] 今日配额已满 (${this.state.todayDownloaded}/${this.getTodayQuota()})，停止执行`
      )
      return false
    }

    // 检查会话时长
    if (this.state.sessionStartTime > 0) {
      const elapsed = Date.now() - this.state.sessionStartTime
      const maxMs = (this.config.sessionMaxMinutes || 45) * 60 * 1000

      if (elapsed >= maxMs) {
        write_log(
          `[AntiBotScheduler] 会话已进行 ${Math.round(elapsed / 60000)} 分钟，达到上限 ${this.config.sessionMaxMinutes || 45} 分钟`
        )
        this.endSession()
        return false
      }
    }

    // 检查冷却时间
    if (this.state.lastSessionEndTime > 0) {
      const cooldownMs = (this.config.cooldownMinutes || 120) * 60 * 1000
      const sinceLastSession = Date.now() - this.state.lastSessionEndTime

      if (sinceLastSession < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - sinceLastSession) / 60000)
        write_log(`[AntiBotScheduler] 冷却中，剩余 ${remaining} 分钟`)
        return false
      }
    }

    // 检查是否在时间窗口内
    if (!this.isInTimeWindow()) {
      write_log('[AntiBotScheduler] 时间窗口已结束，停止执行')
      this.endSession()
      return false
    }

    return true
  }

  // ── 内部方法 ────────────────────────────────────────────

  private isToomicsTask(task: taskType): boolean {
    const w = task.website || ''
    return w === 'toomics' || w.startsWith('toomics-')
  }

  /** 检查反爬调度是否启用（配置项 antiBotEnabled，默认 true） */
  private isAntiBotEnabled(): boolean {
    return this.config.antiBotEnabled !== false
  }

  /** 确保每日状态已初始化（跨日重置） */
  private ensureInitialized(): boolean {
    const today = new Date().toDateString()

    // 跨日重置
    if (this.state.currentDay !== today) {
      this.state.currentDay = today
      this.state.todayDownloaded = 0
      this.state.sessionStartTime = 0
      this.state.lastSessionEndTime = 0

      // 随机跳过判定
      const skipProb = this.config.skipDayProbability ?? 0.12
      this.state.skipToday = Math.random() < skipProb

      if (this.state.skipToday) {
        write_log(`[AntiBotScheduler] 今日抽中跳过 (概率 ${(skipProb * 100).toFixed(0)}%)`)
      }

      this.persist()
    }

    if (!this.initialized) {
      this.initialized = true
      write_log(
        `[AntiBotScheduler] 初始化完成 | 日期: ${today} | 已下载: ${this.state.todayDownloaded} | 配额: ${this.getTodayQuota()} | 跳过: ${this.state.skipToday}`
      )
    }

    return !this.state.skipToday
  }

  /** 开始新会话：加入随机延迟，模拟"歇一会儿再看" */
  private async startSession(): Promise<void> {
    const jitterMin = this.config.windowJitterMinutes || 30
    const jitterMs = randomInt(0, jitterMin * 60 * 1000)

    if (jitterMs > 0) {
      write_log(`[AntiBotScheduler] 窗口内随机延迟 ${(jitterMs / 1000).toFixed(0)} 秒`)
      await delay(jitterMs)
    }

    this.state.sessionStartTime = Date.now()
    write_log(`[AntiBotScheduler] 新会话开始 ${new Date().toLocaleTimeString()}`)
    this.persist()
  }

  /** 结束当前会话，记录结束时间以触发冷却 */
  private endSession(): void {
    this.state.lastSessionEndTime = Date.now()
    this.state.sessionStartTime = 0
    this.persist()
  }

  /** 检查当前时间是否在每日允许窗口中 */
  private isInTimeWindow(): boolean {
    const dayName = getDayName(Date.now())
    const windows: TimeWindow[] = this.config.dailyWindows?.[dayName] || []

    if (windows.length === 0) {
      // 当天未配置窗口 → 允许全天执行
      return true
    }

    const currentMin = minutesOfDay(Date.now())

    for (const w of windows) {
      const startMin = parseTime(w.start)
      const endMin = parseTime(w.end)

      if (currentMin >= startMin && currentMin <= endMin) {
        return true
      }
    }

    return false
  }

  /** 获取今天的章节配额 */
  private getTodayQuota(): number {
    const dayName = getDayName(Date.now())
    const quota = this.config.dailyQuota || {}
    return quota[dayName] || 12
  }

  /** 持久化当前状态 */
  private persist(): void {
    writeState(this.state)
  }
}
