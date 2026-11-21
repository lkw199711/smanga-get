import type { UseBrowser } from '#api/browser'

export const GENTLEMAN_AUTH_CHECK_URL = 'https://www.wnacg.ru/albums-index-cate-38.html'

export type GentlemanAccessState = 'authenticated' | 'login-required' | 'unexpected'

export type GentlemanAccessResult = {
  state: GentlemanAccessState
  status: number
  title: string
  url: string
  reason: string
}

/**
 * 根据韩漫分类页反馈判断登录态。
 *
 * 匿名访问目前会返回 HTTP 200，因此不能只看状态码；正常页面则必须包含
 * Gentleman 列表页的结构标记。其他内容归为 unexpected，避免把安全验证或
 * 站点故障误报为 Cookie 失效。
 */
export function inspectGentlemanAccessPage(
  html: string,
  options: { status?: number; title?: string; url?: string } = {}
): GentlemanAccessResult {
  const status = options.status ?? 0
  const title = options.title ?? ''
  const url = options.url ?? GENTLEMAN_AUTH_CHECK_URL
  const pageText = `${title}\n${html}`

  if (
    /您要訪問的漫畫不存在[！!]?/.test(html)
    && /點擊這裡登錄|点击这里登录/.test(html)
  ) {
    return {
      state: 'login-required',
      status,
      title,
      url,
      reason: '韩漫分类页要求登录',
    }
  }

  if (
    [403, 429, 503].includes(status)
    || /just a moment|checking your browser|请稍候|正在进行安全验证|cf-chl|challenge-platform|ray id/i.test(pageText)
  ) {
    return {
      state: 'unexpected',
      status,
      title,
      url,
      reason: `站点安全验证或限流 (HTTP ${status || 'unknown'})`,
    }
  }

  if (/gallary_wrap/i.test(html) && /\/photos-index-aid-\d+\.html/i.test(html)) {
    return {
      state: 'authenticated',
      status,
      title,
      url,
      reason: '韩漫分类页可访问',
    }
  }

  return {
    state: 'unexpected',
    status,
    title,
    url,
    reason: `韩漫分类页返回了无法识别的内容 (HTTP ${status || 'unknown'})`,
  }
}

/** 使用浏览器当前 Cookie 访问韩漫分类页并返回登录态。 */
export async function probeGentlemanAccess(browser: UseBrowser): Promise<GentlemanAccessResult> {
  const page = await browser.new_page()
  if (!page) throw new Error('无法创建 Gentleman 登录检查页面')

  try {
    const response = await page.goto(GENTLEMAN_AUTH_CHECK_URL, {
      waitUntil: 'networkidle2',
      timeout: 60 * 1000,
    })
    const [html, title] = await Promise.all([
      page.content(),
      page.title().catch(() => ''),
    ])

    return inspectGentlemanAccessPage(html, {
      status: response?.status() ?? 0,
      title,
      url: page.url(),
    })
  } finally {
    await page.close().catch(() => {})
  }
}
