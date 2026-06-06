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

import * as fs from 'fs'
import path from 'path'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe'
import { copy_folder, end_app, get_config, make_can_be_floder, write_log, get_failed_chapters } from '#utils/index'
import { betweenChapterDelay } from '#utils/human'
import { toomicsBrowser } from '#api/browser'
import { zip_directory } from '#utils/zip'
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
  private website: string = 'toomics'     // 配置 key，按语言区分：toomics-sc / toomics-tc / toomics-en
  private mangaId: number
  private mangaName: string
  private mangaUrl: string = ''

  // ── 路径配置 ──────────────────────────────────────────────
  private downloadPath: string            // 原始下载根目录
  private compressPath: string            // 压缩归档根目录
  private mangaPath: string = ''          // 本漫画下载目录
  private mangaCompressPath: string = ''  // 本漫画压缩目录
  private metaFolder: string = ''         // 元数据目录：mangaPath/.smanga

  // ── 配置选项 ──────────────────────────────────────────────
  private config: any
  private downloadLockedMeta: boolean
  private adult: boolean = false
  private scrollStep: number = 400
  private scrollDelay: number = 500
  private userName: string
  private passWord: string
  private langTag: string = 'sc'
  private jumpExist = true
  private maxRetry: number = 3

  // ── 运行时状态 ──────────────────────────────────────────────
  private meta: any = null
  private chapters: any = null
  private chapterCount: number = 0
  private pretendNum: number = 2          // 「假装下载」的章节数（模拟真人浏览）
  private params: subsribeType

  // ── 子模块 ──────────────────────────────────────────────
  private browserSession: ToomicsBrowserSession
  private chapterDownloader: ToomicsChapterDownloader
  private onProgress?: { setTotal: (n: number) => void; report: (msg: string) => void; message: (msg: string) => void }

  constructor(params: subsribeType, onProgress?: any) {
    // 根据 URL 中的语言标识确定站点变体
    if (params?.url && /tc/.test(params.url)) {
      this.langTag = 'tc'
      this.website = 'toomics-tc'
    } else if (params?.url && /en/.test(params.url)) {
      this.langTag = 'en'
      this.website = 'toomics-en'
    } else {
      this.langTag = 'sc'
      this.website = 'toomics-sc'
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
    this.adult = params.adult || false
    this.jumpExist = config?.jumpExist

    if (params.langTag) this.langTag = params.langTag
    if (params.chapterCount) this.chapterCount = Number(params.chapterCount)
    this.params = params
    if (onProgress) this.onProgress = onProgress

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
        onProgress: this.onProgress,
      })
    }

    this.onProgress?.message('元数据获取完成，准备下载章节')

    // Step 3: 构建章节下载列表（标记已下载的章节）
    const chapterList: ChapterListItem[] = this.buildChapterList()

    // Step 4: 筛选需要下载和假装下载的章节
    const chaptersToDownload = chapterList.filter((c) => !c.alreadyHas)
    const chaptersToNotDownload = chapterList.filter((c) => c.doNotDownload)

    // 计算「假装下载」数量：pretendNum - 实际需要下载的章节数
    // 目的：让总请求数接近 pretendNum，模拟真人随机浏览行为
    let pretendCount = this.pretendNum - chaptersToDownload.length
    const pretendDownload = pretendCount > 0 ? chaptersToNotDownload.slice(-pretendCount) : []

    if (chaptersToDownload.length > 0) {
      this.onProgress?.setTotal(chaptersToDownload.length)

      // 先「假装下载」已存在的章节（仅浏览不保存，模拟真人行为）
      for (const chapter of pretendDownload) {
        await this.chapterDownloader.downloadChapter(chapter)
        await betweenChapterDelay()
      }

      // 下载真正需要的新章节
      for (const chapter of chaptersToDownload) {
        await this.chapterDownloader.downloadChapter(chapter)
        await betweenChapterDelay()
      }
    }

    // Step 5: 可选压缩归档
    if (this.config?.autoCompress) {
      write_log(`[toomics] ${this.mangaName} 正在压缩`)
      await this.compress_manga()
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
      } else {
        // 目录不存在且未压缩，预创建目录
        fs.mkdirSync(chapterFolder, { recursive: true })
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
    const mangaFolder = `${this.downloadPath}/${this.mangaName}`
    const compressFolder = `${this.compressPath}/${this.mangaName}`

    // 统计本地已下载的章节目录数（排除 .smanga 元数据目录）
    let localChapters: string[] = []
    if (fs.existsSync(mangaFolder)) {
      localChapters = fs.readdirSync(mangaFolder).filter(
        (item) => fs.statSync(path.join(mangaFolder, item)).isDirectory() && item !== '.smanga'
      )
    }

    // 统计压缩目录中存在但本地目录中不存在的 zip 文件
    let compressedOnly: string[] = []
    if (fs.existsSync(compressFolder)) {
      compressedOnly = fs.readdirSync(compressFolder).filter(
        (item) => !localChapters.includes(item.replace('.zip', '')) && item.endsWith('.zip') && /\d/.test(item)
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
}
