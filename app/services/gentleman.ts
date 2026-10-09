/**
 * Gentleman 漫画订阅下载器
 *
 * 目标站点：wnacg.ru（绅士漫画）
 * 下载流程：
 *   1. 通过 Puppeteer 加载漫画目录页，解析所有章节链接
 *   2. 按配置规则过滤章节（名称正则匹配、包含/排除关键词）
 *   3. 逐章节打开每张图片的详情页，获取带验证参数的原图 URL 并下载
 *   4. 整理封面元数据，可选地将文件归档到 organize 目录
 *   5. 若检测到「完結」章节，自动移除订阅
 */

import * as fs from 'fs'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe'
import path from 'path'
import { copy_folder, end_app, get_config, write_log, make_can_be_floder } from '#utils/index'
import { tryIndexMangaMetaFile } from '#api/manga'
import { gentlemanBrowser } from '#api/browser'

/** 章节信息，贯穿解析→下载→整理全流程 */
type ChapterInfo = {
  name: string // 章节名称（已清理为合法目录名），如「同事換愛 185話」
  url: string // 章节列表页完整 URL
  imageNum?: number // 页面标注的图片总数（仅用于展示，不参与下载逻辑）
  images: string[] // 解析出的所有图片完整 URL 列表
}

type ChapterDownloadProgress = {
  viewUrl: string
  imageUrl: string
  fileName: string
}

type ChapterPageProgress = {
  pageNumber: number
  pageUrl: string
  viewUrls: string[]
  nextPageUrl: string
}

type GentlemanPage = NonNullable<Awaited<ReturnType<typeof gentlemanBrowser.new_page>>>
type GentlemanImageCaptureMode = 'all' | 'none' | 'original-only'

const chapterProgressFileName = '.gentleman-progress.jsonl'
const chapterPageProgressFileName = '.gentleman-pages.jsonl'

export default class Gentleman {
  // ── 站点与身份 ──────────────────────────────────────────────
  private domain = 'https://www.wnacg.ru' // 绅士漫画当前可用域名（镜像站可能变化）
  private website: string = 'gentleman' // 配置文件中的 key，对应 config.json["gentleman"]
  private mangaId: number | string // 订阅系统的漫画唯一 ID
  private mangaName: string // 漫画名称（已处理为合法目录名）
  private mangaUrl: string = '' // 漫画目录页 URL（域名已替换为 this.domain）

  // ── 路径配置（来自 config.json）─────────────────────────────
  private downloadPath: string // 原始下载根目录，如 D:/manga-download
  private organizePath: string // 整理后归档目录，如 D:/manga-organized
  private config: any // 当前站点的完整配置对象
  private downloadChapterLimit = 0 // E2E/调试用：限制本次最多下载的章节数，0 表示不限制

  // ── 运行时状态 ──────────────────────────────────────────────
  private chapters: ChapterInfo[] = [] // 解析得到的全部章节列表
  private mangaPath: string = '' // 本漫画的下载目录：downloadPath/mangaName
  private metaPath: string = '' // 元数据目录：mangaPath/.smanga（存放封面等）
  private organizeMetaPath: string = '' // 归档元数据目录：organizePath/mangaName/.smanga
  private mangaStatus: string = '' // 漫画状态，检测到「完結」时置为 'finished'
  private params: any // 订阅参数（来自 subscribe 模块传入）

  // ── 进度回调（可选，由任务调度层注入）────────────────────────
  private onProgress?: {
    setTotal: (n: number) => void // 设置待下载章节总数
    report: (msg: string) => void // 上报章节完成消息
    message: (msg: string) => void // 上报实时进度文本
    subProgress?: (current: number, total: number) => void // 上报章节内图片进度
  }

  /**
   * @param params     订阅任务参数，包含 id、name、url、chapterCount 等
   * @param onProgress 可选的进度回调，由任务调度层注入
   */
  constructor(params: subsribeType, onProgress?: any) {
    const config = get_config('gentleman') || {}
    this.params = params
    this.downloadPath = config?.downloadPath || ''
    this.organizePath = config?.organizePath || ''
    this.config = config
    this.downloadChapterLimit = Number(config?.downloadChapterLimit || 0)
    this.mangaId = params.id
    // 将漫画名清理为合法目录名（去除 HTML 标签、非法字符等）
    this.mangaName = make_can_be_floder(params.name)
    // 将 URL 中的域名强制替换为当前可用域名（应对镜像站切换）
    this.mangaUrl = params.url?.replace(/https?:\/\/[^/]+/, this.domain) || ''
    // 初始化漫画下载目录，不存在则自动创建
    this.mangaPath = path.join(this.downloadPath, this.mangaName)

    if (!fs.existsSync(this.mangaPath)) {
      fs.mkdirSync(this.mangaPath, { recursive: true })
    }

    // .smanga 目录存放封面等元数据，供前端展示使用
    this.metaPath = path.join(this.mangaPath, '.smanga')
    this.organizeMetaPath = path.join(this.organizePath, this.mangaName, '.smanga')

    if (onProgress) this.onProgress = onProgress
  }

  /** 检查章节目录是否存在，兼容带/不带空格的两种命名 */
  private chapterExists(chapterName: string): boolean {
    const chapterPath = path.join(this.mangaPath, chapterName)
    if (fs.existsSync(chapterPath) && fs.readdirSync(chapterPath).length > 0) return true
    // 兼容旧数据：已存储的目录可能不带空格，去掉空格再找一遍
    const noSpaceName = chapterName.replace(/\s+/g, '')
    if (noSpaceName !== chapterName) {
      const noSpacePath = path.join(this.mangaPath, noSpaceName)
      if (fs.existsSync(noSpacePath) && fs.readdirSync(noSpacePath).length > 0) return true
    }
    return false
  }

  /**
   * 主入口：执行完整的订阅下载流程
   *
   * 流程：初始化浏览器 → 解析章节列表 → 逐章下载图片 → 整理元数据 → 归档文件 → 处理完结订阅
   */
  async start() {
    write_log(`[gentleman] ${this.mangaName} 正在分析`)

    // Step 1: 确保 Puppeteer 浏览器实例就绪
    await this.ensureBrowser()
    if (!gentlemanBrowser.browser || !this.mangaUrl) return

    // Step 2: 解析漫画所有章节链接（支持分页加载）
    await this.get_chapters()

    // ── 章节对比 ──
    write_log(`[gentleman] ${this.mangaName} 线上共解析到 ${this.chapters.length} 个章节`)
    const existingChapters = this.chapters.filter((item) => this.chapterExists(item.name))
    const newChaptersRaw = this.chapters.filter((item) => !this.chapterExists(item.name))
    write_log(
      `[gentleman] ${this.mangaName} 本地已存在 ${existingChapters.length} 个，待下载 ${newChaptersRaw.length} 个`
    )

    // Step 3: 过滤出尚未下载的章节（目录不存在或为空则视为需要下载）
    const newChapters = this.limitChaptersToDownload(newChaptersRaw)
    this.onProgress?.setTotal(newChapters.length)

    // Step 4: 逐章节解析图片 URL，并在每张原图到达后立即写盘释放内存
    let downloadedCount = 0
    const downloadedChapters: ChapterInfo[] = []
    for (const item of newChapters) {
      write_log(`[chapter]${item.name} 正在下载`)
      this.onProgress?.message(`正在下载章节: ${item.name}`)
      await this.download_chapter_images(item)
      downloadedCount++
      downloadedChapters.push(item)
      this.onProgress?.report(`${item.name} 下载完成`)

      // 检测完结标记，用于后续自动移除订阅
      if (item.name.includes('完結')) {
        this.mangaStatus = 'finished'
      }
    }

    // Step 5: 提取封面并同步到归档目录
    await this.organize_meta_1()

    // Step 5.5: 仅当有实际章节下载时才写入记录表（只记录已下载章节）
    if (downloadedCount > 0) {
      await this.index_meta(downloadedChapters)
    }

    // Step 6: 按配置决定是否将下载文件整理归档（重命名为规范目录结构）
    if (this.config.organize) {
      await this.organize_files()
    }

    write_log(`[gentleman] ${this.mangaName} 订阅完毕`)

    // Step 7: 若漫画已完结，从订阅列表中移除（避免重复拉取）
    if (this.mangaStatus === 'finished') {
      subscribe_remove({ website: this.website, id: this.mangaId, name: this.params.name })
      write_log(`[subscribe]${this.mangaName} 已移除订阅链接`)
    }

    // 通知任务系统当前订阅已完成，可退出进程
    end_app()
  }

  /** 确保浏览器已初始化 */
  private async ensureBrowser() {
    if (!gentlemanBrowser.browser?.connected) {
      write_log(`[gentleman] 正在启动浏览器...`)
      await gentlemanBrowser.ensureBrowser()
      write_log(`[gentleman] 浏览器启动完成, browser=${!!gentlemanBrowser.browser}`)
    }
  }

  /** 写入 meta.json 并索引到 manga_results / manga_chapters 记录表（仅已下载章节） */
  private async index_meta(downloadedChapters: ChapterInfo[]) {
    const meta = {
      title: this.mangaName,
      website: this.website,
      chapters: downloadedChapters.map((c) => ({
        name: c.name,
        url: c.url,
        imageNum: c.imageNum,
      })),
    }

    const metaFile = path.join(this.metaPath, 'meta.json')
    if (!fs.existsSync(this.metaPath)) {
      fs.mkdirSync(this.metaPath, { recursive: true })
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')

    await tryIndexMangaMetaFile(metaFile, {
      website: this.website,
      source: 'download',
      sourcePath: this.mangaPath,
    })
  }

  /** 按配置限制本次下载的章节数量，主要用于真实站点 E2E 测试控制成本 */
  private limitChaptersToDownload(chapters: ChapterInfo[]) {
    if (!Number.isFinite(this.downloadChapterLimit) || this.downloadChapterLimit <= 0) {
      return chapters
    }

    return chapters.slice(0, this.downloadChapterLimit)
  }

  /**
   * 解析漫画的所有章节链接（支持多页目录）
   *
   * 站点目录页结构：
   *   - 第一页由 mangaUrl 直接加载
   *   - 分页链接嵌在 class="thispage" 的 div 内，格式为 href="/photos-index-..."
   *   - 每页包含多个 <li> 条目，每条对应一个章节
   *
   * 提前终止优化：当页面末尾章节的本地目录已存在时，认为旧章节无需再加载，停止翻页
   */
  async get_chapters(): Promise<ChapterInfo[]> {
    // 加载第一页，解析章节列表和分页链接
    const firstPageHtml = await this.get_browser_html(this.mangaUrl)
    // 提取分页导航区域的 HTML 片段（位于 class="thispage" 的 div 内）
    const pageBox = firstPageHtml.match(/(?<=thispage).+?(?=\/div)/s)?.[0] || ''

    this.chapters = this.get_page_chapters(firstPageHtml)
    write_log(`[gentleman] ${this.mangaName} 第1页解析到 ${this.chapters.length} 个章节`)

    // 提取所有分页链接（href 属性值）
    const pagesMatch = pageBox.match(/(?<=href=").+?(?=")/gs)
    if (!pagesMatch) {
      write_log(
        `[gentleman] ${this.mangaName} 目录翻页: pageBox中无href链接, pageBox="${pageBox.slice(0, 200)}"`
      )
      return this.chapters
    }

    let pageNum = 1
    for (const item of pagesMatch) {
      pageNum++
      // 提前终止：当前页最后一个章节已下载，说明后续页都是旧数据，无需继续加载
      // 手动下载时不提前终止，确保加载全部页面（防止漏掉中间被删又重下的老章节）
      const lastChapter = this.chapters[this.chapters.length - 1]
      if (!this.params.manual && lastChapter && this.chapterExists(lastChapter.name)) {
        break
      }
      // 过滤掉过短的无效链接（如 "#" 等干扰项）
      if (item.length < 10) continue
      write_log(`[gentleman] ${this.mangaName} 正在加载第${pageNum}页: ${item}`)
      const html = await this.get_browser_html(this.domain + item)
      const pageChapters = this.get_page_chapters(html)
      write_log(`[gentleman] ${this.mangaName} 第${pageNum}页解析到 ${pageChapters.length} 个章节`)
      this.chapters = this.chapters.concat(pageChapters)
    }

    // 过滤：去除无 URL 的条目，再按配置规则筛选
    const withUrlChapters = this.chapters.filter((item) => item.url)
    this.chapters = withUrlChapters.filter((item) => this.filter_chapter(item))
    const afterFilter = this.chapters.length
    // 诊断：全部被规则过滤掉时，打印前几个章节名和过滤正则，方便对比
    if (afterFilter === 0 && withUrlChapters.length > 0) {
      const samples = withUrlChapters.slice(0, 5).map((c) => c.name)
      const { chapterIncludes = '', chapterExcludes = '' } = this.config
      const nameMatchRegex = new RegExp(`${this.params.name}\\d+(-\\d+)?[話话]`)
      write_log(`[gentleman] ${this.mangaName} 规则过滤诊断:`)
      write_log(`  params.name = "${this.params.name}"`)
      write_log(`  params.nameMatch = ${this.params?.nameMatch}`)
      write_log(`  nameMatchRegex = /${nameMatchRegex.source}/`)
      write_log(`  chapterIncludes = "${chapterIncludes}"`)
      write_log(`  chapterExcludes = "${chapterExcludes}"`)
      write_log(`  被过滤章节样本: ${samples.join(' | ')}`)
      for (const s of samples) {
        const reasons: string[] = []
        if (this.params?.nameMatch !== false && !nameMatchRegex.test(s))
          reasons.push('nameMatch不匹配')
        if (chapterIncludes && !new RegExp(chapterIncludes).test(s))
          reasons.push('chapterIncludes不匹配')
        if (chapterExcludes && new RegExp(chapterExcludes).test(s))
          reasons.push('chapterExcludes排除')
        write_log(`  "${s}" → ${reasons.join(', ') || '通过(不应出现)'}`)
      }
    }
    return this.chapters
  }

  /**
   * 根据配置过滤章节，支持三种规则（同时生效，全部通过才保留）：
   *   1. nameMatch   — 章节名必须符合「{漫画名}{数字}(-{数字})?話」格式（可关闭）
   *   2. chapterIncludes — 章节名必须包含匹配此正则的内容（空字符串表示不限制）
   *   3. chapterExcludes — 章节名不能匹配此正则（空字符串表示不排除任何内容）
   */
  private filter_chapter(chapter: ChapterInfo): boolean {
    const { chapterIncludes = '', chapterExcludes = '' } = this.config
    // 构造漫画名+话数的标准正则，如：同事換愛\d+(-\d+)?話
    // \s* 兼容漫画名与数字之间的空格（如 "熟女自助餐 89-90話"）
    // [話话] 兼容简繁体（站点既有「話」也有「话」）
    const nameMatchRegex = new RegExp(`${this.params.name}\\s*\\d+(-\\d+)?[話话]`)

    // params.nameMatch 为 false 时跳过名称格式校验
    if (this.params?.nameMatch !== false && !nameMatchRegex.test(chapter.name)) return false
    if (chapterIncludes && !new RegExp(chapterIncludes).test(chapter.name)) return false
    if (chapterExcludes && new RegExp(chapterExcludes).test(chapter.name)) return false
    return true
  }

  /**
   * 通过 Puppeteer 打开指定 URL 并获取渲染后的完整 HTML
   *
   * 注意：使用 try/finally 确保 page 无论是否发生异常都会被关闭，
   * 避免 Chromium 因页面泄漏而耗尽内存。
   *
   * @param url 目标页面 URL
   * @returns   页面 HTML 字符串；浏览器不可用或页面创建失败时返回空字符串
   * @throws    页面连续导航失败或安全验证重试耗尽时抛出错误，避免把验证页误当成空内容
   */
  async get_browser_html(url: string): Promise<string> {
    await this.ensureBrowser()
    if (!gentlemanBrowser.browser) {
      write_log(`[gentleman] get_browser_html: 浏览器未初始化`)
      return ''
    }

    let page: GentlemanPage | null = null
    gentlemanBrowser.set_image_capture_mode('none')
    try {
      page = await gentlemanBrowser.new_page().catch((e) => {
        write_log(`[gentleman] get_browser_html: 创建页面失败 ${e?.message || e}`)
        return null
      })
      if (!page) return ''

      return await this.get_page_html(page, url)
    } finally {
      await page?.close().catch(() => {})
      gentlemanBrowser.clear_buffs()
      gentlemanBrowser.set_image_capture_mode('all')
    }
  }

  /** 等待指定时间；独立成方法便于单元测试跳过真实延时。 */
  private async wait(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  /** 识别 Cloudflare 或站点返回的自动程序安全验证页。 */
  private is_challenge_page(html: string, title: string, status: number): boolean {
    if ([403, 429, 503].includes(status)) return true

    return /just a moment|checking your browser|请稍候|正在进行安全验证|cf-chl|challenge-platform|ray id/i.test(
      `${title}\n${html}`
    )
  }

  /** 在已有页签中加载 HTML，遇到安全验证或临时导航失败时退避重试。 */
  private async get_page_html(
    page: GentlemanPage,
    url: string,
    options: {
      retry?: number
      retryDelayMs?: number
      failFastOnNavigationError?: boolean
    } = {}
  ): Promise<string> {
    const configuredRetry = options.retry ?? this.config.detailPageRetry ?? 3
    const configuredRetryDelay = options.retryDelayMs ?? this.config.challengeRetryDelayMs ?? 30_000
    const retry = Math.max(1, Number(configuredRetry))
    const retryDelay = Math.max(0, Number(configuredRetryDelay))
    let lastError: unknown = null

    for (let attempt = 1; attempt <= retry; attempt++) {
      try {
        const response = await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 60 * 1000,
        })
        const html = await page.content()
        const title = await page.title().catch(() => '')
        const status = response?.status() || 0

        if (!this.is_challenge_page(html, title, status)) return html

        lastError = new Error(`触发站点安全验证 (HTTP ${status || 'unknown'}, title=${title})`)
      } catch (error) {
        lastError = error
        if (options.failFastOnNavigationError && this.is_browser_navigation_error(error)) {
          const message = error instanceof Error ? error.message : String(error)
          write_log(`[gentleman] 页面加载失败 (1/${retry}): ${url}, 原因: ${message}`)
          throw new Error(`Gentleman 页面重试耗尽: ${url}, 原因: ${message}`)
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError)
      write_log(`[gentleman] 页面加载失败 (${attempt}/${retry}): ${url}, 原因: ${message}`)

      if (attempt < retry) {
        const delay = retryDelay * attempt
        write_log(`[gentleman] ${Math.ceil(delay / 1000)} 秒后重试当前页面`)
        await this.wait(delay)
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`Gentleman 页面重试耗尽: ${url}, 原因: ${message}`)
  }

  /**
   * 从已下载章节目录中提取最新封面，同步到元数据目录
   *
   * 封面文件识别规则：文件名包含 "cover" 或 "logo"
   * 取最后一个匹配的封面（目录按字母序排列，最后一个即最新章节的封面）
   * 最终将 .smanga 目录整体复制到归档路径，供前端展示使用
   */
  async organize_meta_1() {
    if (!fs.existsSync(this.metaPath)) fs.mkdirSync(this.metaPath, { recursive: true })

    // 遍历所有章节子目录，收集所有封面/logo 文件路径
    const covers: string[] = []
    const chapters = fs.readdirSync(this.mangaPath)

    for (const chapter of chapters) {
      if (chapter.endsWith('.downloading')) continue
      const filePath = path.join(this.mangaPath, chapter)
      if (!fs.statSync(filePath).isDirectory()) continue
      fs.readdirSync(filePath)
        .filter((file) => file.includes('cover') || file.includes('logo'))
        .forEach((file) => covers.push(path.join(filePath, file)))
    }

    if (covers.length === 0) return

    // 用最新章节的封面覆盖 .smanga/cover.jpg
    const latestCover = covers[covers.length - 1]
    fs.copyFileSync(latestCover, path.join(this.metaPath, 'cover.jpg'))
    // 将 .smanga 目录整体复制到归档路径（覆盖已有文件）
    copy_folder(this.metaPath, this.organizeMetaPath)
  }

  /**
   * 将下载的原始文件整理到归档目录
   *
   * 原始下载目录结构（文件名格式：{章节号}_{图片序号}.jpg）：
   *   mangaPath/同事換愛 185話/t4_images..._185_001.jpg
   *
   * 归档目标结构：
   *   organizePath/mangaName/185/001.jpg   （以章节号为子目录，图片序号为文件名）
   *
   * 注意：已存在的章节目录会被跳过（增量归档），避免覆盖已有文件
   */
  async organize_files() {
    const sourceChapters = fs.readdirSync(this.mangaPath)
    const organizeMangaPath = path.join(this.organizePath, this.mangaName)
    let coverFile = '' // 追踪最后遇到的封面文件路径，用于后续复制到各章节目录

    if (!fs.existsSync(organizeMangaPath)) fs.mkdirSync(organizeMangaPath, { recursive: true })
    const organizeChapters = fs.readdirSync(organizeMangaPath)

    // 遍历下载目录中的每个章节子目录
    for (const chapter of sourceChapters) {
      if (chapter.endsWith('.downloading')) continue
      const filePath = path.join(this.mangaPath, chapter)
      if (!fs.statSync(filePath).isDirectory()) continue

      const chapterImages = fs.readdirSync(filePath)
      for (const image of chapterImages) {
        if (!image.includes('jpg')) continue
        // 封面/logo 文件单独记录路径，不参与归档
        if (image.includes('cover') || image.includes('logo')) {
          coverFile = path.join(filePath, image)
          continue
        }

        // 解析文件名：格式为 "{前缀}_{章节号}_{图片序号}.jpg"
        // split('_') 后取前两段：[0]=章节号, [1]=图片序号
        const imageNums = image.split('_')
        if (imageNums.length < 2) continue

        const [chapterNum, imageNumRaw] = imageNums
        const imageNum = imageNumRaw.split('.')[0] // 去掉 .jpg 后缀
        const organizeChapterPath = path.join(organizeMangaPath, chapterNum)
        const organizeFile = path.join(organizeChapterPath, `${imageNum}.jpg`)

        // 仅当归档目录中不存在该章节目录时才复制（增量处理，避免重复写入）
        if (!organizeChapters.includes(chapterNum)) {
          fs.mkdirSync(organizeChapterPath, { recursive: true })
        } else {
          continue
        }

        fs.copyFileSync(path.join(filePath, image), organizeFile)
      }
    }

    // 为每个已归档的章节目录补充封面文件（格式：章节目录.jpg，与目录平级）
    if (coverFile) {
      for (const chapter of organizeChapters) {
        if (chapter === '.smanga') continue
        const chapterDir = path.join(organizeMangaPath, chapter)
        if (!fs.statSync(chapterDir).isDirectory()) continue
        const chapterCover = `${chapterDir}.jpg`
        if (fs.existsSync(chapterCover)) continue // 已有封面则跳过
        fs.copyFileSync(coverFile, chapterCover)
      }
    }
  }

  /** 将站点中的相对地址、协议相对地址统一转换为完整 HTTPS URL。 */
  private absolute_url(rawUrl: string, baseUrl: string = this.domain): string {
    const decodedUrl = rawUrl.trim().replace(/&amp;/g, '&')
    if (!decodedUrl) return ''
    if (decodedUrl.startsWith('//')) return `https:${decodedUrl}`

    try {
      return new URL(decodedUrl, baseUrl).toString()
    } catch {
      return ''
    }
  }

  /** 从章节列表页中收集当页每张图片的详情页链接。 */
  private get_subpage_view_urls(html: string, pageUrl: string): string[] {
    const imageBox = html.match(/(?<=gallary_wrap).+?(?=comment_wrap)/s)?.[0] || html
    const matches = imageBox.matchAll(/href=["']([^"']*\/photos-view-id-\d+\.html[^"']*)["']/gi)
    const viewUrls = Array.from(matches, (match) => this.absolute_url(match[1], pageUrl)).filter(
      Boolean
    )

    return [...new Set(viewUrls)]
  }

  /** 从图片详情页的 #picarea 中提取带 verify 参数的完整原图地址。 */
  private get_view_image_url(html: string, viewUrl: string): string {
    const imageTag = html.match(/<img\b(?=[^>]*\bid=["']picarea["'])[^>]*>/i)?.[0] || ''
    const rawImageUrl = imageTag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || ''
    return this.absolute_url(rawImageUrl, viewUrl)
  }

  /** 等待浏览器的异步 response 监听器把 #picarea 原图写入内存缓存。 */
  private async wait_for_image_buffer(imageUrl: string): Promise<boolean> {
    const configuredTimeout = Number(this.config.detailImageBufferTimeoutMs ?? 5_000)
    const configuredPollInterval = Number(this.config.detailImageBufferPollIntervalMs ?? 100)
    const timeout = Number.isFinite(configuredTimeout) ? Math.max(0, configuredTimeout) : 5_000
    const pollInterval = Number.isFinite(configuredPollInterval)
      ? Math.max(1, configuredPollInterval)
      : 100
    const attempts = Math.ceil(timeout / pollInterval)

    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (gentlemanBrowser.buffs[imageUrl]?.length) return true
      if (attempt < attempts) await this.wait(pollInterval)
    }

    return false
  }

  /** 读取已完成的章节分页；只接受从第一页开始连续、URL 能首尾衔接的记录。 */
  private read_chapter_page_progress(progressPath: string, chapterUrl: string) {
    const visitedPages = new Set<string>()
    const visitedViews = new Set<string>()
    const viewUrls: string[] = []
    let currentUrl = chapterUrl
    let pageNumber = 0

    if (!fs.existsSync(progressPath)) {
      return { visitedPages, visitedViews, viewUrls, currentUrl, pageNumber }
    }

    const lines = fs.readFileSync(progressPath, 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue

      let record: ChapterPageProgress
      try {
        record = JSON.parse(line) as ChapterPageProgress
      } catch {
        break
      }

      if (
        record.pageNumber !== pageNumber + 1 ||
        record.pageUrl !== currentUrl ||
        !Array.isArray(record.viewUrls)
      ) {
        break
      }

      visitedPages.add(record.pageUrl)
      for (const viewUrl of record.viewUrls) {
        if (!viewUrl || visitedViews.has(viewUrl)) continue
        visitedViews.add(viewUrl)
        viewUrls.push(viewUrl)
      }

      pageNumber = record.pageNumber
      currentUrl = record.nextPageUrl || ''
      if (!currentUrl) break
    }

    return { visitedPages, visitedViews, viewUrls, currentUrl, pageNumber }
  }

  /** 每成功解析一页就追加检查点，进程重启后可以直接从下一页继续。 */
  private append_chapter_page_progress(progressPath: string, record: ChapterPageProgress) {
    fs.appendFileSync(progressPath, `${JSON.stringify(record)}\n`, 'utf-8')
  }

  private is_browser_navigation_error(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return /navigation timeout|target closed|session closed|connection closed|page crashed|protocol error/i.test(
      message
    )
  }

  /** Chromium 无响应时先尝试正常关闭；超时后终止它的主进程。 */
  private async close_gentleman_browser_forcefully() {
    const browser = gentlemanBrowser.browser
    const browserProcess = browser?.process()
    const configuredCloseTimeout = Number(this.config.browserCloseTimeoutMs ?? 10_000)
    const closeTimeout = Number.isFinite(configuredCloseTimeout)
      ? Math.max(1_000, configuredCloseTimeout)
      : 10_000
    let closed = !browser

    if (browser) {
      const closePromise = gentlemanBrowser
        .close()
        .then(() => {
          closed = true
        })
        .catch((error) => {
          write_log(
            `[gentleman] 浏览器正常关闭失败: ${error instanceof Error ? error.message : error}`
          )
        })

      await Promise.race([closePromise, this.wait(closeTimeout)])
      if (!closed && browserProcess) {
        write_log(`[gentleman] 浏览器 ${Math.ceil(closeTimeout / 1000)} 秒内未退出，强制终止进程`)
        try {
          browserProcess.kill()
        } catch (error) {
          write_log(
            `[gentleman] 强制终止浏览器失败: ${error instanceof Error ? error.message : error}`
          )
        }
      }
    }
  }

  /** 关闭失去响应的 Chromium，再启动全新的浏览器并恢复 cookie。 */
  private async restart_gentleman_browser(
    chapterName: string,
    pageUrl: string,
    restartAttempt: number,
    imageCaptureMode: GentlemanImageCaptureMode = 'none',
    pageType = '章节分页'
  ): Promise<GentlemanPage> {
    await this.close_gentleman_browser_forcefully()

    const configuredRestartDelay = Number(this.config.browserRestartDelayMs ?? 3_000)
    const restartDelay = Number.isFinite(configuredRestartDelay)
      ? Math.max(0, configuredRestartDelay)
      : 3_000
    if (restartDelay > 0) await this.wait(restartDelay)

    gentlemanBrowser.set_image_capture_mode(imageCaptureMode)
    await gentlemanBrowser.ensureBrowser()
    const page = await gentlemanBrowser.new_page()
    if (!page) throw new Error(`${chapterName} 浏览器重启后无法创建${pageType}页签`)

    write_log(`[gentleman] ${chapterName} 浏览器已重启 (${restartAttempt})，继续加载: ${pageUrl}`)
    return page
  }

  /**
   * 复用同一个页签循环读取章节分页，避免超大合并章节不断创建、销毁 Chromium Target。
   * 这里只保留体积很小的详情页 URL；列表页产生的缩略图 buffer 会在页签关闭后清空。
   */
  private async get_chapter_view_urls(
    chapter: ChapterInfo,
    pageProgressPath: string
  ): Promise<string[]> {
    let progress = this.read_chapter_page_progress(pageProgressPath, chapter.url)
    if (!progress.currentUrl && progress.pageNumber > 0) {
      if (!chapter.imageNum || progress.viewUrls.length === chapter.imageNum) {
        write_log(
          `[gentleman] ${chapter.name} 复用已完成的分页记录，共 ${progress.pageNumber} 页、${progress.viewUrls.length} 张`
        )
        return progress.viewUrls
      }

      write_log(
        `[gentleman] ${chapter.name} 分页记录数量已变化 (${progress.viewUrls.length}/${chapter.imageNum})，从第一页重新读取`
      )
      fs.rmSync(pageProgressPath, { force: true })
      progress = this.read_chapter_page_progress(pageProgressPath, chapter.url)
    } else if (progress.pageNumber > 0) {
      write_log(
        `[gentleman] ${chapter.name} 从第${progress.pageNumber + 1}页继续，已记录 ${progress.viewUrls.length} 张`
      )
    }

    const { visitedPages, visitedViews, viewUrls } = progress
    let { currentUrl, pageNumber } = progress
    let page: GentlemanPage | null = null
    let restartAttempt = 0
    const configuredRestartLimit = Number(this.config.chapterPageBrowserRestartLimit ?? 3)
    const restartLimit = Number.isFinite(configuredRestartLimit)
      ? Math.max(1, configuredRestartLimit)
      : 3

    gentlemanBrowser.set_image_capture_mode('none')
    try {
      page = await gentlemanBrowser.new_page()
      if (!page) throw new Error(`${chapter.name} 无法创建章节分页页签`)

      while (currentUrl && !visitedPages.has(currentUrl)) {
        this.onProgress?.message(
          `正在读取章节分页: ${chapter.name} (第${pageNumber + 1}页，已找到${viewUrls.length}张)`
        )

        let html: string
        try {
          html = await this.get_page_html(page, currentUrl, { retry: 1 })
        } catch (error) {
          if (!this.is_browser_navigation_error(error)) throw error
          if (restartAttempt >= restartLimit) {
            write_log(
              `[gentleman] ${chapter.name} 第${pageNumber + 1}页连续重启 ${restartLimit} 次仍失败，关闭浏览器并交由任务队列续试`
            )
            page = null
            await this.close_gentleman_browser_forcefully()
            throw error
          }

          restartAttempt++
          write_log(
            `[gentleman] ${chapter.name} 第${pageNumber + 1}页导航异常，关闭并重启浏览器 (${restartAttempt}/${restartLimit})`
          )
          page = null
          page = await this.restart_gentleman_browser(chapter.name, currentUrl, restartAttempt)
          continue
        }

        restartAttempt = 0
        const pageViewUrls = this.get_subpage_view_urls(html, currentUrl)
        if (pageViewUrls.length === 0) {
          throw new Error(`${chapter.name} 未在章节页找到图片详情页链接: ${currentUrl}`)
        }

        for (const viewUrl of pageViewUrls) {
          if (visitedViews.has(viewUrl)) continue
          visitedViews.add(viewUrl)
          viewUrls.push(viewUrl)
        }

        const pageBox = html.match(/(?<=paginator).+?(?=f_right)/s)?.[0] || ''
        const nextPage = pageBox.match(/(?<=next"><a\shref=").+?(?=">後頁)/s)?.[0] || ''
        const nextPageUrl = nextPage ? this.absolute_url(nextPage, currentUrl) : ''
        const completedPageNumber = pageNumber + 1

        this.append_chapter_page_progress(pageProgressPath, {
          pageNumber: completedPageNumber,
          pageUrl: currentUrl,
          viewUrls: pageViewUrls,
          nextPageUrl,
        })
        visitedPages.add(currentUrl)
        pageNumber = completedPageNumber
        currentUrl = nextPageUrl
      }
    } finally {
      await page?.close().catch(() => {})
      gentlemanBrowser.clear_buffs()
      gentlemanBrowser.set_image_capture_mode('all')
    }

    return viewUrls
  }

  /** 详情页之间的礼貌限速，默认每次等待 4～6 秒，可通过 Gentleman 配置覆盖。 */
  private async wait_before_detail_page(): Promise<void> {
    const configuredMin = Number(this.config.detailPageDelayMinMs ?? 4_000)
    const configuredMax = Number(this.config.detailPageDelayMaxMs ?? 6_000)
    const min = Math.max(0, Math.min(configuredMin, configuredMax))
    const max = Math.max(min, configuredMin, configuredMax)
    const delay = min === max ? min : Math.floor(min + Math.random() * (max - min + 1))

    await this.wait(delay)
  }

  /** 在同一个页签中读取详情页；普通空页也会重试，避免瞬时 DOM 不完整造成漏图。 */
  private async get_detail_image_url(page: GentlemanPage, chapter: ChapterInfo, viewUrl: string) {
    const retry = Math.max(1, Number(this.config.detailPageRetry || 3))

    for (let attempt = 1; attempt <= retry; attempt++) {
      const html = await this.get_page_html(page, viewUrl, {
        failFastOnNavigationError: true,
      })
      const imageUrl = this.get_view_image_url(html, viewUrl)
      if (imageUrl) {
        const bufferReady = await this.wait_for_image_buffer(imageUrl)
        if (bufferReady) return imageUrl

        write_log(
          `[gentleman] ${chapter.name} 详情页原图缓存未捕获 (${attempt}/${retry}): ${viewUrl}`
        )
      } else {
        write_log(
          `[gentleman] ${chapter.name} 详情页未找到 #picarea (${attempt}/${retry}): ${viewUrl}`
        )
      }
      if (attempt < retry) await this.wait_before_detail_page()
    }

    return ''
  }

  /**
   * 读取可恢复的逐图下载记录。损坏的末行会被忽略，已不存在的图片文件会重新下载。
   */
  private read_chapter_progress(progressPath: string, downloadPath: string) {
    const completed = new Map<string, ChapterDownloadProgress>()
    if (!fs.existsSync(progressPath)) return completed

    const lines = fs.readFileSync(progressPath, 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const record = JSON.parse(line) as ChapterDownloadProgress
        if (!record.viewUrl || !record.imageUrl || !record.fileName) continue

        const imagePath = path.join(downloadPath, record.fileName)
        if (!fs.existsSync(imagePath) || fs.statSync(imagePath).size <= 0) continue
        completed.set(record.viewUrl, record)
      } catch {
        // 进程可能在追加 JSONL 时退出；仅忽略不完整的最后一条记录。
      }
    }

    return completed
  }

  /** 追加一条进度记录；每张图独立落盘，避免为超大章节反复重写完整清单。 */
  private append_chapter_progress(progressPath: string, record: ChapterDownloadProgress) {
    fs.appendFileSync(progressPath, `${JSON.stringify(record)}\n`, 'utf-8')
  }

  /** 从 Gentleman 图片缓存中取出原图，兼容 URL 中空格被浏览器编码的情况。 */
  private take_image_buffer(imageUrl: string): Buffer | null {
    const encodedImageUrl = imageUrl.replace(/ /g, '%20')
    return (
      gentlemanBrowser.take_image_buffer(imageUrl) ||
      (encodedImageUrl !== imageUrl ? gentlemanBrowser.take_image_buffer(encodedImageUrl) : null)
    )
  }

  /** 文件名冲突时增加稳定的顺序前缀，避免合并章节的同名图片互相覆盖。 */
  private get_unique_image_file_name(
    imageUrl: string,
    index: number,
    usedFileNames: Map<string, string>,
    viewUrl: string
  ) {
    const originalName = this.get_image_file_name(imageUrl, index)
    let fileName = originalName
    let collisionIndex = 0

    while (usedFileNames.has(fileName) && usedFileNames.get(fileName) !== viewUrl) {
      collisionIndex++
      const suffix = collisionIndex === 1 ? '' : `-${collisionIndex}`
      fileName = `${String(index + 1).padStart(5, '0')}${suffix}-${originalName}`
    }

    return fileName
  }

  /**
   * 流式下载某章节：列表分页和图片详情各自复用一个页签，原图捕获后立即写盘并释放。
   *
   * 下载中的图片保存在 `{章节名}.downloading`，并以 JSONL 记录完成项。进程异常退出后，
   * 下次任务会跳过已经成功写入的详情页；全部校验通过后再原子重命名为正式章节目录。
   */
  private async download_chapter_images(item: ChapterInfo): Promise<void> {
    const chapterPath = path.join(this.mangaPath, item.name)
    const downloadingPath = `${chapterPath}.downloading`
    const progressPath = path.join(downloadingPath, chapterProgressFileName)
    const pageProgressPath = path.join(downloadingPath, chapterPageProgressFileName)
    fs.mkdirSync(downloadingPath, { recursive: true })

    const viewUrls = await this.get_chapter_view_urls(item, pageProgressPath)
    const expectedCount = item.imageNum || viewUrls.length
    if (item.imageNum && viewUrls.length !== item.imageNum) {
      throw new Error(
        `${item.name} 详情页数量不完整: 页面标注 ${item.imageNum} 张，实际找到 ${viewUrls.length} 个链接`
      )
    }

    if (viewUrls.length === 0) throw new Error(`${item.name} 未找到图片详情页链接`)

    const completed = this.read_chapter_progress(progressPath, downloadingPath)
    const usedFileNames = new Map<string, string>()
    for (const record of completed.values()) usedFileNames.set(record.fileName, record.viewUrl)

    const resumedCount = viewUrls.filter((viewUrl) => completed.has(viewUrl)).length
    if (resumedCount > 0) {
      write_log(
        `[gentleman] ${item.name} 从临时目录续传，已完成 ${resumedCount}/${viewUrls.length} 张`
      )
    }

    item.images = []
    let page: GentlemanPage | null = null
    let successCount = 0
    let requestedCount = 0
    let detailPageLoadCount = 0
    const configuredMaxLoadsPerTab = Number(this.config.detailPageMaxLoadsPerTab ?? 58)
    const maxLoadsPerTab = Number.isFinite(configuredMaxLoadsPerTab)
      ? Math.max(1, Math.floor(configuredMaxLoadsPerTab))
      : 58
    const configuredRestartLimit = Number(this.config.detailPageBrowserRestartLimit ?? 3)
    const restartLimit = Number.isFinite(configuredRestartLimit)
      ? Math.max(1, configuredRestartLimit)
      : 3

    gentlemanBrowser.set_image_capture_mode('original-only')
    try {
      page = await gentlemanBrowser.new_page()
      if (!page) throw new Error(`${item.name} 无法创建图片详情页页签`)
      gentlemanBrowser.allow_image_page(page)

      for (let index = 0; index < viewUrls.length; index++) {
        const viewUrl = viewUrls[index]
        const existing = completed.get(viewUrl)
        if (existing) {
          item.images.push(existing.imageUrl)
          successCount++
          this.onProgress?.message(`正在续传章节: ${item.name} (${index + 1}/${viewUrls.length})`)
          this.onProgress?.subProgress?.(index + 1, viewUrls.length)
          continue
        }

        if (requestedCount > 0) await this.wait_before_detail_page()
        requestedCount++
        gentlemanBrowser.clear_buffs()

        this.onProgress?.message(`正在下载章节: ${item.name} (${index + 1}/${viewUrls.length})`)
        let imageUrl = ''
        let restartAttempt = 0
        while (true) {
          if (detailPageLoadCount >= maxLoadsPerTab) {
            if (page) gentlemanBrowser.remove_image_page(page)
            await page?.close().catch(() => {})
            page = await gentlemanBrowser.new_page()
            if (!page) throw new Error(`${item.name} 无法创建新的图片详情页页签`)
            gentlemanBrowser.allow_image_page(page)

            detailPageLoadCount = 0
            write_log(
              `[gentleman] ${item.name} 图片详情页页签已加载 ${maxLoadsPerTab} 次，已更换新页签`
            )
          }
          if (!page) throw new Error(`${item.name} 图片详情页页签不可用: ${viewUrl}`)

          detailPageLoadCount++
          try {
            imageUrl = await this.get_detail_image_url(page, item, viewUrl)
            break
          } catch (error) {
            if (!this.is_browser_navigation_error(error)) throw error
            if (restartAttempt >= restartLimit) {
              write_log(
                `[gentleman] ${item.name} 第${index + 1}/${viewUrls.length}张连续重启 ${restartLimit} 次仍失败，关闭浏览器并交由任务队列续试`
              )
              gentlemanBrowser.remove_image_page(page)
              page = null
              await this.close_gentleman_browser_forcefully()
              throw error
            }

            restartAttempt++
            write_log(
              `[gentleman] ${item.name} 第${index + 1}/${viewUrls.length}张详情页导航异常，关闭并重启浏览器 (${restartAttempt}/${restartLimit})`
            )
            gentlemanBrowser.remove_image_page(page)
            page = null
            page = await this.restart_gentleman_browser(
              item.name,
              viewUrl,
              restartAttempt,
              'original-only',
              '图片详情页'
            )
            gentlemanBrowser.allow_image_page(page)
            detailPageLoadCount = 0
          }
        }
        if (!imageUrl) throw new Error(`${item.name} 未能解析原图: ${viewUrl}`)

        const buffer = this.take_image_buffer(imageUrl)
        if (!buffer?.length) {
          throw new Error(`${item.name} 浏览器图片缓存缺失: ${imageUrl}`)
        }

        const fileName = this.get_unique_image_file_name(imageUrl, index, usedFileNames, viewUrl)
        const filePath = path.join(downloadingPath, fileName)
        fs.writeFileSync(filePath, buffer)

        const record = { viewUrl, imageUrl, fileName }
        this.append_chapter_progress(progressPath, record)
        completed.set(viewUrl, record)
        usedFileNames.set(fileName, viewUrl)
        item.images.push(imageUrl)
        successCount++
        this.onProgress?.subProgress?.(index + 1, viewUrls.length)

        // 页面中还可能有缩略图、logo 等响应；原图写盘后全部释放，内存峰值保持在单图级别。
        gentlemanBrowser.clear_buffs()
      }
    } finally {
      if (page) gentlemanBrowser.remove_image_page(page)
      await page?.close().catch(() => {})
      gentlemanBrowser.clear_buffs()
      gentlemanBrowser.set_image_capture_mode('all')
    }

    if (successCount !== expectedCount) {
      throw new Error(
        `${item.name} 原图下载不完整: 预期 ${expectedCount} 张，实际 ${successCount} 张`
      )
    }

    if (fs.existsSync(chapterPath)) {
      const existingEntries = fs.readdirSync(chapterPath)
      if (existingEntries.length > 0) {
        throw new Error(`${item.name} 正式章节目录在下载期间出现文件，保留临时目录等待人工确认`)
      }
      fs.rmdirSync(chapterPath)
    }

    fs.renameSync(downloadingPath, chapterPath)
    fs.rmSync(path.join(chapterPath, chapterProgressFileName), { force: true })
    fs.rmSync(path.join(chapterPath, chapterPageProgressFileName), { force: true })
    write_log(
      `[gentleman] ${item.name} 下载完成: ${successCount}/${viewUrls.length} 张成功，原图均已流式写盘`
    )
  }

  /** 从原图 URL 中生成不含验证查询参数的本地文件名。 */
  private get_image_file_name(imageUrl: string, index: number): string {
    try {
      const fileName = path.posix.basename(new URL(imageUrl).pathname)
      if (fileName) return decodeURIComponent(fileName)
    } catch {
      const fileName = imageUrl.split(/[?#]/, 1)[0].split('/').pop()
      if (fileName) return fileName
    }

    return `${String(index + 1).padStart(3, '0')}.jpg`
  }

  /**
   * 从单页目录 HTML 中解析章节列表
   *
   * 站点 HTML 结构：
   *   <div class="gallary_wrap">
   *     <ul>
   *       <li>
   *         <a href="/photos-index-aid-12345.html" title="同事換愛 185話">
   *         <span>50張圖片</span>
   *       </li>
   *       ...
   *     </ul>
   *   </div>
   *   <div class="bot_toolbar">
   */
  get_page_chapters(html: string): ChapterInfo[] {
    const chapterUrls: ChapterInfo[] = []
    // 提取章节列表区域（gallary_wrap 到 bot_toolbar 之间）
    const chapterBox = html.match(/(?<=gallary_wrap).+?(?=bot_toolbar)/s)?.[0] || ''
    // 每个 <li> 对应一个章节条目
    const chapterList = chapterBox.match(/(?<=<li).+?(?=<\/li>)/gs) || []

    for (const chapter of chapterList) {
      // 新版搜索结果会混入「合集」条目；其详情页是章节目录而非图片列表，
      // 继续按普通章节处理会在 photos-view 元素解析阶段失败。
      const isCollection =
        /\bpic_box\b[^>]*\bcate-38\b/i.test(chapter) ||
        /<span[^>]*class=["'][^"']*\bsr_ctag\b[^"']*["'][^>]*>\s*合集\s*<\/span>/i.test(
          chapter
        )
      if (isCollection) continue

      // 章节详情页链接（相对路径），如 /photos-index-aid-12345.html
      const href = chapter.match(/\/photos-index-aid-[\d]+\.html/)?.[0] || ''
      // 章节名称从 title 属性中提取，可能包含 HTML 实体和标签
      let name = chapter.match(/(?<=title=").+?(?=")/)?.[0] || ''
      // 先去除 HTML 标签，再通过 make_can_be_floder 清理为合法目录名
      name = make_can_be_floder(name.replace(/<[^>]+>/g, ''))

      // 解析页面标注的图片数量（格式："50張圖片"），仅作信息展示用
      const imageNum = parseInt(chapter.match(/[\d]+(?=張圖片)/)?.[0] || '0', 10)
      const url = `${this.domain}${href}`

      chapterUrls.push({ url, name, imageNum, images: [] })
    }

    return chapterUrls
  }
}
