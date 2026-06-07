/**
 * 容器时间校验模块
 *
 * 在 Docker 容器等环境中，系统时间可能出现漂移。
 * 调度器依赖精确时间来执行时间窗口检查，
 * 因此需要周期性从外部 HTTP 源校验时间。
 *
 * 策略：
 *   - 轮询多个外部 HTTP 源（通过 Date 响应头）
 *   - 缓存结果 30 分钟避免频繁网络请求
 *   - 检测漂移 > 2 分钟时记录告警日志
 *   - 外部源全部失败时回退到本地时间
 */

import Axios from 'axios'
import { write_log } from '#utils/index'

// ── 外部时间源（按优先级排列，请求开销最低） ──────────────────
const TIME_SOURCES = [
  'https://www.google.com',
  'https://www.baidu.com',
  'https://www.microsoft.com',
]

// ── 缓存 ──────────────────────────────────────────────────────
interface TimeCache {
  timestamp: number    // 外部获取到的时间戳
  fetchedAt: number    // 本地获取时刻
}

let timeCache: TimeCache | null = null
const CACHE_TTL_MS = 30 * 60 * 1000  // 30 分钟

/**
 * 从外部 HTTP 源获取时间（通过 Date 响应头）
 * @returns 时间戳（毫秒），全部失败返回 null
 */
async function fetchExternalTime(): Promise<number | null> {
  for (const url of TIME_SOURCES) {
    try {
      const response = await Axios.head(url, { timeout: 5000 })
      const dateHeader = response.headers['date']
      if (dateHeader) {
        const timestamp = new Date(dateHeader).getTime()
        if (!isNaN(timestamp)) {
          return timestamp
        }
      }
    } catch {
      // 尝试下一个源
    }
  }

  return null
}

/**
 * 获取经过外部校验的当前时间
 *
 * 优先使用外部时间源，缓存 30 分钟。
 * 外部源全部失败时回退到本地时间（并记录日志）。
 *
 * @returns 当前时间戳（毫秒）
 */
export async function getExternalTime(): Promise<number> {
  // 缓存命中 & 未过期 → 返回缓存 + 本地流逝量
  if (timeCache && Date.now() - timeCache.fetchedAt < CACHE_TTL_MS) {
    return timeCache.timestamp + (Date.now() - timeCache.fetchedAt)
  }

  const externalTimestamp = await fetchExternalTime()

  if (externalTimestamp) {
    const localNow = Date.now()

    // 检测漂移
    const drift = Math.abs(localNow - externalTimestamp)
    if (drift > 2 * 60 * 1000) {
      write_log(`[time] ⚠️ 容器时间漂移 ${Math.round(drift / 1000)} 秒，已自动校正`)
    }

    timeCache = { timestamp: externalTimestamp, fetchedAt: localNow }
    return externalTimestamp
  }

  // 所有外部源不可达 → 回退本地时间
  write_log('[time] 无法获取外部时间，使用本地时间')
  return Date.now()
}

/**
 * 校验容器时间是否在可接受漂移范围内
 *
 * 注意：此函数每次都会发起一次网络请求（不走缓存），
 * 建议仅在调度器首次启动时调用。
 *
 * @returns true = 时间正常，false = 漂移过大
 */
export async function validateTime(): Promise<boolean> {
  const externalTime = await fetchExternalTime()

  // 无法验证 → 假定正常（避免阻塞启动）
  if (!externalTime) {
    return true
  }

  const drift = Math.abs(Date.now() - externalTime)
  if (drift > 2 * 60 * 1000) {
    write_log(`[time] ❌ 容器时间漂移严重 (${Math.round(drift / 1000)} 秒)，建议检查系统时间`)
    return false
  }

  return true
}

/**
 * 获取当前时间（经外部校验，带缓存）
 *
 * 便捷封装：先校验，不可用时回退本地时间。
 * 适合调度器中所有需要"当前时间"的场景。
 */
export async function now(): Promise<number> {
  return getExternalTime()
}
