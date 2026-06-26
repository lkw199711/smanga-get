/**
 * Toomics 漫画订阅下载器（主协调器）
 *
 * 整体下载流程：
 *   1. 检查是否有新章节更新（本地章节数 < 订阅记录的章节数）
 *   2. 跳过已存在的漫画目录 / 跳过列表中的漫画
 *   3. 初始化浏览器会话（cookie + 登录）
 *   4. 获取元数据（标题、作者、封面、章节列表）
 *   5. 构建章节下载列表，标记已下载的章节
 *   6. 「假装下载」部分已下载章节（模拟真人随机浏览行为，降低风控概率）
 *   7. 下载新章节
 *   8. 可选压缩归档
 *   9. 完结漫画自动移除订阅
 *
 * 子模块职责划分：
 *   - ToomicsBrowserSession：浏览器初始化、cookie 管理、登录
 *   - ToomicsMetaFetcher：元数据获取、章节列表解析、封面写入
 *   - ToomicsChapterDownloader：单章节图片下载（含重试/熔断）
 */

import * as fs from 'node:fs'
import path from 'node:path'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe'
import {
  copy_folder,
  end_app,
  get_config,
  make_can_be_floder,
  write_log,
  get_failed_chapters,
} from '#utils/index'
import {
  betweenChapterDelay,
  betweenMangaDelay,
  fastScroll,
  randomDelay,
  randomInt,
  DEFAULT_PERSONA,
} from '#utils/human'
import { toomicsBrowser } from '#api/browser'
import { zip_directory } from '#utils/zip'
import { tryIndexMangaMetaFile, recordChapterDownload } from '#api/manga'
import { getAntiBotScheduler } from '#services/scheduler'
import { ToomicsBrowserSession } from './browser-session.js'
import { ToomicsMetaFetcher } from './meta-fetcher.js'
import { ToomicsChapterDownloader, ChapterInfo } from './chapter-downloader.js'

/** 扩展 ChapterInfo，增加本地存在性标记 */
interface ChapterListItem extends ChapterInfo {
  alreadyHas?: boolean // 本地是否已有该章节（目录非空或 zip 存在）
}

export default class Toomics {
  // ── 站点与身份 ──────────────────────────────────────────────
  private domain = 'https://toomics.com'
  private website: string = 'toomics' // 配置 key，按语言区分：toomics-sc / toomics-tc / toomics-en
  private mangaId: number
  private mangaName: string
  private mangaUrl: string = ''

  // ── 路径配置 ──────────────────────────────────────────────
  private downloadPath: string // 原始下载根目录
  private compressPath: string // 压缩归档根目录
  private mangaPath: string = '' // 本漫画下载目录
  private mangaCompressPath: string = '' // 本漫画压缩目录
  private metaFolder: string = '' // 元数据目录：mangaPath/.smanga

  // ── 配置选项 ──────────────────────────────────────────────
  private config: any
  private downloadLockedMeta: boolean
  private adult: boolean = false
  private scrollStep: number = 400
  private scrollDelay: number = 500
  private userName: string
  private passWord: string
  private langTag: string = 'tc'
  private jumpExist = true
  private maxRetry: number = 3
  private downloadChapterLimit: number = 0
  private e2eFastMode = false

  // ── 运行时状态 ──────────────────────────────────────────────
  private meta: any = null
  private chapters: any = null
  private chapterCount: number = 0
  private pretendNum: number = 0 // 「假装下载」的章节数（每次投骰决定）
  private antiBotConfig: any // 反爬共享配置（来自 toomics 主配置节）
  private mangaDownloadedCount = 0 // 噪声浏览间隔计数器
  private params: subsribeType

  // ── 子模块 ──────────────────────────────────────────────
  private browserSession: ToomicsBrowserSession
  private chapterDownloader: ToomicsChapterDownloader
  private onProgress?: {
    setTotal: (n: number) => void
    report: (msg: string) => void
    message: (msg: string) => void
  }

  constructor(params: subsribeType, onProgress?: any) {
    // 根据 URL 中的语言标识确定站点变体
    if (params?.url && /tc/.test(params.url)) {
      this.langTag = 'tc'
      this.website = 'toomics-tc'
    } else if (params?.url && /en/.test(params.url)) {
      this.langTag = 'en'
      this.website = 'toomics-en'
    } else {
      this.langTag = 'tc'
      this.website = 'toomics-tc'
    }

    const config = get_config(this.website) || {}
    this.downloadPath = config?.downloadPath || ''
    this.compressPath = config?.compressPath || ''
    this.config = config
    this.mangaId = Number(params.id)
    this.mangaName = make_can_be_floder(params.name)
    this.mangaPath = `${this.downloadPath}/${this.mangaName}`
    this.mangaCompressPath = `${this.compressPath}/${this.mangaName}`
    this.metaFolder = `${this.mangaPath}/.smanga`
    this.downloadLockedMeta = config?.downloadLockedMeta
    this.userName = config?.userName || ''
    this.passWord = config?.passWord || ''
    this.scrollStep = config?.scrollStep || this.scrollStep
    this.scrollDelay = config?.scrollDelay || this.scrollDelay
    this.maxRetry = config?.maxRetry || this.maxRetry
    this.downloadChapterLimit = Number(config?.downloadChapterLimit || 0)
    this.adult = params.adult || false
    this.jumpExist = config?.jumpExist

    if (params.langTag) this.langTag = params.langTag
    if (params.chapterCount) this.chapterCount = Number(params.chapterCount)
    this.params = params
    if (onProgress) this.onProgress = onProgress

    // 读取反爬共享配置
    this.antiBotConfig = get_config('toomics') || {}
    this.e2eFastMode = Boolean(config?.e2eFastMode || this.antiBotConfig?.e2eFastMode)

    // 初始化子模块
    this.browserSession = new ToomicsBrowserSession({
      langTag: this.langTag,
      userName: this.userName,
      passWord: this.passWord,
      config: this.config,
    })

    this.chapterDownloader = new ToomicsChapterDownloader({
      mangaName: this.mangaName,
      mangaUrl: this.mangaUrl,
      downloadPath: this.downloadPath,
      compressPath: this.compressPath,
      scrollStep: this.scrollStep,
      scrollDelay: this.scrollDelay,
      maxRetry: this.maxRetry,
      persona: this.getReaderPersona(),
      fastScrollDurationMs: this.antiBotConfig?.homePageScrollMin
        ? randomInt(this.antiBotConfig.homePageScrollMin, this.antiBotConfig.homePageScrollMax)
        : 20000,
      onProgress: this.onProgress,
    })
  }

  /**
   * 主入口：执行完整的订阅下载流程
   */
  async start() {
    // 前置检查：是否有新章节需要下载
    if (!this.check_update()) return
    console.log(`${this.mangaName} 正在分析`)

    // 跳过已完整下载的漫画
    if (this.jumpExist && fs.existsSync(`${this.downloadPath}/${this.mangaName}`)) {
      write_log(`[toomics] ${this.mangaName} 已存在，跳过`)
      return
    }

    // 跳过配置中指定的漫画
    if (this.config?.jumpMangas && this.config.jumpMangas.includes(this.mangaName)) {
      write_log(`[toomics] ${this.mangaName} 在跳过列表中，跳过`)
      return
    }

    // Step 1: 浏览器初始化（cookie + 登录检测）
    await this.browserSession.init()

    // 登录后噪声浏览（模拟真人看完推荐才去追更）
    if (this.antiBotConfig?.noiseEnabled !== false) {
      await this.noiseBrowseAfterLogin()
    }

    // Step 2: 获取元数据（标题、章节列表、封面等）
    const metaFetcher = new ToomicsMetaFetcher({
      website: this.website,
      langTag: this.langTag,
      mangaId: this.mangaId,
      mangaName: this.mangaName,
      downloadPath: this.downloadPath,
      compressPath: this.compressPath,
      chapterCount: this.chapterCount,
      config: this.config,
      adult: this.adult,
      scrollStep: this.scrollStep,
      scrollDelay: this.scrollDelay,
      onProgress: this.onProgress,
    })
    const { meta, chapters, mangaName } = await metaFetcher.fetchMeta()
    this.meta = meta
    this.chapters = chapters

    // 若标题与订阅名不同，更新相关路径和下载器实例
    if (this.mangaName !== mangaName) {
      this.mangaName = mangaName
      this.mangaPath = `${this.downloadPath}/${this.mangaName}`
      this.mangaCompressPath = `${this.compressPath}/${this.mangaName}`
      this.chapterDownloader = new ToomicsChapterDownloader({
        mangaName: this.mangaName,
        mangaUrl: this.mangaUrl,
        downloadPath: this.downloadPath,
        compressPath: this.compressPath,
        scrollStep: this.scrollStep,
        scrollDelay: this.scrollDelay,
        maxRetry: this.maxRetry,
        persona: this.getReaderPersona(),
        fastScrollDurationMs: this.antiBotConfig?.homePageScrollMin
          ? randomInt(this.antiBotConfig.homePageScrollMin, this.antiBotConfig.homePageScrollMax)
          : 20000,
        onProgress: this.onProgress,
      })
    }

    this.onProgress?.message('元数据获取完成，准备下载章节')

    // Step 3: 概率化 pretendNum（每次投骰决定回翻几话）
    this.rollPretendNum()

    // Step 4: 构建章节下载列表（标记已下载的章节）
    const chapterList: ChapterListItem[] = this.buildChapterList()

    // Step 5: 筛选需要下载和假装下载的章节
    const chaptersToDownload = this.limitChaptersToDownload(
      chapterList.filter((c) => !c.alreadyHas)
    )
    const chaptersToNotDownload = chapterList.filter((c) => c.doNotDownload)

    // 先建立 manga_result，获取 mangaResultId 供逐章入库使用
    const metaFile = `${this.metaFolder}/meta.json`
    const indexResult = await tryIndexMangaMetaFile(metaFile, {
      website: this.website,
      source: 'download',
      sourcePath: `${this.downloadPath}/${this.mangaName}`,
    })
    const mangaResultId = indexResult?.indexId ?? 0

    // 计算「假装下载」数量
    let pretendCount = this.pretendNum - chaptersToDownload.length
    const pretendDownload = pretendCount > 0 ? chaptersToNotDownload.slice(-pretendCount) : []

    if (chaptersToDownload.length > 0) {
      this.onProgress?.setTotal(chaptersToDownload.length)

      // 先「假装下载」已存在的章节（足迹模式）
      for (const chapter of pretendDownload) {
        await this.chapterDownloader.downloadChapter(chapter)
        await this.afterChapterDownload()
      }

      // 下载真正需要的新章节
      let downloadedCount = 0
      for (const chapter of chaptersToDownload) {
        await this.chapterDownloader.downloadChapter(chapter)
        downloadedCount++
        // 逐章入库：记录本次实际下载的章节
        if (mangaResultId > 0) {
          const serverChapter = this.chapters.find((c: any) => c.url === chapter.url)
          if (serverChapter) {
            recordChapterDownload(mangaResultId, { name: serverChapter.name, date: serverChapter.date, url: serverChapter.url, cover: serverChapter.cover, isFree: serverChapter.isFree }, downloadedCount).catch(() => {})
          }
        }
        await this.afterChapterDownload()
      }

      if (downloadedCount > 0) {
        // 上报调度器：本漫画实际下载了章节，消耗 1 个配额
        getAntiBotScheduler()?.reportMangaDownloaded()
      }
    }

    // Step 5: 可选压缩归档（下载完成后立即执行，不等待任何延时）
    if (this.config?.autoCompress) {
      write_log(`[toomics] ${this.mangaName} 正在压缩`)
      await this.compress_manga()
    }

    // 下载后延时（仅当有实际下载时执行，放在压缩之后避免阻塞归档）
    if (chaptersToDownload.length > 0) {
      this.mangaDownloadedCount++
      await this.afterMangaDownload()
      await this.noiseBrowseBetweenManga()
    }

    console.log(`${this.mangaName} 订阅完毕`)

    // Step 6: 完结漫画自动移除订阅
    if (this.meta?.finished) {
      subscribe_remove({ website: this.website, id: this.mangaId })
      write_log(`[subscribe] ${this.mangaName} 已移除订阅链接`)
    }

    end_app()
  }

  /**
   * 构建章节下载列表
   *
   * 遍历所有章节，检查本地是否已存在（目录非空或 zip 文件存在），
   * 标记 alreadyHas 和 doNotDownload 字段
   */
  private buildChapterList(): ChapterListItem[] {
    const chapterList: ChapterListItem[] = []

    for (const chapter of this.chapters) {
      const chapterName = make_can_be_floder(chapter.name)
      const chapterFolder = `${this.downloadPath}/${this.mangaName}/${chapterName}`
      let alreadyHas = false

      if (fs.existsSync(chapterFolder)) {
        const files = fs.readdirSync(chapterFolder)
        if (files.length > 0) alreadyHas = true
      } else if (fs.existsSync(`${this.compressPath}/${this.mangaName}/${chapterName}.zip`)) {
        alreadyHas = true
      }

      chapterList.push({
        chapterName,
        url: chapter.url,
        downloadPath: chapterFolder,
        alreadyHas,
        doNotDownload: alreadyHas,
      })
    }

    return chapterList
  }

  /**
   * 检查是否有新章节需要下载
   *
   * 通过比较本地已有章节数（目录 + zip 文件）与订阅记录的章节数，
   * 若本地数量 + 0.9 < 订阅数量，则认为有更新
   * （0.9 的容差用于处理章节序号从 0 或 1 开始的偏移）
   */
  private check_update(): boolean {
    // 修复模式：强制跳过章节更新检查，重新下载
    // if (process.env.FORCE_CHAPTER_UPDATE === '1') return true

    const mangaFolder = `${this.downloadPath}/${this.mangaName}`
    const compressFolder = `${this.compressPath}/${this.mangaName}`

    // 统计本地已下载的章节目录数（排除 .smanga 元数据目录）
    let localChapters: string[] = []
    if (fs.existsSync(mangaFolder)) {
      localChapters = fs
        .readdirSync(mangaFolder)
        .filter(
          (item) => fs.statSync(path.join(mangaFolder, item)).isDirectory() && item !== '.smanga'
        )
    }

    // 统计压缩目录中存在但本地目录中不存在的 zip 文件
    let compressedOnly: string[] = []
    if (fs.existsSync(compressFolder)) {
      compressedOnly = fs
        .readdirSync(compressFolder)
        .filter(
          (item) =>
            !localChapters.includes(item.replace('.zip', '')) &&
            item.endsWith('.zip') &&
            /\d/.test(item)
        )
    }

    // 本地总章节数 + 0.9 容差 < 订阅章节数 → 有更新
    return localChapters.length + compressedOnly.length + 0.9 < this.chapterCount
  }

  /**
   * 将下载目录压缩归档
   *
   * 流程：
   *   1. 复制 .smanga 元数据到压缩目录
   *   2. 遍历每个章节目录，压缩为 zip（跳过空目录和失败章节）
   *   3. 跳过已存在的 zip（增量压缩）
   */
  private async compress_manga() {
    // 复制元数据到压缩目录
    copy_folder(this.metaFolder, path.join(this.mangaCompressPath, '.smanga'))

    const chapters = fs.readdirSync(this.mangaPath)
    const failedChapters = get_failed_chapters() || []

    for (const chapter of chapters) {
      const fullPath = path.join(this.mangaPath, chapter)
      if (chapter.startsWith('.')) continue
      if (failedChapters.includes(chapter)) continue

      if (!fs.statSync(fullPath).isDirectory()) {
        // 非目录文件（如封面图片）直接复制
        fs.copyFileSync(fullPath, path.join(this.mangaCompressPath, chapter))
      } else {
        const files = fs.readdirSync(fullPath)
        if (files.length === 0) {
          // 空目录（下载失败的章节）→ 删除并跳过
          fs.rmdirSync(fullPath)
          write_log(`[compress] 章节 ${chapter} 为空，跳过压缩并删除空目录`)
          continue
        }

        const zipPath = path.join(this.mangaCompressPath, chapter + '.zip')
        if (fs.existsSync(zipPath)) continue // 已压缩则跳过（增量）
        await zip_directory(fullPath, zipPath)
      }
    }
  }

  /**
   * 概率化 pretendNum（每次下载漫画时掷骰）
   *
   * 根据 antiBotConfig.pretendNumWeights 决定回翻几话：
   *   50% → 0（直接看新章节）
   *   25% → 1（回翻 1 话，足迹模式）
   *   25% → 2（回翻 2 话，足迹模式）
   *
   * 若配置为 'fixed' 策略，则固定回翻 2 话。
   */
  private rollPretendNum(): void {
    const strategy = this.antiBotConfig?.pretendNumStrategy || 'probability'

    if (strategy === 'fixed') {
      this.pretendNum = 2
      return
    }

    // 概率策略：按权重掷骰
    const weights = this.antiBotConfig?.pretendNumWeights || [0.5, 0.25, 0.25]
    const roll = Math.random()
    let cumulative = 0

    for (const [i, weight] of weights.entries()) {
      cumulative += weight
      if (roll < cumulative) {
        this.pretendNum = i
        break
      }
    }

    write_log(`[toomics] ${this.mangaName} pretendNum 掷骰结果: ${this.pretendNum}`)
  }

  /**
   * E2E 测试只验证下载链路，可通过 downloadChapterLimit 限制真实下载章节数。
   * 生产配置不设置该字段时保持原行为。
   */
  private limitChaptersToDownload(chapters: ChapterListItem[]): ChapterListItem[] {
    const limitedChapters =
      this.downloadChapterLimit > 0 ? chapters.slice(0, this.downloadChapterLimit) : chapters

    for (const chapter of limitedChapters) {
      fs.mkdirSync(chapter.downloadPath, { recursive: true })
    }

    return limitedChapters
  }

  /**
   * 快速模式使用零延迟阅读人格，避免 E2E 测试被真人化阅读等待拖慢。
   */
  private getReaderPersona() {
    if (!this.e2eFastMode) return this.antiBotConfig?.readerPersona || DEFAULT_PERSONA

    return {
      ...DEFAULT_PERSONA,
      pageReadMin: 0,
      pageReadMax: 0,
      keyPageRatio: 0,
      keyPageMin: 0,
      keyPageMax: 0,
      backFlipProb: 0,
      chapterEndExtraMin: 0,
      chapterEndExtraMax: 0,
    }
  }

  private async afterChapterDownload() {
    if (this.e2eFastMode) return

    await betweenChapterDelay()
  }

  private async afterMangaDownload() {
    if (this.e2eFastMode) return

    await betweenMangaDelay()
  }

  /**
   * 登录后噪声浏览
   *
   * 模拟真人在登录后会先看推荐、逛首页，而不是直接开始下载。
   * 浏览首页 30~60 秒（足迹模式），产生正常的浏览请求序列。
   */
  private async noiseBrowseAfterLogin(): Promise<void> {
    if (!toomicsBrowser.browser) return

    try {
      write_log(`[toomics] ${this.mangaName} 登录后噪声浏览`)
      const noisePage = await toomicsBrowser.new_page()
      if (!noisePage) return

      // 访问首页
      await noisePage
        .goto(`${this.domain}/${this.langTag}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 30 * 1000,
        })
        .catch(() => {})

      // 足迹模式滚动首页（像在浏览推荐）
      const scrollMin = this.antiBotConfig?.homePageScrollMin || 30000
      const scrollMax = this.antiBotConfig?.homePageScrollMax || 60000
      const scrollDuration = randomInt(scrollMin, scrollMax)
      await fastScroll(noisePage, scrollDuration)

      // 关闭噪声页面
      await noisePage.close().catch(() => {})
    } catch {
      // 噪声浏览失败不影响主流程
    }
  }

  /**
   * 任务间隙噪声浏览
   *
   * 每 noiseIntervalTaskCount 部漫画后暂停下载，逛首页 15~30 秒。
   * 模拟真人在追完几部后会回去看推荐/搜索新漫画。
   */
  private async noiseBrowseBetweenManga(): Promise<void> {
    if (this.antiBotConfig?.noiseEnabled === false) return

    const interval = this.antiBotConfig?.noiseIntervalTaskCount || 4
    if (this.mangaDownloadedCount % interval !== 0) return

    if (!toomicsBrowser.browser) return

    try {
      write_log(`[toomics] ${this.mangaName} 任务间隙噪声浏览 (第 ${this.mangaDownloadedCount} 部)`)
      const noisePage = await toomicsBrowser.new_page()
      if (!noisePage) return

      // 访问首页
      await noisePage
        .goto(`${this.domain}/${this.langTag}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 30 * 1000,
        })
        .catch(() => {})

      // 短期足迹滚动
      await fastScroll(noisePage, randomInt(15000, 30000))

      // 关闭噪声页面
      await noisePage.close().catch(() => {})
    } catch {
      // 噪声浏览失败不影响主流程
    }
  }
}
