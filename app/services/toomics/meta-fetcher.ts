import * as fs from 'fs'
import path from 'path'
import { delay, end_app, make_can_be_floder, read_json, write_log } from '#utils/index'
import { humanScroll } from '#utils/human'
import { toomicsBrowser } from '#api/browser'
import { subscribe_remove } from '#api/subsribe'
import { ToomicsBrowserSession } from './browser-session.js'

export interface ToomicsMeta {
  title: string
  author: string
  finished: boolean
  audlt: boolean
  describe: string
  banner: string
  cover: string
  bannerBackground: string
  publishDate?: string
  chapters?: any[]
  covers?: string[]
}

export interface ToomicsChapter {
  name: string
  cover: string
  date: string
  url: string
  isFree: boolean
}

export class ToomicsMetaFetcher {
  private domain = 'https://toomics.com'
  private website: string
  private langTag: string
  private mangaId: number
  private mangaName: string
  private downloadPath: string
  private compressPath: string
  private metaFolder: string = ''
  private mangaFolder: string = ''
  private config: any
  private adult: boolean
  private scrollStep: number
  private scrollDelay: number
  private chapterCount: number
  private retry = 0

  private metaPageHtml: string = ''
  private meta: ToomicsMeta | null = null
  private chapters: ToomicsChapter[] = []
  private metaUpdate = false
  private downloadMetaError = false

  private onProgress?: { setTotal: (n: number) => void; report: (msg: string) => void; message: (msg: string) => void }

  constructor(opts: {
    website: string
    langTag: string
    mangaId: number
    mangaName: string
    downloadPath: string
    compressPath: string
    chapterCount: number
    config: any
    adult: boolean
    scrollStep: number
    scrollDelay: number
    onProgress?: any
  }) {
    this.website = opts.website
    this.langTag = opts.langTag
    this.mangaId = opts.mangaId
    this.mangaName = opts.mangaName
    this.downloadPath = opts.downloadPath
    this.compressPath = opts.compressPath
    this.chapterCount = opts.chapterCount
    this.config = opts.config
    this.adult = opts.adult
    this.scrollStep = opts.scrollStep
    this.scrollDelay = opts.scrollDelay
    if (opts.onProgress) this.onProgress = opts.onProgress
  }

  /** 检查是否有更新 */
  checkUpdate(): boolean {
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

  /**
   * 获取漫画元数据（含重试）
   * @returns meta 和 chapters，以及更新后的 mangaName
   */
  async fetchMeta(): Promise<{ meta: ToomicsMeta; chapters: ToomicsChapter[]; mangaName: string }> {
    console.log('正在获取元数据')
    if (!toomicsBrowser.browser) {
      throw new Error('浏览器未初始化')
    }

    // 获取元数据页html
    await this.getMetaHtml()

    let title = this.metaPageHtml?.match(/(?<=<h2.+>)[^<]+/s)?.[0] || ''
    title = title.trim()
    let author = this.metaPageHtml?.match(/(?<=mb-0 text-xs font-normal text-gray-300\">)[^<]+/s)?.[0] || ''
    author = author.trim()
    const describe = this.metaPageHtml?.match(/(?<=name=\"description\" content=\")[^\"]+/s)?.[0] || ''
    const banner = this.metaPageHtml?.match(/(?<=<!-- pc -->.+srcset=\")[^\"]+/s)?.[0] || ''
    const bannerBackground = this.metaPageHtml?.match(/(?<=<!-- pc bg -->.+src=\")[^\"]+/s)?.[0] || ''
    const cover = this.metaPageHtml?.match(/(?<=<!-- mobile -->.+src=\")[^\"]+/s)?.[0] || ''
    const finishedTxt = this.metaPageHtml?.match(/(?<=text-3xs font-bold text-gray-900\">)[^<]+/s)?.[0] || ''
    const finished = ['完结', '完結', 'End'].includes(finishedTxt.trim())

    this.meta = {
      title,
      author,
      finished,
      audlt: this.adult,
      describe,
      banner,
      cover,
      bannerBackground,
    }

    if (finished) {
      write_log(`[toomics update] ${this.mangaName}已完结。`)
      subscribe_remove({ website: this.website, id: this.mangaId })
      write_log(`[subscribe]${this.mangaName} 已移除订阅链接`)
    }

    const newMangaName = make_can_be_floder(title)
    this.mangaName = newMangaName
    this.metaFolder = `${this.downloadPath}/${newMangaName}/.smanga`
    this.mangaFolder = `${this.downloadPath}/${newMangaName}`

    // 获取章节列表
    this.getChapters()

    let downloadMetaError = false
    if (!toomicsBrowser.buffs[banner]) {
      console.log('横幅图片下载失败')
      downloadMetaError = true
    }
    if (!toomicsBrowser.buffs[bannerBackground]) {
      console.log('横幅背景图片下载失败')
      downloadMetaError = true
    }

    this.chapters.forEach((chapter) => {
      if (!toomicsBrowser.buffs[chapter.cover]) {
        console.log('章节封面图片下载失败', chapter.cover)
      }
    })

    // 下载元数据
    await this.downloadMeta()

    // 检测到错误图片 重新下载元数据
    if (downloadMetaError && this.retry < 3) {
      write_log(`[meta]${this.mangaName} 下载元数据失败,重新执行元数据获取`)
      this.downloadMetaError = true
      this.retry++
      return this.fetchMeta()
    } else {
      if (this.retry >= 3) {
        write_log(`[meta]${this.mangaName} 任务失败`)
        throw new Error('任务失败')
      }
      this.downloadMetaError = false
      toomicsBrowser.clear_buffs()
    }

    return { meta: this.meta!, chapters: this.chapters, mangaName: this.mangaName }
  }

  getChapters(): ToomicsChapter[] {
    const chapterBoxs = this.metaPageHtml?.match(/(?<=normal_ep).+?(?=<\/li>)/gs) || []
    const chapters = chapterBoxs.map((box: string) => {
      let index = box.match(/(?<=small>)[^<]+/s)?.[0] || ''
      index = index.trim()
      let subName = box.match(/(?<=strong.+?>)[^<]+/s)?.[0] || ''
      subName = subName.trim()
      if (subName === '') {
        subName = box.match(/(?<=Up<\/span>)[^<]+/s)?.[0] || ''
        subName = subName.trim()
      }
      const name = index + ' ' + subName
      const cover = box.match(/(?<=data-original=\")[^\"]+/)?.[0] || ''
      const date = box.match(/(?<=text-muted\">)[^<]+/s)?.[0] || ''
      const url = box.match(/\/(sc|tc|en)\/webtoon\/detail[^\']+/)?.[0] || ''

      let isFree = false
      const freeTxt = box.match(/(?<=class=\"label.+\">)[^<]+/s)?.[0] || ''
      if (freeTxt === '免费') {
        isFree = true
      }

      return { name, cover, date, url: this.domain + url, isFree }
    })

    // 更新元数据日期
    if (chapters.length > 0 && this.meta) {
      this.meta.publishDate = chapters[0].date
      this.meta.chapters = chapters
    }
    this.chapters = chapters
    return chapters
  }

  async downloadMeta(): Promise<void> {
    let homeMeta: any = null
    if (fs.existsSync('data/toomics-all.json')) {
      const json = read_json('data/toomics-all.json')
      const manga = json.find((m: any) => Number(m.id) === this.mangaId)
      if (manga) {
        homeMeta = manga
      }
    }

    // 创建元数据文件夹
    if (!fs.existsSync(this.metaFolder))
      await fs.promises.mkdir(this.metaFolder, { recursive: true })
    if (!fs.existsSync(this.mangaFolder))
      await fs.promises.mkdir(this.mangaFolder, { recursive: true })

    const metaFile = `${this.metaFolder}/meta.json`
    if (fs.existsSync(metaFile)) {
      const rawData = fs.readFileSync(metaFile, 'utf-8')
      const oldMetaData = JSON.parse(rawData)

      if (oldMetaData.chapters.length !== this.chapters.length) {
        this.metaUpdate = true
      }
    }

    // 写入封面
    if (homeMeta) {
      this.downloadCover(homeMeta.cover, `${this.metaFolder}/cover.jpg`, true)
      homeMeta.covers.forEach((cover: string, index: number) => {
        const coverName = `cover${index}.jpg`
        this.downloadCover(cover, `${this.metaFolder}/${coverName}`)
      })

      if (homeMeta.covers.length > (this.meta?.covers?.length ?? 0)) {
        if (this.meta) this.meta.covers = homeMeta.covers
        this.metaUpdate = true
      }
    }

    if (
      !fs.existsSync(metaFile) ||
      this.metaUpdate ||
      this.downloadMetaError
    ) {
      await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))

      fs.writeFileSync(`${this.metaFolder}/banner.jpg`, toomicsBrowser.buffs[this.meta!.banner])
      fs.writeFileSync(
        `${this.metaFolder}/bannerBackground.jpg`,
        toomicsBrowser.buffs[this.meta!.bannerBackground]
      )
    } else {
      console.log(this.mangaName + ' 没有更新')
    }

    // 下载章节封面
    for (let i = 0; i < this.chapters.length; i++) {
      const chapter = this.chapters[i]
      const chapterName = make_can_be_floder(chapter.name)
      const chapterCover = `${this.mangaFolder}/${chapterName}.jpg`
      if (!fs.existsSync(chapterCover) && toomicsBrowser.buffs[chapter.cover]) {
        fs.writeFileSync(chapterCover, toomicsBrowser.buffs[chapter.cover])
      }
    }
  }

  private downloadCover(url: string, localPath: string, overWrite = false): void {
    const imageName = url.split('/').pop()
    if (!imageName) return

    if (!overWrite && fs.existsSync(localPath)) return

    const imagePath = `${this.config.coverCache}/${this.mangaId}-${imageName}`
    if (!fs.existsSync(imagePath)) {
      console.error('封面图片不存在,请检查全部漫画获取程序', imagePath)
      return
    }
    const stat = fs.statSync(imagePath)
    if (stat.size < 1000) {
      console.error('封面图片大小异常,请检查全部漫画获取程序', imagePath)
      return
    }

    fs.copyFileSync(imagePath, localPath)
  }

  private async getMetaHtml(): Promise<void> {
    const metaPage = await toomicsBrowser.new_page()
    if (!metaPage) return
    metaPage.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    )
    const mangaUrl = `https://toomics.com/${this.langTag}/webtoon/episode/toon/${this.mangaId}`
    await metaPage
      .goto(mangaUrl, {
        waitUntil: 'networkidle2',
        referer: `https://toomics.com/${this.langTag}/webtoon/search`,
        timeout: 180 * 1000,
      })
      .catch(() => { })
    await delay(1000)
    await ToomicsBrowserSession.pauseIfMobileVerificationVisible(metaPage, mangaUrl, this.mangaName, this.onProgress)
    await toomicsBrowser.save_cookie()

    if (/ep\//.test(metaPage.url())) {
      await metaPage
        .locator('h1 a')
        .click()
        .catch(() => { })
      await metaPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
      await delay(2000)
      await toomicsBrowser.save_cookie()
    }

    // 人类化滚动
    console.log('开始滚动页面,等待加载图片')
    await metaPage.mouse.move(1000, 1000)

    // 快速滚回顶部
    await metaPage.evaluate(() => (globalThis as any).window.scrollTo(0, 0))
    await delay(500)

    // 向下人类化滚动
    await humanScroll({
      page: metaPage,
      scrollStep: this.scrollStep,
      scrollDelay: this.scrollDelay,
    })

    await metaPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
    await delay(1000)
    this.metaPageHtml = await metaPage.content()

    await metaPage.close()
  }
}
