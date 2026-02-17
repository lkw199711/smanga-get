import * as fs from 'fs'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe'
import path from 'path'
import { copy_folder, delay, end_app, get_config, read_json, s_delete, write_log } from '#utils/index'
import puppeteer from 'puppeteer'
import { gentlemanBrowser } from '#api/browser'
import { exit } from 'process'
import crypto from 'crypto'
type chapterType = {
  name: string
  url: string
  prefix?: string
  imageNum?: number
  images: string[]
}
export default class Gentleman {
  private domain = 'https://www.wn07.ru'
  private website: string = 'gentleman'
  private mangaId: number
  private mangaName: string
  private mangaUrl: string = ''
  private downloadPath: string
  private organizePath: string
  private compressPath: string
  // 是否下载付费章节
  private meta: any = null
  private config: any
  private chapters: chapterType[] = []
  private chapterCount: number = 0
  private chapterPage: puppeteer.Page | null = null
  private currentChapter: string = ''
  private mangaPath: string = '' // 添加mangaPath属性
  private metaPath: string = '' // 添加metaPath属性
  private textPrefix: string = '' // 添加textPrefix属性
  private mangaStatus: string = '' // 添加mangaStatus属性
  constructor(params: subsribeType) {
    const config = get_config(this.website) || {}
    this.downloadPath = config?.downloadPath || ''
    this.organizePath = config?.organizePath || ''
    this.compressPath = config?.compressPath || ''
    this.config = config
    this.mangaId = Number(params.id)
    this.mangaName = this.make_can_be_floder(params.name)
    // 替换域名
    this.mangaUrl = params.url?.replace(/https?:\/\/[^/]+/, this.domain) || '';
    this.mangaPath = path.join(this.downloadPath, this.mangaName)
    if (!fs.existsSync(this.mangaPath)) {
      fs.mkdirSync(this.mangaPath, { recursive: true })
    }
    this.metaPath = path.join(this.mangaPath, '.smanga')

    if (params.chapterCount) this.chapterCount = Number(params.chapterCount)
  }

  /**
   * @description: 开始下载
   */
  async start() {
    // 解析章节
    console.log(this.mangaName + ' 正在分析')

    if (!gentlemanBrowser.browser) {
      await gentlemanBrowser.init()
    }

    if (!gentlemanBrowser.browser) return

    // 无漫画链接直接结束
    if (!this.mangaUrl) return

    await this.get_chapters()

    for (const item of this.chapters) {
      const chapterPath = path.join(this.mangaPath, item.name)
      if (fs.existsSync(chapterPath) && fs.readdirSync(chapterPath).length > 0) {
        continue
      }

      write_log(`[chapter]${item.name} 正在下载`)
      await this.get_chapter_images(item)
      await this.download_chapter_images(item)

      if (item.name.includes('完結')) {
        this.mangaStatus = 'finished'
      }
    }

    // 整理元数据
    // await this.organize_meta()

    // 整理文件
    if (this.config.organize) {
      await this.organize_files()
    }

    console.log(this.mangaName + ' 订阅完毕')
    // 移除完结的订阅
    if (this.mangaStatus === 'finished') {
      subscribe_remove({ website: this.website, id: this.mangaId })
      write_log(`[subscribe]${this.mangaName} 已移除订阅链接`)
    }

    // 自动结束程序
    end_app()
  }

  async get_chapters(): Promise<chapterType[]> {
    const pages: string[] = [this.mangaUrl];
    const firstPageHtml = await this.get_browser_html(this.mangaUrl);
    // 截取页码部分
    const pageBox = firstPageHtml.match(/(?<=thispage).+?(?=\/div)/s)?.[0] || '';

    this.chapters = this.get_page_chapters(firstPageHtml)

    const pagesMatch = pageBox.match(/(?<=href=").+?(?=")/gs);
    if (!pagesMatch) return this.chapters;

    for (const item of pagesMatch) {
      // 遇到已下载章节,不再加载下一页
      const pageLastChapterName = this.chapters[this.chapters.length - 1].name
      if (fs.existsSync(path.join(this.mangaPath, pageLastChapterName))) return this.chapters
      // 排除干扰
      if (item.length < 10) continue;
      const html = await this.get_browser_html(this.domain + item)
      this.chapters = this.chapters.concat(this.get_page_chapters(html))
    }
    // &lt;emgt;同事lt;emgt;lt;emgt;換lt;emgt;換愛lt;emgt;lt;emgt; 185-186話
    this.chapters = this.chapters
      .filter((item) => item.url)
      .filter((item) => {
        const chapterIncludes = this.config.chapterIncludes || ''
        const chapterExcludes = this.config.chapterExcludes || ''

        if (!chapterIncludes && new RegExp(chapterIncludes).test(item.name)) return false
        if (chapterExcludes && new RegExp(chapterExcludes).test(item.name)) return false
        return true
      })
    return this.chapters;
  }

  async get_browser_html(url: string): Promise<string> {
    if (!gentlemanBrowser.browser) {
      await gentlemanBrowser.init()
    }

    if (!gentlemanBrowser.browser) return ''
    this.chapterPage = await gentlemanBrowser.browser?.newPage() || null
    if (!this.chapterPage) return ''

    await this.chapterPage.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60 * 1000,
    }).catch(() => { })

    const html = await this.chapterPage.content()

    this.chapterPage.close()

    return html
  }

  async organize_meta() {
    if (!fs.existsSync(this.metaPath)) fs.mkdirSync(this.metaPath, { recursive: true })
    let covers: string[] = []
    // 从漫画漫画路径获取所有的cover.jpg
    const chapters = fs.readdirSync(this.mangaPath)

    for (let chapter of chapters) {
      const filePath = path.join(this.mangaPath, chapter)
      if (!fs.statSync(filePath).isDirectory()) continue
      fs.readdirSync(filePath)
        .filter((file) => file.includes('cover') || file.includes('logo'))
        .forEach((file) => {
          covers.push(path.join(filePath, file))
        })
    }

    // 根据文件特征码去重
    const fileHashes = new Map<string, string>()
    for (const cover of covers) {
      try {
        const fileContent = fs.readFileSync(cover)
        const hash = crypto.createHash('md5').update(fileContent).digest('hex')
        if (!fileHashes.has(hash)) {
          fileHashes.set(hash, cover)
        }
      } catch (error) {
        console.error(`Error calculating hash for file ${cover}:`, error)
      }
    }
    covers = Array.from(fileHashes.values())

    const oldCovers = fs.readdirSync(this.metaPath)
      .filter((file) => file.includes('cover'))
      .map((file) => path.join(this.metaPath, file))

    if(covers.length > oldCovers.length) {
      covers.forEach((cover, index) => {
        fs.copyFileSync(cover, path.join(this.metaPath, `cover${index}.jpg`))
      })
    }
  }

  async organize_files() {
    const sourceChapters = fs.readdirSync(this.mangaPath)
    const organizeMangaPath = path.join(this.organizePath, this.mangaName)
    if (!fs.existsSync(organizeMangaPath)) fs.mkdirSync(organizeMangaPath, { recursive: true })
    const organizeChapters = fs.readdirSync(organizeMangaPath)
    let sourceImages: string[] = []
    sourceChapters.forEach((chapter) => {
      const filePath = path.join(this.mangaPath, chapter)
      if (!fs.statSync(filePath).isDirectory()) return

      const chapterImages = fs.readdirSync(filePath)
      for (let image of chapterImages) {
        if (!image.includes('jpg')) continue
        const imageNums = image.split('_')
        if (imageNums.length < 2) continue
        const chapterNum = imageNums[0]
        const imageNum = imageNums[1].split('.')[0]
        const organizePath = path.join(organizeMangaPath, chapterNum)
        const organizeFile = path.join(organizePath, `${imageNum}.jpg`)
        if (!organizeChapters.includes(chapterNum)) {
          fs.mkdirSync(organizePath, { recursive: true })
        } else {
          continue
        }
        fs.copyFileSync(path.join(filePath, image), organizeFile)
      }
      sourceImages = sourceImages.concat(chapterImages)
    })
/* 由于获取到的图片特征码不一致无法去重 故而暂时不进行自动化处理
    // 复制元数据
    const organizeMetaPath = path.join(organizeMangaPath, '.smanga')
    if (!fs.existsSync(this.metaPath)) return
    // 复制元数据
    if (!fs.existsSync(organizeMetaPath)) {
      copy_folder(this.metaPath, organizeMetaPath)
    }
    */
  }

  /**
   * 获取子页面的图片链接
   */
  private get_subpage_images(html: string, prefix: string): string[] {
    const list: string[] = []

    // 截取图片链接部分
    const imageBoxMatch = html.match(/(?<=gallary_wrap).+?(?=comment_wrap)/s)
    if (!imageBoxMatch) return list
    const imageBox = imageBoxMatch[0]

    // 获取所有图片链接
    const srcMatches = imageBox.match(/(?<=gallary_item).+?(?=pic_ctl)/gs)
    if (!srcMatches) return list

    for (const m of srcMatches) {
      const str = m
      const viewMatch = str.match(/(?<=src=").+?(?=")/s)
      if (!viewMatch) continue
      const view = viewMatch[0]

      const imgTagMatch = view.match(/(?<=data\/t)\/(\d+\/)(\d+\/)(?=\b)/)
      if (!imgTagMatch) continue
      const imgTag = imgTagMatch[0]

      // 获取图片后缀
      const suffixMatch = view.match(/\.[^.]+$/)
      const suffix = suffixMatch ? suffixMatch[0] : ''

      // 使用临时前缀
      if (prefix === '') prefix = this.textPrefix

      const imgNameMatch = str.match(/(?<=name\stb">).+?(?=<)/)
      if (!imgNameMatch) continue
      const imgName = imgNameMatch[0]

      // 构建完整的图片URL
      const img = `https://${prefix.replace(/^t/, 'img')}${imgTag}${imgName}${suffix}`

      list.push(img)
    }

    return list
  }

  private async get_chapter_images(chapter: chapterType, url: string = chapter.url): Promise<string[]> {
    const html = await this.get_browser_html(url)

    if (!chapter.prefix) {
      const firstViewUrlMatch = html.match(/\/photos-view-id-[^\"]+/)
      const firstViewUrl = firstViewUrlMatch ? firstViewUrlMatch[0] : ''

      const viewHtml = await this.get_browser_html(this.domain + firstViewUrl)
      const prefixMatch = viewHtml.match(/(?<=src=\"\/\/).+?\/data/)
      chapter.prefix = prefixMatch ? prefixMatch[0] : ''
      this.textPrefix = chapter.prefix || '' // 设置textPrefix
    }

    // 获取当前页的图片链接并添加到列表
    const subpageImages = this.get_subpage_images(html, chapter.prefix || '')
    chapter.images = chapter.images.concat(subpageImages)
    // 截取页码部分
    const pageBox = html.match(/(?<=paginator).+?(?=f_right)/s)?.[0] || ''
    // 提取下一页链接
    const nextPage = pageBox.match(/(?<=next"><a\shref=").+?(?=">後頁)/s)?.[0] || ''

    if (nextPage) {
      const page = `https://${this.domain.replace(/^https?:\/\//, '')}${nextPage}`
      return await this.get_chapter_images(chapter, page)
    }

    return chapter.images
  }

  // 下载章节图片
  private async download_chapter_images(item: chapterType): Promise<void> {
    if (!item.images) return
    const chapterPath = path.join(this.mangaPath, item.name)
    if (!fs.existsSync(chapterPath)) {
      fs.mkdirSync(chapterPath, { recursive: true })
    }
    for (const img of item.images) {
      const fileName = img.split('/').pop() || ''
      const filePath = path.join(chapterPath, fileName)
      await this.donwload_image(img, filePath)
    }
    // 暂时为空实现，需要根据实际情况修改
  }

  private async donwload_image(url: string, path: string): Promise<void> {
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    fs.writeFileSync(path, buffer)
  }

  /**
   * 获取所有章节的链接
   * @param html 页面HTML内容
   * @returns 章节链接数组
   */
  get_page_chapters(html: string): chapterType[] {
    const chapterUrls: chapterType[] = [];

    // 截取包含章节列表的部分
    const chapterBox = html.match(/(?<=gallary_wrap).+?(?=bot_toolbar)/s)?.[0] || '';

    // 获取所有章节内容
    const chapterList = chapterBox.match(/(?<=<li).+?(?=<\/li>)/gs) || [];

    for (const chapter of chapterList) {
      // 章节链接
      const href = chapter.match(/\/photos-index-aid-[\d]+\.html/)?.[0] || '';
      // 章节名
      let name = chapter.match(/(?<=title=\").+?(?=\")/)?.[0] || '';
      name = name.replace(/<[^>]+>/g, '');

      name = this.make_can_be_floder(name);

      // 图片数量
      const imageNum = parseInt(chapter.match(/[\d]+(?=張圖片)/)?.[0] || '0', 10);

      // 拼接处理,形成完整链接
      const url = `${this.domain}${href}`;

      chapterUrls.push({ url, name, imageNum: imageNum, images: [] });
    }

    return chapterUrls;
  }

  make_can_be_floder(name: string): string {
    return name
      .replace(/&lt;/g, '<') // 解码HTML实体
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/<[^>]+>/g, '') // 去除HTML标签
      .replace(/[\/\\:*?"<>|\.]/g, '')
      .replace(/[&<>'"]/g, '')
      .replace(/\s+/g, '')
      .trimStart()
      .trimEnd()
  }
}
