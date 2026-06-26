/**
 * Gentleman 漫画订阅下载器
 *
 * 目标站点：wnacg.ru（绅士漫画）
 * 下载流程：
 *   1. 通过 Puppeteer 加载漫画目录页，解析所有章节链接
 *   2. 按配置规则过滤章节（名称正则匹配、包含/排除关键词）
 *   3. 逐章节获取图片 URL（支持分页递归），下载到本地目录
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
  prefix?: string    // 图片 CDN 域名前缀，首次解析后缓存，如 "t4.images.example.com"
  imageNum?: number  // 页面标注的图片总数（仅用于展示，不参与下载逻辑）
  images: string[]   // 解析出的所有图片完整 URL 列表
}

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
  private textPrefix: string = ''           // 图片 CDN 前缀，从第一张图解析后全局复用
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
    if (!gentlemanBrowser.browser || !(gentlemanBrowser.browser as any).isConnected?.()) {
      write_log(`[gentleman] 正在启动浏览器...`)
      await gentlemanBrowser.init()
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
      const gotoResult = await page
        .goto(url, {
          waitUntil: 'networkidle2',
          timeout: 60 * 1000,
        })
        .catch((e) => {
          write_log(`[gentleman] get_browser_html: 导航失败 ${e?.message || e}, url=${url.slice(0, 80)}`)
          return null
        })

      const html = await page.content()
      write_log(`[gentleman] get_browser_html: html长度=${html.length}, goto成功=${!!gotoResult}, url=${url.slice(0, 80)}`)
      return html
    } finally {
      await page.close().catch(() => {})
    }
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

  /**
   * 从章节列表页的 HTML 中解析出所有图片的完整 URL
   *
   * 站点图片区域 HTML 结构：
   *   <div class="gallary_wrap">
   *     <div class="gallary_item">
   *       <img src="//t4.images.../data/123/456/imagename.jpg" />
   *       <span class="name tb">imagename</span>
   *       ...pic_ctl...
   *     </div>
   *     ...
   *   </div>
   *   <div class="comment_wrap">
   *
   * 图片 URL 构建公式：
   *   https://{prefix中t替换为img}{imgTag路径}{图片名称}{后缀}
   *   例：https://img4.images.example.com/data/123/456/imagename.jpg
   */
  private get_subpage_images(html: string): string[] {
    const list: string[] = []

    // 提取图片区域：从 gallary_wrap 到 comment_wrap 之间的内容
    const imageBoxMatch = html.match(/(?<=gallary_wrap).+?(?=comment_wrap)/s)
    if (!imageBoxMatch) {
      write_log(`[gentleman] get_subpage_images: 未找到 gallary_wrap→comment_wrap 区域`)
      return list
    }

    // 分割出每个图片条目（以 gallary_item 为界）
    const srcMatches = imageBoxMatch[0].match(/(?<=gallary_item).+?(?=pic_ctl)/gs)
    if (!srcMatches) {
      write_log(`[gentleman] get_subpage_images: gallary_wrap内未找到 gallary_item 条目`)
      return list
    }

    let skippedView = 0, skippedTag = 0, skippedName = 0
    for (const m of srcMatches) {
      // 提取缩略图的 src 属性值（含 CDN 路径和图片标识）
      const viewMatch = m.match(/(?<=src=").+?(?=")/s)
      if (!viewMatch) { skippedView++; continue }
      const view = viewMatch[0]

      // 提取 data/t 之后的路径段（如 "123/456/"），用于拼接原图 URL
      const imgTagMatch = view.match(/(?<=data\/t)\/(\d+\/)(\d+\/)(?=\b)/)
      if (!imgTagMatch) { skippedTag++; continue }

      // 提取文件后缀（如 .jpg）
      const suffixMatch = view.match(/\.[^.]+$/)
      const suffix = suffixMatch ? suffixMatch[0] : ''

      // 提取图片名称（从 class="name tb" 的 span 内容中获取）
      const imgNameMatch = m.match(/(?<=name\stb">).+?(?=<)/)
      if (!imgNameMatch) { skippedName++; continue }

      // 将 CDN 前缀中的 "t" 替换为 "img"（缩略图域名 → 原图域名）
      const img = `https://${this.textPrefix.replace(/^t/, 'img')}${imgTagMatch[0]}${imgNameMatch[0]}${suffix}`
      list.push(img)
    }

    if (srcMatches.length > 0 && list.length < srcMatches.length) {
      write_log(`[gentleman] get_subpage_images: ${srcMatches.length}条目 → 跳过(view:${skippedView} tag:${skippedTag} name:${skippedName}) → 成功${list.length}`)
    }
    return list
  }

  /**
   * 获取某章节所有图片的完整 URL（递归处理分页）
   *
   * 处理流程：
   *   1. 加载章节列表页 HTML
   *   2. 首次调用时解析图片 CDN 前缀（从第一张图的 src 中提取，后续复用）
   *   3. 解析当前页的所有图片 URL
   *   4. 若存在「後頁」分页链接，递归加载下一页继续解析
   *
   * @param chapter 当前章节对象（prefix 和 images 字段会被原地更新）
   * @param url     当前页 URL，默认使用章节的列表页地址
   */
  private async get_chapter_images(chapter: ChapterInfo, url: string = chapter.url): Promise<string[]> {
    const html = await this.get_browser_html(url)

    // 首次进入章节时解析 CDN 前缀：打开章节内第一张图的查看页，从 imgarea 中提取 src 域名
    if (!chapter.prefix) {
      // 获取第一张图片的查看页链接（格式：/photos-view-id-xxx.html）
      const firstViewUrlMatch = html.match(/\/photos-view-id-[^\"]+/)
      const firstViewUrl = firstViewUrlMatch ? firstViewUrlMatch[0] : ''
      const viewHtml = await this.get_browser_html(this.domain + firstViewUrl)

      // 从 id="imgarea" 的 span 中提取图片 src 的域名部分（如 t4.images.example.com/data）
      const imgAreaMatch = viewHtml.match(/<span[^>]*id=["']imgarea["'][^>]*>(.*?)<\/span>/s)
      const imgAreaContent = imgAreaMatch ? imgAreaMatch[1] : viewHtml

      chapter.prefix = imgAreaContent.match(/(?<=src="\/\/).+?\/data/)?.[0] || ''
      // 缓存到类属性，供 get_subpage_images 中 CDN 域名替换使用
      this.textPrefix = chapter.prefix
    }

    // 解析当前页的所有图片 URL 并追加到章节图片列表
    const pageImages = this.get_subpage_images(html)
    chapter.images = chapter.images.concat(pageImages)

    // 查找分页导航中的「後頁」链接（位于 class="paginator" 区域内）
    const pageBox = html.match(/(?<=paginator).+?(?=f_right)/s)?.[0] || ''
    const nextPage = pageBox.match(/(?<=next"><a\shref=").+?(?=">後頁)/s)?.[0] || ''

    if (nextPage) {
      // 拼接下一页完整 URL 并递归处理
      const page = `https://${this.domain.replace(/^https?:\/\//, '')}${nextPage}`
      return await this.get_chapter_images(chapter, page)
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
      const fileName = img.split('/').pop() || ''  // 取 URL 最后一段作为文件名
      const filePath = path.join(chapterPath, fileName)

      // 上报当前下载进度（章节内图片级进度）
      this.onProgress?.message(`正在下载章节: ${item.name} (${i + 1}/${item.images.length})`)
      this.onProgress?.subProgress?.(i + 1, item.images.length)

      await this.download_image(img, filePath)
      if (fs.existsSync(filePath)) successCount++
    }
    write_log(`[gentleman] ${item.name} 下载完成: ${successCount}/${item.images.length} 张成功`)
  }

  /**
   * 下载单张图片到本地文件，支持失败自动重试
   *
   * @param url      图片完整 URL
   * @param filePath 本地保存路径
   * @param retry    最大重试次数（默认 7 次）
   */
  private async download_image(url: string, filePath: string, retry = 7): Promise<void> {
    for (let attempt = 1; attempt <= retry; attempt++) {
      try {
        // 使用 AbortController 实现 30 秒超时，避免慢响应导致任务永久挂起
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 30_000)
        const response = await fetch(url, { signal: controller.signal })
        clearTimeout(timeoutId)

        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const arrayBuffer = await response.arrayBuffer()
        fs.writeFileSync(filePath, Buffer.from(arrayBuffer))
        return  // 下载成功，直接返回
      } catch (err) {
        if (attempt === retry) {
          // 所有重试均失败，记录日志并跳过此图（不抛出异常，允许流程继续）
          write_log(`[download] 图片下载最终失败，跳过: ${url}`)
        }
      }
    }
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
