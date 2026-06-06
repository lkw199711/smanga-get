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

/**
 * 模拟阅读章节的延迟时间（毫秒）
 * 每张图片约 1.5~3 秒阅读时间，加上进入/退出章节的 3~8 秒
 */
export async function readingDelay(imageCount: number): Promise<void> {
  const perImage = randomInt(1500, 3000)
  const overhead = randomInt(3000, 8000)
  const total = imageCount * perImage + overhead
  // 限定最大延迟 120 秒
  await delay(Math.min(total, 120000))
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
 * 随机鼠标移动：在页面中心区域附近随机移动鼠标
 */
export async function randomMouseMove(page: any): Promise<void> {
  const x = randomInt(300, 1500)
  const y = randomInt(200, 1200)
  await page.mouse.move(x, y).catch(() => {})
  await randomDelay(200, 600)
  // 再来一次小范围移动
  const x2 = x + randomInt(-100, 100)
  const y2 = y + randomInt(-100, 100)
  await page.mouse.move(x2, y2).catch(() => {})
}
