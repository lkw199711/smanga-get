import * as fs from 'fs'
import path from 'path'
import puppeteer from 'rebrowser-puppeteer'
import { delay, write_log, TaskPauseError } from '#utils/index'
import { toomicsBrowser } from '#api/browser'

/**
 * Toomics 浏览器会话管理
 * 负责浏览器初始化、cookie 检查与登录流程
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
   * 浏览器初始化 & cookie 检查 & 登录
   * @returns 是否成功初始化
   */
  async init(): Promise<boolean> {
    if (!toomicsBrowser.browser?.connected) {
      await toomicsBrowser.init()
    }

    if (!toomicsBrowser.browser) return false

    // 获取cookie
    await toomicsBrowser.get_cookie()

    // 清除旧的章节缓存
    const chapterCahceImages = fs.readdirSync(this.config.chapterCache)
    chapterCahceImages.forEach((file) => {
      const filePath = path.join(this.config.chapterCache, file)
      fs.unlinkSync(filePath)
    })

    const page = await toomicsBrowser.new_page()
    if (!page) return false

    await page
      .goto(this.domain + `/sc`, {
        waitUntil: 'networkidle2',
        timeout: 60 * 1000,
      })
      .catch(() => { })

    const homePageHtml = await page.content()
    if (
      /flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs.test(
        homePageHtml
      )
    ) {
      write_log('[cookie]cookie过期，尝试重新登录')

      // 关闭弹窗
      await page
        .locator('div.close_popup')
        .click()
        .catch(() => { })
      await delay(2000)

      // 点击菜单按钮
      await page
        .locator('button[title = "菜单"]')
        .click()
        .catch(() => { })
      await delay(2000)

      // 点击登录按钮
      await page
        .locator('button.bg-white')
        .filter((button) => button.innerText.trim() === '登录')
        .click()
        .catch(() => { })
      await delay(2000)

      // 点击使用邮箱登录
      await page
        .locator('button[onclick="Base.changeSignInForm();"]')
        .click()
        .catch(() => { })
      await delay(2000)

      // 填充用户名与密码
      await page
        .locator('input[name="user_id"]')
        .fill(this.userName)
        .catch(() => { })
      await delay(1000)
      await page
        .locator('input[name="user_pw"]')
        .fill(this.passWord)
        .catch(() => { })
      await delay(1000)

      // 点击登录按钮
      await page
        .locator('button[type="submit"]')
        .click()
        .catch(() => { })
      await delay(2000)

      // 等待导航完成
      await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => { })

      if (
        /flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs.test(
          await page?.content()
        )
      ) {
        write_log('登录失败，请检查账号密码')
        throw new Error('登录失败，请检查账号密码')
      }

      let Base: any
      await page
        .evaluate(() => {
          // 切换成人模式
          Base.setDisplay('A', '/sc')
        })
        .catch(() => { })

      await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => { })
    }

    await toomicsBrowser.save_cookie()

    // 关闭页面 避免页面过多
    await page.close().catch(() => { })

    return true
  }

  /**
   * 检测手机号验证弹框，若存在则暂停任务
   * @throws TaskPauseError 当验证弹框可见时
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
    throw new TaskPauseError(message)
  }
}
