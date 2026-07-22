/**
 * Toomics 元数据获取器
 *
 * 职责：
 *   1. 打开漫画详情页（移动端 UA），提取元数据（标题、作者、简介、封面等）
 *   2. 解析章节列表（名称、封面、日期、URL、是否免费）
 *   3. 从浏览器内存 buffer 中读取图片，写入 .smanga 元数据目录
 *   4. 支持自动重试（banner/bannerBackground 加载失败时重新获取）
 *   5. 检测手机号验证弹框并暂停任务
 */

import * as fs from 'fs'
import path from 'path'
import { delay, make_can_be_floder, read_json, write_log, dataRoot, TaskSkipError } from '#utils/index'
import { humanScroll } from '#utils/human'
import { toomicsBrowser } from '#api/browser'
import { subscribe_remove } from '#api/subsribe'
import { ToomicsBrowserSession } from './browser-session.js'

/** 漫画元数据（标题、作者、封面等，写入 .smanga/meta.json） */
export interface ToomicsMeta {
  title: string
  author: string
  finished: boolean
  audlt: boolean
  describe: string
  banner: string           // 横幅图片 URL（PC 端展示用）
  cover: string            // 封面图片 URL（移动端展示用）
  bannerBackground: string // 横幅背景图 URL
  publishDate?: string     // 最新章节发布日期
  chapters?: any[]         // 章节列表快照
  covers?: string[]        // 历史封面 URL 集合（来自 toomics-all.json）
  banners?: string[]       // 历史横幅图片 URL 合集（meta.json 自维护）
  bannerBackgrounds?: string[] // 历史横幅背景图 URL 合集（meta.json 自维护）
}

/** 单个章节信息 */
export interface ToomicsChapter {
  name: string    // 章节名（如 "第01话 开端"）
  cover: string   // 章节封面图 URL
  date: string    // 发布日期
  url: string     // 详情页完整 URL
  isFree: boolean // 是否免费阅读
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

  private metaPageHtml: string = ''
  private meta: ToomicsMeta | null = null
  private chapters: ToomicsChapter[] = []
  private metaUpdate = false
  private downloadMetaError = false
  private retry = 0

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

  /**
   * 获取漫画元数据（含自动重试）
   *
   * 流程：
   *   1. 打开详情页获取 HTML → 正则解析元数据字段
   *   2. 解析章节列表
   *   3. 检查 banner/bannerBackground 是否在 buffer 中
   *   4. 调用 downloadMeta() 写入磁盘
   *   5. 若图片加载失败，重试整个流程（最多 3 次）
   *
   * @returns meta、chapters 和可能更新后的 mangaName
   */
  async fetchMeta(): Promise<{ meta: ToomicsMeta; chapters: ToomicsChapter[]; mangaName: string }> {
    console.log('正在获取元数据')
    if (!toomicsBrowser.browser) {
      throw new Error('浏览器未初始化')
    }

    // 重置重试状态（fetchMeta 可能被外部多次调用）
    this.retry = 0

    return await this.fetchMetaWithRetry()
  }

  /** 带重试的元数据获取核心逻辑 */
  private async fetchMetaWithRetry(): Promise<{ meta: ToomicsMeta; chapters: ToomicsChapter[]; mangaName: string }> {
    // Step 1: 获取详情页 HTML
    await this.getMetaHtml()

    // Step 2: 从 HTML 中用正则提取元数据字段
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

    this.meta = { title, author, finished, audlt: this.adult, describe, banner, cover, bannerBackground }

    if (finished) {
      write_log(`[toomics update] ${this.mangaName} 已完结。`)
      subscribe_remove({ website: this.website, id: this.mangaId })
      write_log(`[subscribe] ${this.mangaName} 已移除订阅链接`)
    }

    // 用标题更新漫画名（可能与订阅传入的名称不同）
    const newMangaName = make_can_be_floder(title)
    this.mangaName = newMangaName
    this.metaFolder = path.join(this.downloadPath, newMangaName, '.smanga')
    this.mangaFolder = path.join(this.downloadPath, newMangaName)

    // Step 3: 解析章节列表
    this.parseChapters()

    // Step 4: 检查关键图片是否在浏览器 buffer 中成功加载
    let downloadMetaError = false
    if (!toomicsBrowser.buffs[banner]) {
      console.log('横幅图片下载失败')
      downloadMetaError = true
    }
    if (!toomicsBrowser.buffs[bannerBackground]) {
      console.log('横幅背景图片下载失败')
      downloadMetaError = true
    }
    for (const chapter of this.chapters) {
      if (!toomicsBrowser.buffs[chapter.cover]) {
        console.log('章节封面图片下载失败', chapter.cover)
      }
    }

    // Step 5: 写入元数据到磁盘
    await this.downloadMeta()

    // Step 6: 若图片加载失败，重试整个流程（最多 3 次）
    if (downloadMetaError && this.retry < 3) {
      write_log(`[meta] ${this.mangaName} 下载元数据失败，重新执行元数据获取 (第 ${this.retry + 1} 次)`)
      this.downloadMetaError = true
      this.retry++
      return this.fetchMetaWithRetry()
    }

    if (this.retry >= 3) {
      write_log(`[meta] ${this.mangaName} 元数据获取失败，重试次数已用尽`)
      throw new Error('元数据获取失败')
    }

    this.downloadMetaError = false
    toomicsBrowser.clear_buffs()

    return { meta: this.meta!, chapters: this.chapters, mangaName: this.mangaName }
  }

  /**
   * 从详情页 HTML 中解析章节列表
   *
   * HTML 结构（每个章节条目）：
   *   <div class="normal_ep ...">
   *     <span class="small">第01话</span>           ← index
   *     <strong>开端</strong>                        ← subName
   *     <img data-original="https://...cover.jpg" /> ← cover
   *     <span class="text-muted">2024-01-15</span>   ← date
   *     <a href="/sc/webtoon/detail/toon-12345/ep/1"> ← url
   *     <span class="label ...">免费</span>           ← isFree
   *   </div>
   */
  private parseChapters(): ToomicsChapter[] {
    const chapterBoxs = this.metaPageHtml?.match(/(?<=normal_ep).+?(?=<\/li>)/gs) || []
    const chapters = chapterBoxs.map((box: string) => {
      // 章节序号（如 "第01话"）
      let index = box.match(/(?<=small>)[^<]+/s)?.[0] || ''
      index = index.trim()

      // 章节副标题（优先从 strong 标签提取，备选从 Up 标记后提取）
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

      // 检测免费标记
      const freeTxt = box.match(/(?<=class=\"label.+\">)[^<]+/s)?.[0] || ''
      const isFree = freeTxt === '免费'

      return { name, cover, date, url: this.domain + url, isFree }
    })

    // 更新元数据中的发布日期和章节快照
    if (chapters.length > 0 && this.meta) {
      this.meta.publishDate = chapters[0].date
      this.meta.chapters = chapters
    }

    this.chapters = chapters
    return chapters
  }

  /**
   * 将元数据（封面、banner、章节封面等）写入磁盘
   *
   * 写入逻辑：
   *   - 从 toomics-all.json 获取历史封面集合（covers），补充到 .smanga 目录
   *   - 从旧 meta.json 读取历史 banner/bannerBackground，与新值合并
   *   - 检测章节数变化，标记 metaUpdate=true 触发 meta.json 重写
   *   - 写入 cover*.jpg、banner*.jpg、bannerBackground*.jpg、章节封面
   */
  private async downloadMeta(): Promise<void> {
    // 从全站扫描 JSON 中获取历史封面数据
    let homeMeta: any = null
    const allJsonPath = path.join(dataRoot, 'data/toomics-all.json')
    if (fs.existsSync(allJsonPath)) {
      const json = read_json(allJsonPath)
      homeMeta = json.find((m: any) => Number(m.id) === this.mangaId) || null
    }

    // 创建元数据和漫画目录
    if (!fs.existsSync(this.metaFolder))
      await fs.promises.mkdir(this.metaFolder, { recursive: true })
    if (!fs.existsSync(this.mangaFolder))
      await fs.promises.mkdir(this.mangaFolder, { recursive: true })

    // 读取旧 meta.json（用于获取历史 banner/bannerBackground 和检测章节变化）
    const metaFile = path.join(this.metaFolder, 'meta.json')
    let oldMeta: ToomicsMeta | null = null
    if (fs.existsSync(metaFile)) {
      try {
        const rawData = fs.readFileSync(metaFile, 'utf-8')
        oldMeta = JSON.parse(rawData)
      } catch { /* 忽略损坏的 meta.json */ }
      if (oldMeta && oldMeta.chapters?.length !== this.chapters.length) {
        this.metaUpdate = true
      }
    }

    // ---- 封面历史保留 ----
    // 来源：toomics-all.json 的全站扫描累积的 covers 数组
    if (homeMeta) {
      // 写入最新封面（overwrite=true，确保 cover.jpg 始终是最新的）
      this.downloadCover(homeMeta.cover, path.join(this.metaFolder, 'cover.jpg'), true)

      // 写入历史封面（overwrite=false，已有则跳过，避免重复IO）
      homeMeta.covers.forEach((cover: string, index: number) => {
        this.downloadCover(cover, path.join(this.metaFolder, `cover${index}.jpg`))
      })

      // 若 toomics-all.json 中的 covers 比旧 meta 多，更新 meta.covers 并标记重写
      if (homeMeta.covers.length > (this.meta?.covers?.length ?? 0)) {
        if (this.meta) this.meta.covers = homeMeta.covers
        this.metaUpdate = true
      }
    }

    // ---- Banner 历史保留 ----
    // 来源：meta.json 自维护（每次详情页抓取时合并新旧 banner URL）
    this.mergeAndWriteBannerHistory(oldMeta, metaFile)

    // 写入章节封面（仅当本地不存在时写入）
    for (const chapter of this.chapters) {
      const chapterName = make_can_be_floder(chapter.name)
      const chapterCover = path.join(this.mangaFolder, chapterName + '.jpg')
      if (!fs.existsSync(chapterCover) && toomicsBrowser.buffs[chapter.cover]) {
        fs.writeFileSync(chapterCover, toomicsBrowser.buffs[chapter.cover])
      }
    }

    // 注意：tryIndexMangaMetaFile 已移至 download 完成后调用（toomics/index.ts），
    // 此处不再索引，以确保只记录实际下载的章节
  }

  /**
   * 合并并写入历史 banner / bannerBackground
   *
   * 策略：
   *   1. 从旧 meta.json 读取已有的 banners / bannerBackgrounds 历史数组
   *   2. 将当前抓取到的 banner / bannerBackground URL 追加到数组（去重保序）
   *   3. 更新 this.meta，写入 meta.json
   *   4. 将浏览器 buffer 中的图片写入磁盘：
   *      - banner.jpg / bannerBackground.jpg = 当前最新（always overwrite）
   *      - banner0.jpg..bannerN.jpg / bannerBackground0.jpg..bannerBackgroundN.jpg = 历史版本（skip if exists）
   *
   * @param oldMeta  旧 meta.json 解析结果（可能为 null）
   * @param metaFile meta.json 文件路径
   */
  private mergeAndWriteBannerHistory(oldMeta: ToomicsMeta | null, metaFile: string): void {
    if (!this.meta) return

    // ---- 处理 banner ----
    const oldBanners: string[] = oldMeta?.banners || []
    const newBanners = [...oldBanners]
    if (this.meta.banner && /^https?:\/\//i.test(this.meta.banner)) {
      if (!newBanners.includes(this.meta.banner)) {
        newBanners.push(this.meta.banner)
      }
    }

    // 检测 banner 是否有变化，触发 meta.json 重写
    if (newBanners.length > (oldMeta?.banners?.length ?? 0)) {
      this.metaUpdate = true
    }
    this.meta.banners = newBanners

    // ---- 处理 bannerBackground ----
    const oldBgBanners: string[] = oldMeta?.bannerBackgrounds || []
    const newBgBanners = [...oldBgBanners]
    if (this.meta.bannerBackground && /^https?:\/\//i.test(this.meta.bannerBackground)) {
      if (!newBgBanners.includes(this.meta.bannerBackground)) {
        newBgBanners.push(this.meta.bannerBackground)
      }
    }

    if (newBgBanners.length > (oldMeta?.bannerBackgrounds?.length ?? 0)) {
      this.metaUpdate = true
    }
    this.meta.bannerBackgrounds = newBgBanners

    // ---- 写入 meta.json ----
    // 条件：首次写入、有章节更新、或 banner/cover 有变化
    if (!fs.existsSync(metaFile) || this.metaUpdate || this.downloadMetaError) {
      fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))

      // 写入最新 banner / bannerBackground（始终覆盖为当前最新）
      if (toomicsBrowser.buffs[this.meta.banner]) {
        fs.writeFileSync(path.join(this.metaFolder, 'banner.jpg'), toomicsBrowser.buffs[this.meta.banner])
      }
      if (toomicsBrowser.buffs[this.meta.bannerBackground]) {
        fs.writeFileSync(
          path.join(this.metaFolder, 'bannerBackground.jpg'),
          toomicsBrowser.buffs[this.meta.bannerBackground]
        )
      }

      // 写入历史 banner 图片（仅写磁盘中不存在的，与封面 coverN.jpg 策略一致）
      // 注意：历史 banner 的 buffer 无法回溯，仅当对应 URL 恰好在当前浏览器 buffs 中时写入
      for (let i = 0; i < newBanners.length; i++) {
        const bannerFile = path.join(this.metaFolder, `banner${i}.jpg`)
        if (!fs.existsSync(bannerFile)) {
          if (toomicsBrowser.buffs[newBanners[i]]) {
            fs.writeFileSync(bannerFile, toomicsBrowser.buffs[newBanners[i]])
          }
        }
      }
      for (let i = 0; i < newBgBanners.length; i++) {
        const bgFile = path.join(this.metaFolder, `bannerBackground${i}.jpg`)
        if (!fs.existsSync(bgFile)) {
          if (toomicsBrowser.buffs[newBgBanners[i]]) {
            fs.writeFileSync(bgFile, toomicsBrowser.buffs[newBgBanners[i]])
          }
        }
      }
    } else {
      console.log(this.mangaName + ' 没有更新')
    }
  }

  /**
   * 从本地缓存目录复制封面图片到元数据目录
   *
   * 图片来源：toomics-all 全站扫描时缓存的封面（coverCache/{mangaId}-{filename}）
   *
   * @param url       封面原始 URL（用于拼接缓存文件名）
   * @param localPath 目标保存路径
   * @param overWrite 是否覆盖已有文件
   */
  private downloadCover(url: string, localPath: string, overWrite = false): void {
    const imageName = url.split('/').pop()
    if (!imageName) return

    if (!overWrite && fs.existsSync(localPath)) return

    const imagePath = `${this.config.coverCache}/${this.mangaId}-${imageName}`
    if (!fs.existsSync(imagePath)) {
      console.error('封面图片不存在，请检查全部漫画获取程序', imagePath)
      return
    }

    const stat = fs.statSync(imagePath)
    if (stat.size < 1000) {
      console.error('封面图片大小异常，请检查全部漫画获取程序', imagePath)
      return
    }

    fs.copyFileSync(imagePath, localPath)
  }

  /**
   * 打开漫画详情页，获取 HTML 内容
   *
   * 流程：
   *   1. 使用移动端 UA 打开详情页（移动端页面结构更适合解析）
   *   2. 检测手机号验证弹框 → 暂停任务
   *   3. 若被重定向到 /ep/ 页面，点击标题返回详情页
   *   4. 人类化滚动触发图片懒加载
   *   5. 提取最终 HTML 内容
   */
  private async getMetaHtml(): Promise<void> {
    const metaPage = await toomicsBrowser.new_page()
    if (!metaPage) return

    let pendingError: any = null

    try {
      // 使用移动端 UA（移动端页面 DOM 结构更简洁，利于正则解析）
      await metaPage.setUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
      )

      const mangaUrl = `https://toomics.com/${this.langTag}/webtoon/episode/toon/${this.mangaId}`

      // 监听 alert 弹窗：检测下架通知并跳过
      let mangaTakenDown = false
      const dialogListener = async (dialog: any) => {
        const msg: string = dialog.message?.() || ''
        await dialog.dismiss().catch(() => {})
        if (msg.includes('下架') || msg.includes('合約中止')) {
          mangaTakenDown = true
          write_log(`[toomics] ${this.mangaName} 已下架: ${msg}`)
        }
      }
      metaPage.on('dialog', dialogListener)

      await metaPage
        .goto(mangaUrl, {
          waitUntil: 'networkidle2',
          referer: `https://toomics.com/${this.langTag}/webtoon/search`,
          timeout: 180 * 1000,
        })
        .catch(() => {})

      await delay(1000)

      // 解除 dialog 监听
      metaPage.off('dialog', dialogListener)

      // 检测下架通知弹窗
      if (mangaTakenDown) {
        throw new TaskSkipError(`漫画已下架: ${this.mangaName}`)
      }

      // 检测手机号验证弹框（若存在则抛出 TaskPauseError 暂停任务）
      await ToomicsBrowserSession.pauseIfMobileVerificationVisible(
        metaPage,
        mangaUrl,
        this.mangaName,
        this.onProgress
      )

      await toomicsBrowser.save_cookie()

      // 若被重定向到具体章节页（URL 含 /ep/），点击标题回到漫画详情页
      if (/ep\//.test(metaPage.url())) {
        await metaPage.locator('h1 a').click().catch(() => {})
        await metaPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
        await delay(2000)
        await toomicsBrowser.save_cookie()
      }

      // 人类化滚动触发封面/banner 图片懒加载
      console.log('开始滚动页面,等待加载图片')
      await metaPage.mouse.move(1000, 1000)
      await metaPage.evaluate(() => (globalThis as any).window.scrollTo(0, 0))
      await delay(500)
      await humanScroll({
        page: metaPage,
        scrollStep: this.scrollStep,
        scrollDelay: this.scrollDelay,
      })

      // 等待章节封面缩略图全部加载完成（替代 waitForNavigation，避免被 GA/GTM 持久连接阻塞）
      // 列表页懒加载机制：<img class="list_lazy" data-original="真实URL" src="placeholder" />
      // 加载完成后 src 会被替换为真实 URL，未加载的仍是 data:image 占位符
      await metaPage
        .waitForFunction(
          () => {
            const doc = (globalThis as any).document
            const imgs = doc.querySelectorAll('img.list_lazy')
            for (const img of imgs) {
              const src = img.getAttribute('src')
              if (!src || src.startsWith('data:image')) return false
            }
            return true
          },
          { timeout: 30000 }
        )
        .catch(() => {})
      await delay(1000)
      this.metaPageHtml = await metaPage.content()
    } catch (e) {
      pendingError = e
      throw e
    } finally {
      // 若错误携带 debugPage 则保留页面供任务队列截图，否则正常关闭
      if (!pendingError?.debugPage) {
        await metaPage.close().catch(() => {})
      }
    }
  }
}
