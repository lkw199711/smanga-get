import * as fs from 'fs'
import path from 'path'
import { delay, end_app, make_can_be_floder, write_log, set_failed_chapters, TaskAbortError } from '#utils/index'
import { humanScroll, randomMouseMove, fastScroll, DEFAULT_PERSONA, type ReaderPersona } from '#utils/human'
import { toomicsBrowser } from '#api/browser'

/** 章节下载所需的参数 */
export interface ChapterInfo {
  chapterName: string          // 章节名（已清理为合法目录名）
  url: string                  // 章节详情页 URL（不含 /viewer/S 后缀）
  downloadPath: string         // 本地保存目录路径
  reloadImageindexs?: number[] // 重试模式下需重新下载的图片索引列表
  doNotDownload?: boolean      // 标记为「假装下载」的章节（仅浏览不保存）
}

/**
 * Toomics 章节下载器
 *
 * 下载流程（单章节）：
 *   1. 打开章节查看页（/viewer/S 模式）
 *   2. 保存 cookie → 人类化滚动 → 随机鼠标移动 → 等待网络空闲 → 模拟阅读延迟
 *   3. 若为「假装下载」模式，仅浏览后关闭页面（模拟真人行为）
 *   4. 从 DOM 提取所有图片 URL → 从浏览器内存 buffer 读取并写入磁盘
 *   5. 检测干扰图片（< 250 字节）和失败图片（buffer 不存在），触发重试
 *   6. 检测图片序号连续性，不连续则重新下载缺失部分
 *   7. 空章节立即触发 TaskAbortError 熔断
 *
 * 重试机制（迭代式，非递归，避免栈溢出）：
 *   - 干扰图片 + 失败图片 → 合并重试（最多 3 次）
 *   - 图片序号不连续 → 全量重试（最多 3 次）
 */
export class ToomicsChapterDownloader {
  /** 连续空章节计数（跨章节保持，由外部读取以触发熔断） */
  consecutiveEmptyChapters = 0
  private failedChapters: string[] = []
  private mangaName: string
  private mangaUrl: string
  private downloadPath: string
  private compressPath: string
  private scrollStep: number
  private scrollDelay: number
  private maxRetry: number
  private persona: ReaderPersona
  private fastScrollDurationMs: number
  private onProgress?: { setTotal: (n: number) => void; report: (msg: string) => void; message: (msg: string) => void }

  constructor(opts: {
    mangaName: string
    mangaUrl: string
    downloadPath: string
    compressPath: string
    scrollStep: number
    scrollDelay: number
    maxRetry: number
    persona?: ReaderPersona
    fastScrollDurationMs?: number
    onProgress?: any
  }) {
    this.mangaName = opts.mangaName
    this.mangaUrl = opts.mangaUrl
    this.downloadPath = opts.downloadPath
    this.compressPath = opts.compressPath
    this.scrollStep = opts.scrollStep
    this.scrollDelay = opts.scrollDelay
    this.maxRetry = opts.maxRetry
    this.persona = opts.persona || DEFAULT_PERSONA
    this.fastScrollDurationMs = opts.fastScrollDurationMs || 20000
    if (opts.onProgress) this.onProgress = opts.onProgress
  }

  /**
   * 下载单个章节（迭代重试，最多 maxRetry 次）
   *
   * 注意：此方法不在此调用 end_app()，由上层调度器统一控制进程生命周期
   */
  async downloadChapter(chapter: ChapterInfo): Promise<void> {
    const { chapterName, url, downloadPath, doNotDownload = false } = chapter

    if (!toomicsBrowser.browser) return

    // 迭代重试循环（替代原来的递归调用，避免栈溢出）
    let retryCount = 0
    let reloadImageindexs: number[] = chapter.reloadImageindexs || []

    while (true) {
      // 重试模式下的次数限制
      if (reloadImageindexs.length > 0) {
        retryCount++
        if (retryCount > this.maxRetry) {
          write_log(`[chapter download] ${chapterName} 重试次数过多，跳过`)
          this.failedChapters.push(chapterName)
          set_failed_chapters(this.failedChapters)
          return
        }
      }

      const result = await this.downloadChapterOnce({
        chapterName,
        url,
        downloadPath,
        reloadImageindexs,
        doNotDownload,
      })

      // 下载成功或已跳过，退出重试循环
      if (!result.needsRetry) return

      // 设置下一轮重试的图片索引
      reloadImageindexs = result.retryIndexes
    }
  }

  /**
   * 单次下载尝试（不含重试逻辑）
   *
   * 每次成功下载完成后调用 end_app()，在 cookie 已刷新的状态下尽快退出进程，
   * 由任务调度器在下次启动时继续后续章节。
   *
   * @returns needsRetry=false 表示成功或已跳过；needsRetry=true 时 retryIndexes 为需重试的图片索引
   */
  private async downloadChapterOnce(chapter: ChapterInfo & { reloadImageindexs: number[] }): Promise<{
    needsRetry: boolean
    retryIndexes: number[]
  }> {
    const { chapterName, url, downloadPath, reloadImageindexs, doNotDownload } = chapter
    const errImgs: number[] = []
    const interfereImages: number[] = []
    let totalImages = 0
    let image403Count = 0

    const chapterPage = await toomicsBrowser.new_page()
    if (!chapterPage) return { needsRetry: false, retryIndexes: [] }

    try {
      // 打开章节查看页（/viewer/S 为单页滚动模式）
      console.log('正在下载章节:', chapterName)
      this.onProgress?.message(`正在下载章节: ${chapterName}`)

      await chapterPage
        .goto(url + '/viewer/S', {
          waitUntil: 'networkidle2',
          timeout: 60 * 1000,
          referer: this.mangaUrl,
        })
        .catch(() => {})

      // 保存最新 cookie
      await toomicsBrowser.save_cookie()

      // 「假装下载」模式：足迹模式快速滚动（仅产生网络请求足迹，不保存图片）
      if (doNotDownload) {
        write_log(`[chapter download] ${chapterName} 足迹模式浏览`)
        this.onProgress?.message(`足迹浏览: ${chapterName}`)

        await chapterPage.mouse.move(1000, 1000)
        await fastScroll(chapterPage, this.fastScrollDurationMs, this.scrollStep, this.scrollDelay)
        await randomMouseMove(chapterPage)

        this.onProgress?.report(`${chapterName} 足迹浏览完成`)
        return { needsRetry: false, retryIndexes: [] }
      }

      // 精确模式：人类化滚动 + 等待图片加载（真实下载用）
      console.log('开始滚动页面,等待加载图片')
      await chapterPage.mouse.move(1000, 1000)
      await humanScroll({
        page: chapterPage,
        scrollStep: this.scrollStep,
        scrollDelay: this.scrollDelay,
      })
      await randomMouseMove(chapterPage)

      // 等待视口内懒加载图片全部完成（替代 waitForNetworkIdle，避免被 GA/Facebook 等持久连接阻塞）
      await chapterPage
        .waitForFunction(
          () => {
            const doc = (globalThis as any).document
            const win = (globalThis as any).window
            const imgs = doc.querySelectorAll('#viewer-img img.lazy')
            for (const img of imgs) {
              const rect = img.getBoundingClientRect()
              // 只检查视口内及上方已滚过的图片
              if (rect.bottom > 0 && rect.top < win.innerHeight) {
                const status = img.getAttribute('data-ll-status')
                // loaded 或 error 都视为已结束，不再等待
                if (status === 'loaded' || status === 'error') continue
                const src = img.getAttribute('src')
                if (src && src.startsWith('data:image')) return false
              }
            }
            return true
          },
          { timeout: 30000 }
        )
        .catch(() => {})

      // 从 DOM 提取所有图片 URL（id 以 "set_image_" 开头的 img 元素）
      const imageUrls: string[] = await chapterPage.evaluate(() => {
        const doc = (globalThis as any).document
        const els = doc.querySelectorAll('img[id^="set_image_"]')
        return Array.from(els).map((el: any) => el.src)
      })
      totalImages = imageUrls.length

      // 从浏览器内存 buffer 读取图片并写入磁盘
      this.onProgress?.message(`正在保存 ${chapterName} 图片 (共 ${imageUrls.length} 张)`)
      for (let i = 0; i < imageUrls.length; i++) {
        const imageUrl = imageUrls[i]
        const picName = i.toString().padStart(5, '0')
        const localPath = `${downloadPath}/${picName}.jpg`

        // 重试模式下仅下载指定索引的图片
        if (reloadImageindexs.length > 0 && !reloadImageindexs.includes(i)) continue

        // buffer 不存在 → 请求失败
        if (!toomicsBrowser.buffs[imageUrl]) {
          errImgs.push(i)
          continue
        }

        // buffer 体积过小（< 250 字节）→ 干扰图/占位图
        if (toomicsBrowser.buffs[imageUrl].length < 250) {
          interfereImages.push(i)
          continue
        }

        fs.writeFileSync(localPath, toomicsBrowser.buffs[imageUrl])
      }

      // 在 clear_buffs() 之前捕获 403 计数，用于 cookie 过期检测
      image403Count = toomicsBrowser.image403Count
    } finally {
      toomicsBrowser.clear_buffs()
    }

    // ── 结果检查与重试判定 ────────────────────────────────────────
    let resultError: any = null
    try {

    // 403 检测：cookie 过期时图片请求大量返回 403
    if (totalImages > 10 && image403Count > totalImages * 0.5) {
      const abortMsg = `[cookie] ${chapterName} 图片 403 占比过高 (${image403Count}/${totalImages})，判定 cookie 已过期`
      write_log(abortMsg)

      // 删除已下载的章节目录（403 返回的可能是错误页，非真实图片，目录内容不可信）
      try {
        if (fs.existsSync(downloadPath)) {
          fs.rmSync(downloadPath, { recursive: true, force: true })
          write_log(`[cookie] 已删除损坏的章节目录: ${downloadPath}`)
        }
      } catch (e) {
        write_log(`[cookie] 删除章节目录失败: ${e instanceof Error ? e.message : e}`)
      }

      // 清除 cookie 文件，下次运行将触发重新登录
      try {
        const cookieFile = (toomicsBrowser as any).cookieFile || 'data/cookies.json'
        if (fs.existsSync(cookieFile)) {
          fs.unlinkSync(cookieFile)
          write_log(`[cookie] 已清除过期 cookie 文件: ${cookieFile}`)
        }
      } catch (e) {
        write_log(`[cookie] 清除 cookie 文件失败: ${e instanceof Error ? e.message : e}`)
      }
      const err = new TaskAbortError(abortMsg)
      ;(err as any).debugPage = chapterPage
      console.error(abortMsg)
      throw err
    }

    // 仅最后一张为干扰图/请求失败 → 通常是站点水印/白图，不影响正文
    const lastIdx = totalImages - 1
    const lastOnlyInterfere = interfereImages.length === 1 && interfereImages[0] === lastIdx
    const lastOnlyErr = errImgs.length === 1 && errImgs[0] === lastIdx
    if ((lastOnlyInterfere || lastOnlyErr) && errImgs.length + interfereImages.length === 1) {
      // 仅最后一张异常，视为成功（见下方序号连续性检查）
    } else if (interfereImages.length > 0 || errImgs.length > 0) {
      // 存在干扰图或失败图片 → 合并后重试
      const interfereStr = interfereImages.length > 0 ? `, 干扰图片: ${interfereImages}` : ''
      const errorStr = errImgs.length > 0 ? `, 请求失败: ${errImgs}` : ''
      write_log(`[chapter download] ${chapterName} 下载异常${interfereStr}${errorStr}，准备重试`)
      return { needsRetry: true, retryIndexes: interfereImages.concat(errImgs) }
    }

    // 检查下载结果
    const imgs = fs
      .readdirSync(downloadPath)
      .filter((file) => file.endsWith('.jpg') || file.endsWith('.jpeg') || file.endsWith('.png'))

    // 空章节处理
    if (imgs.length === 0) {
      this.consecutiveEmptyChapters++
      write_log(
        `[chapter download] ${chapterName} 下载完成，没有图片 (连续空章节: ${this.consecutiveEmptyChapters})`
      )

      if (this.consecutiveEmptyChapters >= 1) {
        const abortMsg = `[CRITICAL] ${chapterName} 下载结果为空！可能原因：cookie 失效、网络异常、或触发风控验证。已停止当前任务，请检查状态后手动重试。`
        const err = new TaskAbortError(abortMsg)
        ;(err as any).debugPage = chapterPage
        write_log(abortMsg)
        console.error(abortMsg)
        throw err
      }

      return { needsRetry: false, retryIndexes: [] }
    }

    // 检测图片序号连续性（判断是否有遗漏）
    imgs.sort((a, b) => parseInt(a.split('.')[0], 10) - parseInt(b.split('.')[0], 10))
    const maxImgName = path.basename(imgs[imgs.length - 1])
    const maxImgNum = parseInt(maxImgName)

    if (maxImgNum + 1 > imgs.length) {
      write_log(
        `[chapter download] ${chapterName} 图片序号不连续，最大序号: ${maxImgNum}，实际数量: ${imgs.length}`
      )
      // 全量重试以补齐缺失图片
      return {
        needsRetry: true,
        retryIndexes: Array.from({ length: maxImgNum + 1 }, (_, i) => i),
      }
    }

    // 下载成功 → 重置空章节计数
    if (this.consecutiveEmptyChapters > 0) {
      write_log(`[chapter download] 空章节计数已重置 (之前: ${this.consecutiveEmptyChapters})`)
      this.consecutiveEmptyChapters = 0
    }
    write_log(`[chapter download] ${chapterName} 下载完成.`)
    this.onProgress?.report(`${chapterName} 下载完成`)

    await delay(1000)

    // 章节下载完成，尽快退出以保存最新 cookie
    end_app()

    return { needsRetry: false, retryIndexes: [] }
    } catch (e) {
      resultError = e
      throw e
    } finally {
      if (!resultError?.debugPage) {
        await chapterPage.close().catch(() => {})
      }
    }
  }
}
