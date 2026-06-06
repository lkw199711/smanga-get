import * as fs from 'fs'
import path from 'path'
import { delay, end_app, make_can_be_floder, write_log, set_failed_chapters, TaskAbortError } from '#utils/index'
import { humanScroll, randomMouseMove, readingDelay } from '#utils/human'
import { toomicsBrowser } from '#api/browser'

export interface ChapterInfo {
  chapterName: string
  url: string
  downloadPath: string
  reloadImageindexs?: number[]
  doNotDownload?: boolean
}

export class ToomicsChapterDownloader {
  /** 连续空章节计数（从外部注入，以便 Toomics 主类访问） */
  consecutiveEmptyChapters = 0
  private retry = 0
  private maxRetry: number
  private failedChapters: string[] = []
  private mangaName: string
  private mangaUrl: string
  private downloadPath: string
  private compressPath: string
  private scrollStep: number
  private scrollDelay: number
  private onProgress?: { setTotal: (n: number) => void; report: (msg: string) => void; message: (msg: string) => void }

  constructor(opts: {
    mangaName: string
    mangaUrl: string
    downloadPath: string
    compressPath: string
    scrollStep: number
    scrollDelay: number
    maxRetry: number
    onProgress?: any
  }) {
    this.mangaName = opts.mangaName
    this.mangaUrl = opts.mangaUrl
    this.downloadPath = opts.downloadPath
    this.compressPath = opts.compressPath
    this.scrollStep = opts.scrollStep
    this.scrollDelay = opts.scrollDelay
    this.maxRetry = opts.maxRetry
    if (opts.onProgress) this.onProgress = opts.onProgress
  }

  /**
   * 下载章节
   * @description 通过浏览器模拟下载。图片下载失败分两种：请求失败（无图片）、请求成功但内容为空。
   * 重试三次后仍未成功则跳过。连续两次空章节触发 TaskAbortError 熔断。
   */
  async downloadChapter(chapter: ChapterInfo): Promise<void> {
    const { chapterName, url, downloadPath, reloadImageindexs = [], doNotDownload = false } = chapter
    const errImgs: number[] = []
    const interfereImages: number[] = []

    if (reloadImageindexs.length > 0) {
      this.retry++
      if (this.retry > 3) {
        write_log(`[chapter download]${chapterName} 重试次数过多,跳过`)
        this.failedChapters.push(chapterName)
        set_failed_chapters(this.failedChapters)
        this.retry = 0
        return
      }
    } else {
      this.retry = 0
    }

    if (!toomicsBrowser.browser) return
    const chapterPage = await toomicsBrowser.new_page()
    if (!chapterPage) return

    // 开始下载章节
    console.log('正在下载章节:', chapterName)
    this.onProgress?.message(`正在下载章节: ${chapterName}`)

    await chapterPage
      .goto(url + '/viewer/S', {
        waitUntil: 'networkidle2',
        timeout: 60 * 1000,
        referer: this.mangaUrl,
      })
      .catch(() => { })

    // 获取最新cookie
    await toomicsBrowser.save_cookie()

    // 人类化滚动
    console.log('开始滚动页面,等待加载图片')
    await chapterPage.mouse.move(1000, 1000)
    await humanScroll({
      page: chapterPage,
      scrollStep: this.scrollStep,
      scrollDelay: this.scrollDelay,
    })

    // 随机鼠标移动（模拟阅读中移动鼠标）
    await randomMouseMove(chapterPage)

    // 等待图片网络请求完成
    await chapterPage.waitForNetworkIdle().catch(() => { })

    // 模拟阅读等待时间（预估 30 张图片的阅读时间）
    await readingDelay(30)

    if (doNotDownload) {
      /**
       * 每部漫画仅下载最后一章节,可能会遭到cookie禁用
       * 因此首先尝试随机浏览一些其他章节
       */
      await chapterPage.close()
      write_log(`[chapter download]${chapterName} 下载已禁用,跳过`)
      this.onProgress?.report(`${chapterName} 已跳过`)
      return
    }

    // 获取所有图片的url
    const imageUrls = await chapterPage.evaluate(() => {
      const doc = (globalThis as any).document
      const els = doc.querySelectorAll('img[id^="set_image_"]')
      const urls = Array.from(els).map((el: any) => el.src)
      return urls
    })

    // 数量正确 进行下载
    this.onProgress?.message(`正在保存 ${chapterName} 图片 (共 ${imageUrls.length} 张)`)
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i]
      const picName = i.toString().padStart(5, '0')
      const localPath = `${downloadPath}/${picName}.jpg`

      // 如果为重试模式 仅下载指定图片
      if (reloadImageindexs.length > 0 && !reloadImageindexs.includes(i)) {
        continue
      }

      // 记录错误图片
      if (!toomicsBrowser.buffs[imageUrl]) {
        errImgs.push(i)
        continue
      }

      // 记录干扰图片
      if (toomicsBrowser.buffs[imageUrl].length < 250) {
        interfereImages.push(i)
        continue
      }

      fs.writeFileSync(localPath, toomicsBrowser.buffs[imageUrl])
    }

    toomicsBrowser.clear_buffs()
    chapterPage.close()

    if (interfereImages.length === 1 && interfereImages[0] === imageUrls.length - 1) {
      // 如果错误图片为最后一张
      write_log(`[chapter download]${chapterName} 最后一张为干扰图.`)
    } else if (interfereImages.length > 0) {
      const interfereStr = interfereImages.length > 0 ? `, 检测到干扰图片:${interfereImages}` : ''
      const errorStr = errImgs.length > 0 ? `, 请求失败图片:${errImgs}` : ''
      write_log(`[chapter download]${chapterName}下载失败${interfereStr}${errorStr},进行重新下载`)
      await this.downloadChapter({
        chapterName,
        url,
        downloadPath,
        reloadImageindexs: interfereImages.concat(errImgs),
      })
      return
    }

    // 检测图片序号连续性
    let imgs = fs
      .readdirSync(downloadPath)
      .filter((file) => file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.png'))
    if (imgs.length === 0) {
      this.consecutiveEmptyChapters++
      write_log(`[chapter download]${chapterName} 下载完成,没有图片 (连续空章节: ${this.consecutiveEmptyChapters})`)

      if (this.consecutiveEmptyChapters >= 2) {
        const abortMsg = `[CRITICAL] 连续 ${this.consecutiveEmptyChapters} 个章节下载为空！可能原因：cookie 失效、网络异常、或触发风控验证。已中断所有任务，请检查状态后手动重试。`
        write_log(abortMsg)
        console.error(abortMsg)
        throw new TaskAbortError(abortMsg)
      }

      return
    }
    imgs.sort((a, b) => {
      const numA = parseInt(a.split('.')[0], 10)
      const numB = parseInt(b.split('.')[0], 10)
      return numA - numB
    })

    const maxImg = imgs[imgs.length - 1]
    const maxImgName = path.basename(maxImg)
    const maxImgNum = parseInt(maxImgName)

    if (maxImgNum + 1 > imgs.length) {
      write_log(
        `[chapter download]${chapterName} 下载完成,但是图片序号不连续,最大序号: ${maxImgNum}, 实际图片数量: ${imgs.length}`
      )
      // 如果图片序号不连续 重新下载
      await this.downloadChapter({
        chapterName,
        url,
        downloadPath,
        reloadImageindexs: Array.from({ length: maxImgNum + 1 }, (_, i) => i),
      })
    } else {
      // 成功下载到图片 → 重置空章节计数
      if (this.consecutiveEmptyChapters > 0) {
        write_log(`[chapter download] 空章节计数已重置 (之前: ${this.consecutiveEmptyChapters})`)
        this.consecutiveEmptyChapters = 0
      }
      write_log(`[chapter download]${chapterName} 下载完成.`)
      this.onProgress?.report(`${chapterName} 下载完成`)
    }

    await delay(1000)

    end_app()
  }
}
