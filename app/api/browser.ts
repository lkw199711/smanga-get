import puppeteer from 'rebrowser-puppeteer'
import fs from 'node:fs'
import { end_app, get_config, get_config_path, write_log } from '#utils/index'
import crypto from 'node:crypto'
import path from 'node:path'

type BrowserOptions = {
  nouser?: boolean
  website?: string
}

type WebsiteConfig = {
  cookieFile?: string
  cookieFileNoUser?: string
  coverCache?: string
}

type CookieFallback = {
  domain: string
  env: string
}

const defaultParams: Required<BrowserOptions> = {
  nouser: false,
  website: 'toomics',
}

// 目前只有 Toomics 支持从环境变量初始化 cookie。
// 其他站点应使用各自配置的 cookie 文件。
const cookieFallbacks: Record<string, CookieFallback> = {
  'toomics': { domain: '.toomics.com', env: 'TOOMICS_COOKIE' },
  'toomics-sc': { domain: '.toomics.com', env: 'TOOMICS_COOKIE' },
  'toomics-tc': { domain: '.toomics.com', env: 'TOOMICS_COOKIE' },
  'toomics-en': { domain: '.toomics.com', env: 'TOOMICS_COOKIE' },
}

// 这些广告/追踪域名经常让页面保持忙碌，导致 networkidle 等待不稳定。
const adDomains = [
  'magsrv.com',
  'pubadx.one',
  'bkcdn.net',
  'exoclick.com',
  'wpncdn.com',
  'juicyads.com',
  'trafficjunky.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googletagmanager.com',
  'googleadservices.com',
  'google-analytics.com',
]

// 集中维护扩展名和 MIME 的映射，方便磁盘缓存命中时返回真实 content-type。
const imageMimeByExtension: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
}

// 缓存路径使用 URL 哈希，避免斜杠和查询参数污染文件名。
function createSafeDirname(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex')
}

function getImageExtension(contentType: string): string {
  const mimeType = contentType.split(';')[0].trim().toLowerCase()
  const match = Object.entries(imageMimeByExtension).find(([, mime]) => mime === mimeType)

  return match?.[0] ?? '.bin'
}

function getUrlImageExtension(url: string): string {
  return (
    url.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff|ico)(?=($|[?#]))/i)?.[0].toLowerCase() ??
    '.bin'
  )
}

function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()

  return imageMimeByExtension[ext] ?? 'application/octet-stream'
}

// 旧缓存可能用不同扩展名保存，这里尝试一组可能的候选路径。
function getCachePathCandidates(cacheDir: string, imageUrl: string): string[] {
  const imageKey = createSafeDirname(imageUrl)
  const urlExt = getUrlImageExtension(imageUrl)
  const extensions = Array.from(new Set([urlExt, ...Object.keys(imageMimeByExtension)]))

  return extensions.map((ext) => path.join(cacheDir, `${imageKey}${ext}`))
}

// 浏览器初始化可能早于日志文件创建，日志失败不应影响浏览器流程。
function safeLog(message: string) {
  try {
    write_log(message)
  } catch {
    console.warn(message)
  }
}

// cookie 文件属于用户状态；文件缺失或内容损坏时按空 cookie 处理。
function readCookieFile(cookieFile: string) {
  try {
    if (!fs.existsSync(cookieFile)) return []

    const cookieText = fs.readFileSync(cookieFile, 'utf-8').trim()
    if (!cookieText) return []

    const cookies = JSON.parse(cookieText)

    return Array.isArray(cookies) ? cookies : []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    safeLog(`[cookie] Failed to read ${cookieFile}: ${message}`)

    return []
  }
}

// 将原始 "a=b; c=d" cookie 字符串转换为 Puppeteer cookie 对象。
function parseCookieString(cookieStr: string, domain: string) {
  if (!cookieStr.trim()) return []

  return cookieStr
    .split(';')
    .map((pair) => {
      const separatorIndex = pair.indexOf('=')
      const name = separatorIndex >= 0 ? pair.slice(0, separatorIndex).trim() : pair.trim()
      const value = separatorIndex >= 0 ? pair.slice(separatorIndex + 1).trim() : ''

      if (!name) return null

      return {
        name,
        value,
        domain,
        path: '/',
        secure: false,
        sameParty: false,
        httpOnly: false,
      }
    })
    .filter(Boolean)
}

// 所有站点共用的浏览器包装类；站点特有逻辑通过子类扩展。
class UseBrowser {
  public browser: puppeteer.Browser | null = null
  // 页面滚动完成后，下载服务会从这里读取响应图片 buffer。
  public buffs: Record<string, Buffer> = {}
  protected cookieFile = ''
  protected config: any = {}
  protected websiteConfig: WebsiteConfig = {}
  protected nouser = false
  private bufferBytes = 0
  private bufferOrder: string[] = []
  website = ''

  constructor(options: BrowserOptions = defaultParams) {
    const { nouser = defaultParams.nouser, website = defaultParams.website } = options

    this.nouser = nouser
    this.website = website
    this.loadConfig()
  }

  // 保留为显式方法，方便调用方或测试在不重建实例的情况下刷新配置。
  loadConfig() {
    this.config = get_config() || {}
    this.websiteConfig = this.config[this.website] || {}

    if (this.nouser) {
      this.cookieFile = this.websiteConfig.cookieFileNoUser || 'data/cookies.json'
    } else {
      this.cookieFile = this.websiteConfig.cookieFile || 'data/cookies.json'
    }
  }

  // 浏览器级代理在启动时配置；每个页面的代理认证由 setProxyAuth 处理。
  protected get proxyArgs(): string[] {
    const proxy = this.config.proxy
    if (proxy?.enable && proxy.server) {
      return [`--proxy-server=${proxy.server}`]
    }

    return []
  }

  // Puppeteer 的代理凭据需要在每个新页面上设置，而不只是浏览器启动时设置。
  protected async setProxyAuth(page: puppeteer.Page) {
    const proxy = this.config.proxy
    if (proxy?.enable && proxy.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password || '' })
    }
  }

  // 启动底层 Chromium 实例。大多数调用方随后会调用 get_cookie() 和 new_page()。
  async init(options: { headless?: boolean } = {}) {
    const headless = options.headless ?? this.config.headless
    console.log('[browser init] headless =', headless, '| options.headless =', options.headless, '| config.headless =', this.config.headless)
    console.log('[browser init] config 路径:', get_config_path())
    console.log('[browser init] 完整 config:', JSON.stringify(this.config).slice(0, 500))
    const executablePath =
      this.config.executablePath ||
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      puppeteer.executablePath()

    this.browser = await puppeteer.launch({
      headless,
      executablePath,
      timeout: 60 * 1000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--lang=zh-CN,zh',
        ...this.proxyArgs,
      ],
      defaultViewport: {
        width: 1920,
        height: 1440,
      },
    })
  }

  // 从磁盘加载 cookie；只有 cookieFallbacks 中列出的站点才会回退到环境变量。
  async get_cookie() {
    if (!this.browser) return

    let cookies = readCookieFile(this.cookieFile)
    const fallback = cookieFallbacks[this.website]
    const fallbackCookie = fallback ? process.env[fallback.env] : ''

    if (cookies.length === 0 && fallbackCookie) {
      cookies = parseCookieString(fallbackCookie, fallback.domain)
    }

    if (cookies.length) {
      await this.browser.setCookie(...cookies)
    }
  }

  // 持久化当前浏览器 cookie，便于后续运行复用登录态。
  async save_cookie(runEndApp = true) {
    if (!this.browser) return

    const cookies = await this.browser.cookies().catch(() => null)
    if (!cookies) {
      safeLog('[cookie] Failed to read browser cookies')
      await this.browser?.close().catch(() => {})
      throw new Error('Failed to read browser cookies')
    }

    fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true })
    fs.writeFileSync(this.cookieFile, JSON.stringify(cookies, null, 2), 'utf-8')
    console.log('cookie updated', new Date().toLocaleString())

    if (runEndApp) end_app()
  }

  // 打开可见浏览器窗口，用于手动登录或验证流程。
  async start_manual_auth(url: string) {
    if (this.browser && (this.browser as any).connected) {
      throw new Error(`${this.website} manual auth browser is already open`)
    }

    await this.init({ headless: false })
    await this.get_cookie()
    const page = await this.new_page()
    if (!page) throw new Error('Failed to open manual auth page')

    await page
      .goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60 * 1000,
      })
      .catch((error) => {
        safeLog(`[manual auth] ${this.website} failed to open page: ${error.message}`)
      })
  }

  // 保存手动认证窗口中的 cookie，并关闭这个专用浏览器实例。
  async finish_manual_auth() {
    if (!this.browser || !(this.browser as any).connected) {
      throw new Error(`${this.website} manual auth browser is not open`)
    }

    await this.save_cookie(false)
    await this.browser.close()
    this.browser = null
  }

  // 创建带通用伪装头、请求过滤和图片捕获能力的页面。
  async new_page() {
    if (!this.browser) return null

    const page = await this.browser.newPage()
    await this.setupCommonPage(page)
    await this.setupRequestInterception(page)
    this.captureImageResponses(page)

    return page
  }

  // 追踪图片 403 响应，用于判断 cookie 是否过期
  public image403Count = 0

  clear_buffs() {
    this.buffs = {}
    this.bufferBytes = 0
    this.bufferOrder = []
    this.image403Count = 0
  }

  // 通用页面准备：设置语言请求头，并补少量浏览器指纹字段。
  protected async setupCommonPage(page: puppeteer.Page) {
    await this.setProxyAuth(page)

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-CH-UA-Platform': '"Windows"',
      'Upgrade-Insecure-Requests': '1',
    })

    await page.evaluateOnNewDocument(() => {
      const nav = (globalThis as any).navigator
      Object.defineProperty(nav, 'webdriver', {
        get: () => false,
      })
    })

    await page.evaluateOnNewDocument(() => {
      const nav = (globalThis as any).navigator
      const makePlugin = (name: string) => ({
        name,
        filename: `${name.toLowerCase().replace(/\s+/g, '_')}.dll`,
        description: name,
        length: 1,
        0: { type: 'application/x-google-chrome-plugin' },
        item: () => null,
        namedItem: () => null,
      })

      Object.defineProperty(nav, 'plugins', {
        get: () => {
          const plugins = [
            makePlugin('Chrome PDF Plugin'),
            makePlugin('Chrome PDF Viewer'),
            makePlugin('Native Client'),
          ] as any
          plugins.item = (i: number) => plugins[i] || null
          plugins.namedItem = (name: string) =>
            plugins.find((plugin: any) => plugin.name === name) || null
          plugins.refresh = () => {}

          return plugins
        },
      })
    })

    await page.evaluateOnNewDocument(() => {
      const win = globalThis as any
      if (!win.chrome) {
        Object.defineProperty(win, 'chrome', {
          get: () => ({ runtime: {} }),
        })
      }
    })

    await page.evaluateOnNewDocument(() => {
      const win = globalThis as any
      Object.defineProperty(win, 'outerWidth', {
        get: () => win.innerWidth,
      })
      Object.defineProperty(win, 'outerHeight', {
        get: () => win.innerHeight + 100,
      })
    })
  }

  // 所有请求决策都经过 handleRequest，子类可以安全地追加站点特有行为。
  protected async setupRequestInterception(page: puppeteer.Page) {
    await page.setRequestInterception(true)

    page.on('request', (request) => {
      void this.handleRequest(page, request)
    })
  }

  // 默认请求策略：中断噪声较大的广告/追踪脚本，其余请求继续。
  protected async handleRequest(_page: puppeteer.Page, request: puppeteer.HTTPRequest) {
    const resourceType = request.resourceType()
    const url = request.url()
    const shouldAbort =
      (resourceType === 'script' || resourceType === 'ping') &&
      adDomains.some((domain) => url.includes(domain))

    if (shouldAbort) {
      await request.abort().catch(() => {})
      return
    }

    await request.continue().catch(() => {})
  }

  // 将图片响应捕获到内存，供滚动完成后保存图片的服务使用。
  protected captureImageResponses(page: puppeteer.Page) {
    page.on('response', async (response) => {
      await this.handleImageResponse(page, response)
    })
  }

  // 基类只把图片存入内存；子类可以额外写入磁盘缓存。
  protected async handleImageResponse(_page: puppeteer.Page, response: puppeteer.HTTPResponse) {
    const contentType = response.headers()['content-type'] ?? ''
    if (!/image/i.test(contentType) || response.request().resourceType() !== 'image') return

    try {
      const buffer = await response.buffer()
      this.rememberImageBuffer(response.url(), buffer)
    } catch {
      // 忽略临时性的 response buffer 读取失败。
    }
  }

  // 控制内存占用，并保留插入顺序以便按最早写入优先淘汰。
  protected rememberImageBuffer(url: string, buffer: Buffer) {
    const maxBytes = Number(this.config.imageBufferMaxBytes ?? 512 * 1024 * 1024)
    if (maxBytes > 0 && buffer.length > maxBytes) return

    if (this.buffs[url]) {
      this.bufferBytes -= this.buffs[url].length
    } else {
      this.bufferOrder.push(url)
    }

    this.buffs[url] = buffer
    this.bufferBytes += buffer.length

    while (maxBytes > 0 && this.bufferBytes > maxBytes && this.bufferOrder.length > 0) {
      const oldestUrl = this.bufferOrder.shift()
      if (!oldestUrl || !this.buffs[oldestUrl]) continue

      this.bufferBytes -= this.buffs[oldestUrl].length
      delete this.buffs[oldestUrl]
    }
  }
}

// Toomics 页面会复用大量封面/章节图片，因此在 UseBrowser 基础上增加磁盘缓存。
class UseToomicsBrowser extends UseBrowser {
  private cacheRoot = ''

  constructor() {
    super({ nouser: false, website: 'toomics' })
    this.cacheRoot =
      this.websiteConfig.coverCache || this.config.coverCache || this.config.cacheRoot || ''
  }

  // 优先把缓存图片直接返回给页面，未命中时再走网络请求。
  protected async handleRequest(page: puppeteer.Page, request: puppeteer.HTTPRequest) {
    if (request.resourceType() === 'image') {
      const cacheDir = this.getCacheDir(page.url())

      if (cacheDir) {
        const cachePath = getCachePathCandidates(cacheDir, request.url()).find((candidate) =>
          fs.existsSync(candidate)
        )

        if (cachePath) {
          const buffer = fs.readFileSync(cachePath)
          await request
            .respond({
              status: 200,
              contentType: getMimeTypeFromPath(cachePath),
              body: buffer,
            })
            .catch(() => {})
          return
        }
      }
    }

    await super.handleRequest(page, request)
  }

  // Toomics 图片同时保存到磁盘缓存和服务会读取的内存 buffer。
  // 同时追踪 403 响应：cookie 过期后图片请求会大量返回 403。
  protected async handleImageResponse(page: puppeteer.Page, response: puppeteer.HTTPResponse) {
    // 403 检测：cookie 过期时 Toomics 图片接口返回 403，不进入 buffer
    if (response.request().resourceType() === 'image' && response.status() === 403) {
      this.image403Count++
      return
    }

    const contentType = response.headers()['content-type'] ?? ''
    if (!/image/i.test(contentType) || response.request().resourceType() !== 'image') return

    try {
      const buffer = await response.buffer()
      const url = response.url()
      const cacheDir = this.getCacheDir(page.url())

      if (cacheDir) {
        fs.mkdirSync(cacheDir, { recursive: true })
        const imageKey = createSafeDirname(url)
        const ext = getImageExtension(contentType)
        const cachePath = path.join(cacheDir, `${imageKey}${ext}`)
        fs.writeFileSync(cachePath, buffer)
      }

      this.rememberImageBuffer(url, buffer)
    } catch (error) {
      console.error('Failed to cache image:', error)
    }
  }

  // 详情页共用章节缓存；其他页面按当前页面 URL 分目录缓存。
  private getCacheDir(currentUrl: string) {
    if (!this.cacheRoot) return null

    if (currentUrl.includes('/detail/')) {
      return `${this.cacheRoot}-chapter`
    }

    return path.join(this.cacheRoot, createSafeDirname(currentUrl))
  }
}

// 导出单例浏览器管理器，方便长任务共享 cookie 和图片 buffer。
const toomicsBrowser = new UseToomicsBrowser()
const bilibiliBrowser = new UseBrowser({ website: 'bilibili' })
const toomicsBrowserNoUser = new UseBrowser({ nouser: true, website: 'toomics' })
const omegascansBrowser = new UseBrowser({ website: 'omegascans' })
const gentlemanBrowser = new UseBrowser({ website: 'gentleman' })

export {
  UseBrowser,
  toomicsBrowser,
  bilibiliBrowser,
  toomicsBrowserNoUser,
  omegascansBrowser,
  gentlemanBrowser,
}
