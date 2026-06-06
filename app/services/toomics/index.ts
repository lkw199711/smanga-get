import * as fs from 'fs'
import path from 'path'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe'
import { copy_folder, delay, end_app, get_config, make_can_be_floder, write_log, get_failed_chapters } from '#utils/index'
import { betweenChapterDelay } from '#utils/human'
import { toomicsBrowser } from '#api/browser'
import { zip_directory } from '#utils/zip'
import { ToomicsBrowserSession } from './browser-session.js'
import { ToomicsMetaFetcher } from './meta-fetcher.js'
import { ToomicsChapterDownloader, ChapterInfo } from './chapter-downloader.js'

interface ChapterListItem extends ChapterInfo {
  alreadyHas?: boolean
}

export default class Toomics {
  private domain = 'https://toomics.com'
  private website: string = 'toomics'
  private mangaId: number
  private mangaName: string
  private mangaUrl: string = ''
  private downloadPath: string
  private compressPath: string
  private downloadLockedMeta: boolean
  private downloadLockedChapter: boolean = true
  private meta: any = null
  private chapters: any = null
  private adult: boolean = false
  private mangaFolder: string = ''
  private metaFolder: string = ''
  private downloadMetaError: boolean = false
  private retry: number = 0
  private maxRetry: number = 3
  private scrollStep: number = 400
  private scrollDelay: number = 500
  private userName: string
  private passWord: string
  private langTag: string = 'sc'
  private jumpExist = true
  private config: any
  private chapterCount: number = 0
  private pretendNum: number = 2
  private params: subsribeType
  private mangaPath: string = ''
  private mangaCompressPath: string = ''
  private onProgress?: { setTotal: (n: number) => void; report: (msg: string) => void; message: (msg: string) => void }

  private browserSession: ToomicsBrowserSession
  private chapterDownloader: ToomicsChapterDownloader

  constructor(params: subsribeType, onProgress?: any) {
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
   * @description: 开始下载
   */
  async start() {
    if (!this.check_update()) return
    console.log(this.mangaName + ' 正在分析')

    if (this.jumpExist && fs.existsSync(`${this.downloadPath}/${this.mangaName}`)) {
      write_log(`[toomics] ${this.mangaName} 已存在,跳过`)
      return
    }

    if (this.config?.jumpMangas && this.config.jumpMangas.includes(this.mangaName)) {
      write_log(`[toomics] ${this.mangaName} 在跳过列表中,跳过`)
      return
    }

    // 任务初始化（浏览器 + cookie + 登录）
    await this.browserSession.init()

    // 获取元数据
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

    // 更新 mangaName（可能是 title）
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

    // 构建章节列表
    const chapterList: ChapterListItem[] = []
    for (const chapter of this.chapters) {
      const chapterName = make_can_be_floder(chapter.name)
      const chapterFolder = `${this.downloadPath}/${this.mangaName}/${chapterName}`
      let alreadyHas = false

      if (fs.existsSync(chapterFolder)) {
        const files = fs.readdirSync(chapterFolder)
        if (files.length > 0) {
          alreadyHas = true
        }
      } else if (fs.existsSync(`${this.compressPath}/${this.mangaName}/${chapterName}.zip`)) {
        alreadyHas = true
      } else {
        await fs.promises.mkdir(chapterFolder, { recursive: true })
      }

      chapterList.push({
        chapterName,
        url: chapter.url,
        downloadPath: chapterFolder,
        alreadyHas,
        doNotDownload: alreadyHas,
      })
    }

    // 筛选需要下载和假装下载的章节
    const chaptersToDownload = chapterList.filter((c) => !(c as any).alreadyHas)
    const chaptersToNotDownload = chapterList.filter((c) => (c as any).doNotDownload)
    let pretendNum = this.pretendNum - chaptersToDownload.length
    let pretendDownload: any[] = []
    if (pretendNum > 0) pretendDownload = chaptersToNotDownload.slice(-pretendNum)

    if (chaptersToDownload.length > 0) {
      this.onProgress?.setTotal(chaptersToDownload.length)

      // 假装下载章节
      for (const chapter of pretendDownload) {
        await this.chapterDownloader.downloadChapter(chapter)
        await betweenChapterDelay()
      }

      // 下载章节
      for (const chapter of chaptersToDownload) {
        await this.chapterDownloader.downloadChapter(chapter)
        await betweenChapterDelay()
      }
    }

    // 压缩文件夹
    if (this.config?.autoCompress) {
      write_log(`[toomics] ${this.mangaName} 正在压缩`)
      await this.compress_manga()
    }

    console.log(this.mangaName + ' 订阅完毕')
    // 移除完结的订阅
    if (this.meta?.finished) {
      subscribe_remove({ website: this.website, id: this.mangaId })
      write_log(`[subscribe]${this.mangaName} 已移除订阅链接`)
    }

    // 自动结束程序
    end_app()
  }

  /**
   * @description 检查是否有更新
   */
  private check_update(): boolean {
    const mangaFloder = `${this.downloadPath}/${this.mangaName}`
    const compressFloder = `${this.compressPath}/${this.mangaName}`
    let mangaChapterFloders: string[] = []
    let mangacompressChapterFloders: string[] = []

    if (fs.existsSync(mangaFloder)) {
      mangaChapterFloders = fs.readdirSync(mangaFloder)
      mangaChapterFloders = mangaChapterFloders.filter((item) =>
        fs.statSync(path.join(mangaFloder, item)).isDirectory() && item !== '.smanga'
      )
    }

    if (fs.existsSync(compressFloder)) {
      mangacompressChapterFloders = fs.readdirSync(compressFloder)
      mangacompressChapterFloders = mangacompressChapterFloders.filter((item) => {
        return !mangaChapterFloders.includes(item.replace('.zip', ''))
          && item.endsWith('.zip')
          && /\d/.test(item)
      })
    }

    if (mangaChapterFloders.length + mangacompressChapterFloders.length + 0.9 < this.chapterCount) {
      return true
    }

    return false
  }

  async compress_manga() {
    // 复制元数据
    copy_folder(this.metaFolder, path.join(this.mangaCompressPath, '.smanga'))
    const chapters = fs.readdirSync(this.mangaPath);
    const failedChapters = get_failed_chapters() || [];
    for (const chapter of chapters) {
      const fullPath = path.join(this.mangaPath, chapter)
      if (chapter.startsWith('.')) continue
      if (failedChapters.includes(chapter)) continue
      if (!fs.statSync(fullPath).isDirectory()) {
        const targetFile = path.join(this.mangaCompressPath, chapter)
        fs.copyFileSync(fullPath, targetFile)
      } else {
        const files = fs.readdirSync(fullPath)
        if (files.length === 0) {
          fs.rmdirSync(fullPath)
          write_log(`[compress] 章节 ${chapter} 为空，跳过压缩并删除空目录`)
          continue
        }
        const compressChapterName = path.join(this.mangaCompressPath, chapter + '.zip')
        if (fs.existsSync(compressChapterName)) continue
        await zip_directory(fullPath, compressChapterName)
      }
    }
  }
}
