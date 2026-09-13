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
  name: string       // 章节名称（已清理为合法目录名），如「同事換愛 185話」
  url: string        // 章节列表页完整 URL
  imageNum?: number  // 页面标注的图片总数（仅用于展示，不参与下载逻辑）
  images: string[]   // 解析出的所有图片完整 URL 列表
}

type GentlemanPage = NonNullable<Awaited<ReturnType<typeof gentlemanBrowser.new_page>>>

export default class Gentleman {
  // ── 站点与身份 ──────────────────────────────────────────────
  private domain = 'https://www.wnacg.ru'   // 绅士漫画当前可用域名（镜像站可能变化）
  private website: string = 'gentleman'     // 配置文件中的 key，对应 config.json["gentleman"]
  private mangaId: number | string          // 订阅系统的漫画唯一 ID
  private mangaName: string                 // 漫画名称（已处理为合法目录名）
  private mangaUrl: string = ''             // 漫画目录页 URL（域名已替换为 this.domain）

  // ── 路径配置（来自 config.json）─────────────────────────────
  private downloadPath: string              // 原始下载根目录，如 D:/manga-download
  private organizePath: string              // 整理后归档目录，如 D:/manga-organized
  private config: any                       // 当前站点的完整配置对象
  private downloadChapterLimit = 0          // E2E/调试用：限制本次最多下载的章节数，0 表示不限制

  // ── 运行时状态 ──────────────────────────────────────────────
  private chapters: ChapterInfo[] = []      // 解析得到的全部章节列表
  private mangaPath: string = ''            // 本漫画的下载目录：downloadPath/mangaName
  private metaPath: string = ''             // 元数据目录：mangaPath/.smanga（存放封面等）
  private organizeMetaPath: string = ''     // 归档元数据目录：organizePath/mangaName/.smanga
  private mangaStatus: string = ''          // 漫画状态，检测到「完結」时置为 'finished'
  private params: any                       // 订阅参数（来自 subscribe 模块传入）

  // ── 进度回调（可选，由任务调度层注入）────────────────────────
  private onProgress?: {
    setTotal: (n: number) => void           // 设置待下载章节总数
    report: (msg: string) => void           // 上报章节完成消息
    message: (msg: string) => void          // 上报实时进度文本
    subProgress?: (current: number, total: number) => void  // 上报章节内图片进度
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
    write_log(`[gentleman] ${this.mangaName} 本地已存在 ${existingChapters.length} 个，待下载 ${newChaptersRaw.length} 个`)

    // Step 3: 过滤出尚未下载的章节（目录不存在或为空则视为需要下载）
    const newChapters = this.limitChaptersToDownload(newChaptersRaw)
    this.onProgress?.setTotal(newChapters.length)

    // Step 4: 逐章节解析图片 URL 并下载
    let downloadedCount = 0
    const downloadedChapters: ChapterInfo[] = []
    for (const item of newChapters) {
      write_log(`[chapter]${item.name} 正在下载`)
      this.onProgress?.message(`正在下载章节: ${item.name}`)
      await this.get_chapter_images(item)     // 解析图片 URL 列表（含分页）
      await this.download_chapter_images(item) // 批量下载图片到本地
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
      write_log(`[gentleman] ${this.mangaName} 目录翻页: pageBox中无href链接, pageBox="${pageBox.slice(0, 200)}"`)
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
        if (this.params?.nameMatch !== false && !nameMatchRegex.test(s)) reasons.push('nameMatch不匹配')
        if (chapterIncludes && !new RegExp(chapterIncludes).test(s)) reasons.push('chapterIncludes不匹配')
        if (chapterExcludes && new RegExp(chapterExcludes).test(s)) reasons.push('chapterExcludes排除')
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

    const page = await gentlemanBrowser.new_page().catch((e) => {
      write_log(`[gentleman] get_browser_html: 创建页面失败 ${e?.message || e}`)
      return null
    })
    if (!page) return ''

    try {
      return await this.get_page_html(page, url)
    } finally {
      await page.close().catch(() => {})
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
  private async get_page_html(page: GentlemanPage, url: string): Promise<string> {
    const retry = Math.max(1, Number(this.config.detailPageRetry || 3))
    const retryDelay = Math.max(0, Number(this.config.challengeRetryDelayMs ?? 30_000))
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
    let coverFile = ''  // 追踪最后遇到的封面文件路径，用于后续复制到各章节目录

    if (!fs.existsSync(organizeMangaPath)) fs.mkdirSync(organizeMangaPath, { recursive: true })
    const organizeChapters = fs.readdirSync(organizeMangaPath)

    // 遍历下载目录中的每个章节子目录
    for (const chapter of sourceChapters) {
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
        const imageNum = imageNumRaw.split('.')[0]  // 去掉 .jpg 后缀
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
        if (fs.existsSync(chapterCover)) continue  // 已有封面则跳过
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

  /** 从章节图片列表的分页中，先完整收集全部详情页 URL。 */
  private async get_chapter_view_urls(
    chapter: ChapterInfo,
    url: string = chapter.url,
    visitedPages = new Set<string>()
  ): Promise<string[]> {
    if (visitedPages.has(url)) return []
    visitedPages.add(url)

    const html = await this.get_browser_html(url)
    const viewUrls = this.get_subpage_view_urls(html, url)
    if (viewUrls.length === 0) {
      throw new Error(`${chapter.name} 未在章节页找到图片详情页链接: ${url}`)
    }

    const pageBox = html.match(/(?<=paginator).+?(?=f_right)/s)?.[0] || ''
    const nextPage = pageBox.match(/(?<=next"><a\shref=").+?(?=">後頁)/s)?.[0] || ''
    if (!nextPage) return viewUrls

    const nextPageUrl = this.absolute_url(nextPage, url)
    const nextViewUrls = await this.get_chapter_view_urls(chapter, nextPageUrl, visitedPages)
    return [...new Set([...viewUrls, ...nextViewUrls])]
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
      const html = await this.get_page_html(page, viewUrl)
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
   * 获取某章节所有图片的完整 URL
   *
   * 处理流程：
   *   1. 先递归加载全部章节列表分页，收齐详情页链接，避免解析途中受限后丢失后续分页
   *   2. 复用同一个浏览器页签，限速访问每个详情页
   *   3. 从 #picarea 中读取带 verify 参数的原图 URL
   *   4. 安全验证页退避重试，最终数量不符时直接报错
   *
   * @param chapter 当前章节对象（images 字段会被原地更新）
   */
  private async get_chapter_images(chapter: ChapterInfo): Promise<string[]> {
    const viewUrls = await this.get_chapter_view_urls(chapter)
    if (chapter.imageNum && viewUrls.length !== chapter.imageNum) {
      throw new Error(
        `${chapter.name} 详情页数量不完整: 页面标注 ${chapter.imageNum} 张，实际找到 ${viewUrls.length} 个链接`
      )
    }

    const page = await gentlemanBrowser.new_page()
    if (!page) throw new Error(`${chapter.name} 无法创建图片详情页页签`)

    try {
      for (let index = 0; index < viewUrls.length; index++) {
        if (index > 0) await this.wait_before_detail_page()

        const viewUrl = viewUrls[index]
        this.onProgress?.message(`正在解析章节: ${chapter.name} (${index + 1}/${viewUrls.length})`)
        const imageUrl = await this.get_detail_image_url(page, chapter, viewUrl)
        if (!imageUrl || chapter.images.includes(imageUrl)) continue

        chapter.images.push(imageUrl)
      }
    } finally {
      await page.close().catch(() => {})
    }

    const expectedCount = chapter.imageNum || viewUrls.length
    if (chapter.images.length !== expectedCount) {
      throw new Error(
        `${chapter.name} 原图解析不完整: 预期 ${expectedCount} 张，实际 ${chapter.images.length} 张`
      )
    }

    write_log(`[gentleman] ${chapter.name} 图片解析完毕，共 ${chapter.images.length} 张`)
    return chapter.images
  }

  /**
   * 下载某章节的所有图片到本地目录
   *
   * 目录结构：mangaPath/{章节名}/{图片文件名}
   * 文件名直接复用 URL 最后一段（如 t4_images..._185_001.jpg）
   */
  private async download_chapter_images(item: ChapterInfo): Promise<void> {
    if (!item.images || item.images.length === 0) {
      write_log(`[gentleman] ${item.name} 无图片URL，跳过下载`)
      return
    }

    const chapterPath = path.join(this.mangaPath, item.name)
    if (!fs.existsSync(chapterPath)) {
      fs.mkdirSync(chapterPath, { recursive: true })
    }

    let successCount = 0
    for (let i = 0; i < item.images.length; i++) {
      const img = item.images[i]
      // URL 现在含有 ?verify=...，文件名只能取 pathname，否则 Windows 下的 ? 会导致写入失败。
      const fileName = this.get_image_file_name(img, i)
      const filePath = path.join(chapterPath, fileName)

      // 上报当前下载进度（章节内图片级进度）
      this.onProgress?.message(`正在下载章节: ${item.name} (${i + 1}/${item.images.length})`)
      this.onProgress?.subProgress?.(i + 1, item.images.length)

      const encodedImageUrl = img.replace(/ /g, '%20')
      const buffer =
        gentlemanBrowser.take_image_buffer(img) ||
        (encodedImageUrl !== img ? gentlemanBrowser.take_image_buffer(encodedImageUrl) : null)
      if (!buffer?.length) {
        throw new Error(`${item.name} 浏览器图片缓存缺失: ${img}`)
      }

      fs.writeFileSync(filePath, buffer)
      successCount++
    }
    write_log(
      `[gentleman] ${item.name} 下载完成: ${successCount}/${item.images.length} 张成功，全部来自浏览器缓存`
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
