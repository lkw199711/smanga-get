import * as fs from 'fs'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe'
import path from 'path'
import { delay, end_app, get_config, make_can_be_floder, read_json, s_delete, write_log } from '#utils/index'
import puppeteer from 'puppeteer'
import { gentlemanBrowser } from '#api/browser'
type chapterType = {
  name: string
  url: string
  prefix?: string
}
export default class Toomics {
  private domain = 'https://www.wn07.ru'
  private website: string = 'gentleman'
  private mangaId: number
  private mangaName: string
  private mangaUrl: string = ''
  private downloadPath: string
  private compressPath: string
  // 是否下载付费章节
  private meta: any = null
  private page: puppeteer.Page | null = null

  private scrollStep: number = 800 // 滚动步长
  private scrollDelay: number = 500 // 滚动延迟
  private userName: string
  private passWord: string
  private config: any
  private chapters: chapterType[] = []
  private chapterCount: number = 0
  private chapterPage: puppeteer.Page | null = null
  constructor(params: subsribeType) {
    const config = get_config(this.website) || {}
    this.downloadPath = config?.downloadPath || ''
    this.compressPath = config?.compressPath || ''
    this.config = config
    this.mangaId = Number(params.id)
    this.mangaName = make_can_be_floder(params.name)
    this.userName = config?.userName || ''
    this.passWord = config?.passWord || ''
    this.scrollStep = config?.scrollStep || this.scrollStep
    this.scrollDelay = config?.scrollDelay || this.scrollDelay
    // 替换域名
    this.mangaUrl = params.url?.replace(/https?:\/\/[^/]+/, this.domain) || '';

    if (params.chapterCount) this.chapterCount = Number(params.chapterCount)
  }

  /**
   * @description: 开始下载
   */
  async start() {
    // if (!this.check_update()) return
    // 解析章节
    console.log(this.mangaName + ' 正在分析')

    if (!gentlemanBrowser.browser) {
      await gentlemanBrowser.init()
    }

    if (!gentlemanBrowser.browser) return

    // 无漫画链接直接结束
    if (!this.mangaUrl) return

    await this.get_chapters()

    console.log(this.mangaName + ' 订阅完毕')
    // 移除完结的订阅
    if (get_config().autoRemoveSubscribe && this.meta.finished) {
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

    const pagesMatch = pageBox.match(/(?<=href=").+?(?=")/gs);

    pagesMatch?.forEach((item) => {
      if (item.length > 10) pages.push(this.domain + item);
    });

    console.log(pages);

    return pages;
  }

  async get_chapters1(pageUrl: string = this.mangaUrl): Promise<chapterType[]> {
    const chapters: chapterType[] = []
    const html = await this.get_browser_html(pageUrl)
    // 截取页码部分
    const pageBox = html.match(/(?<=paginator).+?(?=f_right)/s)?.[0] || '';

    // 通过后一页的方式
    const nextPage = pageBox.match(/(?<=href=").+?(?=">後頁)/s)?.[0] || '';
    this.chapters.concat(this.get_subpage_chapters(html, 't'))
    if (nextPage) {
      await this.get_chapters(nextPage);
      list.push(...nextPageImages);
      return list;
    }

    // 获取页码链接
    const srcMatches = pageBox.match(/(?<=href=").+?(?=")/gs);
    if (srcMatches) {
      for (const m of srcMatches) {
        if (m === '/themes/weitu/images/bg/shoucang.jpg') continue;
        const page = `${this.domain}${m}`;

        const html2 = await this.get_browser_html(page);
        const listTwo = this.get_subpage_images(html2);
        list.push(...listTwo);
      }
    }

    return list;
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

    return await this.chapterPage.content()
  }

  get_chapter_url(html: string): chapterType[] { 
    const chapterUrls: chapterType[] = []
  }
}
