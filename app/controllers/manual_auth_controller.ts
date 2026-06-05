import type { HttpContext } from '@adonisjs/core/http'
import { UseBrowser } from '#api/browser'
import { write_log } from '#utils/index'

const targetUrls: Record<string, string> = {
  toomics: 'https://toomics.com/sc',
  'toomics-sc': 'https://toomics.com/sc',
  'toomics-tc': 'https://toomics.com/tc',
  bilibili: 'https://manga.bilibili.com',
  omegascans: 'https://omegascans.org',
  gentleman: 'https://www.wnacg.ru',
}

const manualAuthSessions = new Map<string, UseBrowser>()

function getWebsite(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'toomics-sc'
}

export default class ManualAuthController {
  async start({ request, response }: HttpContext) {
    const website = getWebsite(request.input('website'))
    try {
      const requestedUrl = request.input('url')
      const url = typeof requestedUrl === 'string' && requestedUrl.trim()
        ? requestedUrl.trim()
        : targetUrls[website]

      if (!targetUrls[website]) {
        return response.status(400).json({
          code: 400,
          message: `不支持的手动认证站点: ${website}`,
        })
      }

      const activeSession = manualAuthSessions.get(website)
      if (activeSession?.browser && (activeSession.browser as any).connected) {
        return response.status(400).json({
          code: 400,
          message: `${website} 手动认证窗口已打开`,
        })
      }

      const browser = new UseBrowser({ website })
      manualAuthSessions.set(website, browser)
      await browser.start_manual_auth(url)
      write_log(`[manual auth] ${website} 手动认证已打开: ${url}`)

      return {
        code: 200,
        message: `${website} 手动认证窗口已打开`,
        data: { website, url },
      }
    } catch (e: any) {
      manualAuthSessions.delete(website)
      return response.status(500).json({
        code: 500,
        message: `打开手动认证失败: ${e.message}`,
      })
    }
  }

  async finish({ request, response }: HttpContext) {
    try {
      const website = getWebsite(request.input('website'))
      const browser = manualAuthSessions.get(website)

      if (!browser) {
        return response.status(400).json({
          code: 400,
          message: `${website} 手动认证窗口未打开`,
        })
      }

      await browser.finish_manual_auth()
      manualAuthSessions.delete(website)
      write_log(`[manual auth] ${website} cookie 已保存并关闭浏览器`)

      return {
        code: 200,
        message: `${website} cookie 已保存`,
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `完成手动认证失败: ${e.message}`,
      })
    }
  }
}
