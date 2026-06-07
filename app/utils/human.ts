import { delay } from '#utils/index'

/**
 * 生成 min ~ max 之间的随机整数（含 min，含 max）
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * 随机延迟 min ~ max 毫秒
 */
export async function randomDelay(min: number, max: number): Promise<void> {
  const ms = randomInt(min, max)
  await delay(ms)
}

// ── 阅读人格参数 ────────────────────────────────────────────

/** 阅读人格：模拟不同读者的阅读速度和习惯 */
export interface ReaderPersona {
  type: 'casual' | 'moderate' | 'avid'
  pageReadMin: number       // 文字少的页最短阅读时间（毫秒）
  pageReadMax: number       // 文字多的页最长阅读时间（毫秒）
  keyPageRatio: number      // 重点页占比（0~1）
  keyPageMin: number        // 重点页最短停留（毫秒）
  keyPageMax: number        // 重点页最长停留（毫秒）
  backFlipProb: number      // 回翻概率（0~1）
  chapterEndExtraMin: number // 章节末额外停留最短（毫秒）
  chapterEndExtraMax: number // 章节末额外停留最长（毫秒）
}

/** 默认阅读人格（moderate） */
export const DEFAULT_PERSONA: ReaderPersona = {
  type: 'moderate',
  pageReadMin: 3000,
  pageReadMax: 12000,
  keyPageRatio: 0.20,
  keyPageMin: 15000,
  keyPageMax: 40000,
  backFlipProb: 0.05,
  chapterEndExtraMin: 5000,
  chapterEndExtraMax: 15000,
}

/**
 * 模拟阅读章节的延迟时间（毫秒）
 *
 * 根据实际图片数量动态计算，融入「重点页」和「回翻」机制：
 *   - keyPageRatio 比例的页面标记为重点页，停留更长时间
 *   - backFlipProb 概率触发回翻行为，增加额外停留
 *   - 章节末尾额外停留
 *
 * @param imageCount 章节图片数量
 * @param persona 阅读人格参数，缺省使用 DEFAULT_PERSONA
 */
export async function readingDelay(
  imageCount: number,
  persona: ReaderPersona = DEFAULT_PERSONA
): Promise<void> {
  let total = 0

  for (let i = 0; i < imageCount; i++) {
    // 重点页机制：keyPageRatio 比例的页面标记为重点页
    if (Math.random() < persona.keyPageRatio) {
      total += randomInt(persona.keyPageMin, persona.keyPageMax)
    } else {
      total += randomInt(persona.pageReadMin, persona.pageReadMax)
    }

    // 回翻行为：backFlipProb 概率回翻确认剧情
    if (Math.random() < persona.backFlipProb) {
      total += randomInt(3000, 8000)
    }
  }

  // 章节末尾额外停留
  total += randomInt(persona.chapterEndExtraMin, persona.chapterEndExtraMax)

  // 最大延迟 300 秒（5 分钟）
  await delay(Math.min(total, 300000))
}

/**
 * 章节间浏览延迟：模拟翻目录、思考下一步的时间（8~20 秒）
 */
export async function betweenChapterDelay(): Promise<void> {
  await randomDelay(8000, 20000)
}

/**
 * 漫画间延迟：切换到下一部漫画的间隔（15~45 秒）
 */
export async function betweenMangaDelay(): Promise<void> {
  await randomDelay(15000, 45000)
}

/**
 * 人类化滚动的选项
 */
export interface HumanScrollOptions {
  /** 基础滚动步长（像素），会在此值 0.6~1.4 倍范围随机 */
  scrollStep: number
  /** 基础滚动延迟（毫秒），会在此值 0.7~1.5 倍范围随机 */
  scrollDelay: number
  /** 执行滚动的 Puppeteer Page 对象 */
  page: any
}

/**
 * 模拟人类滚动行为：
 * - 步长随机变化
 * - 延迟随机变化
 * - 偶尔停顿（模拟看画面）
 * - 偶尔回滚一小段（模拟回头重看）
 */
export async function humanScroll(options: HumanScrollOptions): Promise<void> {
  const { page } = options
  let scrollY = -1
  let scrollCount = 0

  while (true) {
    let protocolError = false

    // 步长在 0.6~1.4 倍范围内随机
    const stepFloat = 0.6 + Math.random() * 0.8
    const step = Math.round(options.scrollStep * stepFloat)

    await page.mouse.wheel({ deltaY: step }).catch(() => {
      protocolError = true
    })

    // 延迟在 0.7~1.5 倍范围内随机
    const delayFloat = 0.7 + Math.random() * 0.8
    const delayMs = Math.round(options.scrollDelay * delayFloat)
    await delay(delayMs)

    const nowScrollY = await page.evaluate(() => (globalThis as any).window.scrollY).catch(() => {
      protocolError = true
    })

    if (protocolError) continue

    if (nowScrollY === scrollY) break
    scrollY = nowScrollY
    scrollCount++

    // 每 5~8 次滚动，有 30% 概率停顿 1~3 秒（模拟看画面）
    if (scrollCount >= 5 && scrollCount % randomInt(5, 8) === 0) {
      if (Math.random() < 0.3) {
        await randomDelay(1000, 3000)
      }
    }

    // 10% 概率回滚一小段（模拟回头重看）
    if (Math.random() < 0.1) {
      const backStep = -Math.round(options.scrollStep * (0.3 + Math.random() * 0.4))
      await page.mouse.wheel({ deltaY: backStep }).catch(() => {})
    }
  }
}

/**
 * 模拟人类鼠标移动：贝塞尔曲线平滑移动，模拟真实鼠标轨迹
 *
 * - 使用二次贝塞尔曲线路径（起点 → 控制点 → 终点）
 * - 5~15 个中间步骤
 * - 每步间隔 10~30ms
 * - 有小幅过冲和回正（Fitts' Law 特征）
 */
export async function humanMouseMove(
  page: any,
  targetX: number,
  targetY: number
): Promise<void> {
  // 获取当前鼠标位置（近似）
  const startX = randomInt(300, 1500)
  const startY = randomInt(200, 1200)

  // 贝塞尔控制点：在起点和终点之间加入随机偏移
  const cpX = (startX + targetX) / 2 + randomInt(-150, 150)
  const cpY = (startY + targetY) / 2 + randomInt(-150, 150)

  const steps = randomInt(5, 15)

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    // 二次贝塞尔：B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
    const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * targetX
    const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * targetY

    await page.mouse.move(Math.round(x), Math.round(y)).catch(() => {})
    await randomDelay(10, 30)
  }

  // Fitts' Law 特征：小幅过冲后回正
  if (Math.random() < 0.4) {
    const overshootX = targetX + randomInt(-20, 20)
    const overshootY = targetY + randomInt(-20, 20)
    await page.mouse.move(overshootX, overshootY).catch(() => {})
    await randomDelay(30, 60)
    await page.mouse.move(targetX, targetY).catch(() => {})
  }
}

/**
 * 随机鼠标移动：在页面中心区域附近随机移动鼠标
 * @deprecated 使用 humanMouseMove 获得更真实的贝塞尔曲线轨迹
 */
export async function randomMouseMove(page: any): Promise<void> {
  const targetX = randomInt(300, 1500)
  const targetY = randomInt(200, 1200)
  await humanMouseMove(page, targetX, targetY)
}

// ── 足迹模式滚动 ────────────────────────────────────────────

/**
 * 足迹模式滚动（Fast Scroll）
 *
 * 用于 pretendNum 回翻章节和噪声浏览。
 * 快速向页面底部滚动，不等待 networkIdle，不关心图片是否加载。
 * 仅产生网络请求足迹——服务端日志能看到"请求了这些 URL"，
 * 但无法确认图片是否完整渲染，因此足够伪装为正常浏览。
 *
 * @param page Puppeteer Page 对象
 * @param durationMs 滚动持续时间（毫秒），到达底部后提前停止
 * @param scrollStep 滚动步长（像素），默认 800
 * @param scrollDelay 滚动间隔（毫秒），默认 400
 */
export async function fastScroll(
  page: any,
  durationMs: number,
  scrollStep = 800,
  scrollDelay = 400
): Promise<void> {
  const startTime = Date.now()
  let lastScrollY = -1

  while (Date.now() - startTime < durationMs) {
    const step = Math.round(scrollStep * (0.7 + Math.random() * 0.6)) // 0.7~1.3 倍随机
    const delayMs = Math.round(scrollDelay * (0.6 + Math.random() * 0.8)) // 0.6~1.4 倍随机

    await page.mouse.wheel({ deltaY: step }).catch(() => {})
    await delay(delayMs)

    // 检测是否到达底部
    const scrollY = await page.evaluate(() => (globalThis as any).window.scrollY).catch(() => lastScrollY)
    if (typeof scrollY === 'number' && scrollY === lastScrollY) {
      break // 已到底部
    }
    lastScrollY = scrollY
  }
}
