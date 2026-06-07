import * as fs from 'fs'
import path from 'path'
import puppeteer from 'rebrowser-puppeteer'
import { delay, write_log, TaskPauseError, TaskAbortError } from '#utils/index'
import { toomicsBrowser } from '#api/browser'

/** 登录按钮的 Tailwind 样式类名，用于检测 cookie 是否过期 */
const LOGIN_BUTTON_CLASS = /flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs

/**
 * Toomics 浏览器会话管理
 *
 * 职责：
 *   1. 启动 Puppeteer 浏览器实例
 *   2. 加载/保存 cookie
 *   3. 检测 cookie 过期并自动重新登录（邮箱+密码方式）
 *   4. 清除旧章节缓存，避免磁盘累积
 *   5. 提供手机号验证弹框检测（静态方法）
 */
export class ToomicsBrowserSession {
  private domain = 'https://toomics.com'
  private langTag: string
  private userName: string
  private passWord: string
  private config: any

  constructor(opts: {
    langTag: string
    userName: string
    passWord: string
    config: any
  }) {
    this.langTag = opts.langTag
    this.userName = opts.userName
    this.passWord = opts.passWord
    this.config = opts.config
  }

  /**
   * 浏览器初始化 & cookie 加载 & 登录检测
   *
   * 流程：
   *   1. 启动浏览器 → 加载 cookie → 清除旧章节缓存
   *   2. 打开首页，检测是否需要重新登录（登录按钮可见 = cookie 过期）
   *   3. 若过期：关闭弹窗 → 菜单 → 登录 → 填表 → 提交 → 验证结果
   *   4. 切换成人模式 → 保存 cookie → 关闭页面
   *
   * @returns 是否成功初始化
   */
  async init(): Promise<boolean> {
    if (!toomicsBrowser.browser?.connected) {
      await toomicsBrowser.init()
    }
    if (!toomicsBrowser.browser) return false

    await toomicsBrowser.get_cookie()

    // 清除旧的章节缓存图片，避免磁盘累积
    const cacheDir = this.config.chapterCache
    if (cacheDir && fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir)
      for (const file of files) {
        fs.unlinkSync(path.join(cacheDir, file))
      }
    }

    const page = await toomicsBrowser.new_page()
    if (!page) return false

    let pendingError: any = null

    try {
      await page
        .goto(this.domain + `/${this.langTag}`, {
          waitUntil: 'networkidle2',
          timeout: 60 * 1000,
        })
        .catch(() => {})

      const homePageHtml = await page.content()

      // 检测登录按钮是否可见：可见说明 cookie 过期，需要重新登录
      if (LOGIN_BUTTON_CLASS.test(homePageHtml)) {
        write_log('[cookie] cookie 过期，尝试重新登录')
        await this.performLogin(page)
      }

      await toomicsBrowser.save_cookie()
    } catch (e) {
      pendingError = e
      throw e
    } finally {
      // 若错误携带 debugPage 则保留页面供任务队列截图，否则正常关闭
      if (!pendingError?.debugPage) {
        await page.close().catch(() => {})
      }
    }

    return true
  }

  /**
   * 执行邮箱+密码登录流程
   *
   * 步骤：关闭弹窗 → 打开菜单 → 点击登录 → 邮箱表单 → 填充凭据 → 提交 → 验证
   * 若登录完成后仍检测到登录按钮，说明凭据无效，抛出异常
   */
  private async performLogin(page: puppeteer.Page) {
    // 关闭弹窗
    await page.locator('div.close_popup').click().catch(() => {})
    await delay(2000)

    // 打开菜单（简 / 選單 兼用）
    await page.locator('button[title="菜单"], button[title="選單"]').click().catch(() => {})
    await delay(2000)

    // 点击「登录 / 登入」按钮（简繁兼用）
    await page
      .locator('button.bg-white')
      .filter((button) => {
        const t = button.innerText.trim()
        return t === '登录' || t === '登入'
      })
      .click()
      .catch(() => {})
    await delay(2000)

    // 切换到邮箱登录表单（SC 旧版按钮；TC 版在 modal 内直接就是邮箱表单，此步静默跳过）
    await page
      .locator('button[onclick="Base.changeSignInForm();"]')
      .click()
      .catch(() => {})
    await delay(2000)

    // 填充用户名和密码（SC 用 name 属性；TC modal 内用 type 属性兜底）
    await page.locator('input[name="user_id"], input[type="email"]').fill(this.userName).catch(() => {})
    await delay(1000)
    await page.locator('input[name="user_pw"], input[type="password"]').fill(this.passWord).catch(() => {})
    await delay(1000)

    // 提交登录
    await page.locator('button[type="submit"]').click().catch(() => {})
    await delay(2000)
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})

    // 验证登录结果：若登录按钮仍然可见，说明凭据无效
    const afterLoginHtml = await page.content()
    if (LOGIN_BUTTON_CLASS.test(afterLoginHtml)) {
      const err = new TaskAbortError('登录失败，请检查账号密码')
      ;(err as any).debugPage = page
      write_log('登录失败，请检查账号密码')
      throw err
    }

    // 切换成人模式（调用站点全局对象 Base.setDisplay）
    await page
      .evaluate(() => {
        const Base = (globalThis as any).Base
        Base.setDisplay('A', `/${(globalThis as any).__langTag || 'tc'}`)
      })
      .catch(() => {})
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
  }

  /**
   * 检测手机号验证弹框，若存在则暂停任务
   *
   * 检测条件（三者全部满足才触发）：
   *   1. #mobile_verify 弹框在视觉上可见
   *   2. 弹框内包含手机号验证相关的控件元素
   *   3. 弹框文本包含验证相关的关键词
   *
   * @throws TaskPauseError 当验证弹框可见时抛出，由任务调度层捕获并暂停任务
   */
  static async pauseIfMobileVerificationVisible(
    page: puppeteer.Page,
    url: string,
    mangaName: string,
    onProgress?: { message: (msg: string) => void }
  ): Promise<void> {
    const verification = await page.evaluate(() => {
      const doc = (globalThis as any).document
      const win = (globalThis as any).window
      const modal = doc.querySelector('#mobile_verify') as any
      if (!modal) return null

      const text = modal.innerText || ''
      const style = win.getComputedStyle(modal)
      const rect = modal.getBoundingClientRect()
      const visible = modal.classList.contains('in')
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
      const hasVerificationControls = Boolean(
        modal.querySelector('#phone, #sms_verify_send, #mobile_auth_verify_code')
      )
      const hasVerificationText = /请验证手机号|请输入验证码|信用卡付款时|需验证您的手机号码|获取验证码/.test(text)

      if (!visible || !hasVerificationControls || !hasVerificationText) return null

      return {
        title: (modal.querySelector('.modal_title')?.textContent || '').trim(),
        text: text.replace(/\s+/g, ' ').trim().slice(0, 160),
      }
    }).catch(() => null)

    if (!verification) return

    const message = `[toomics] ${mangaName} 打开漫画页面时检测到手机号验证码弹框，任务已暂停。请在配置页使用手动认证完成验证后再继续。页面: ${url}`
    write_log(message)
    onProgress?.message(message)
    await toomicsBrowser.save_cookie(false).catch(() => { })
    const err = new TaskPauseError(message)
    ;(err as any).debugPage = page
    throw err
  }
}
