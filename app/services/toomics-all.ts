/**
 * Toomics 全站漫画扫描器
 *
 * 功能：访问 Toomics 排行榜页面，通过人类化滚动触发懒加载，
 *       抓取全站漫画列表（名称、封面、简介、章节数等），
 *       将结果合并写入 JSON 文件，并缓存封面图片到本地磁盘。
 *
 * 数据流向：
 *   Toomics 排行榜页 → 页面 DOM 解析 → toomics-all.json（增量合并）
 *                                     → coverCache 目录（封面图片）
 *                                     → mangaTask 队列（触发后续下载任务）
 */

import { toomicsBrowser, toomicsBrowserNoUser, UseBrowser } from '#api/browser'
import fs from 'fs'
import path from 'node:path'
import { delay, get_config, make_can_be_floder, dataRoot, read_json, write_log } from '#utils/index'
import { hasChapterUpdate } from '../../start/init.js'
import { humanScroll } from '#utils/human'
import { mangaTask } from '#api/task'
import type { Page } from 'rebrowser-puppeteer'

/** 从排行榜页面解析出的单部漫画信息 */
interface MangaInfo {
  website: string
  name: string
  url: string
  id: number
  cover: string
  covers: string[]
  describe: string
  chapterCount: number
  /** 是否成人内容（页面标注 18+） */
  audlt: boolean
  /** 是否已完结（页面标注 End）—— 注意：字段名拼写为历史遗留，跨多文件保持一致 */
  finsihed: boolean
}

export default class ToomicsAll {
  private langTag: string = 'tc'            // 语言标签，默认繁体中文
  private coverPath: string = dataRoot + 'data/toomics-covers'  // 封面图片缓存目录
  private jsonFile: string = dataRoot + 'data/toomics-all.json' // 漫画列表 JSON 文件
  private scrollStep: number = 400          // 人类化滚动步长（像素）
  private scrollDelay: number = 500         // 人类化滚动延迟（毫秒）
  private browser: UseBrowser               // 浏览器实例（根据 nouser 选择有/无用户版本）
  private onProgress?: any

  constructor(langTag = 'tc', nouser = false, onProgress?: any) {
    this.langTag = langTag || 'tc'
    const config = get_config().toomics
    if (config.scrollStep) this.scrollStep = config.scrollStep
    if (config.scrollDelay) this.scrollDelay = config.scrollDelay
    this.coverPath = config.coverCache
    this.browser = nouser ? toomicsBrowserNoUser : toomicsBrowser
    this.onProgress = onProgress
  }

  /**
   * 主入口：执行完整的排行榜扫描流程
   *
   * 步骤：
   *   1. 初始化浏览器并加载 cookie
   *   2. 打开排行榜页面，切换成人模式
   *   3. 人类化滚动触发懒加载，等待所有图片渲染
   *   4. 从 DOM 中提取漫画列表
   *   5. 增量合并到本地 JSON 文件
   *   6. 将封面图片从浏览器内存 buffer 写入磁盘
   *   7. 将漫画加入下载任务队列
   */
  async start() {
    write_log('[toomics all] 开始扫描所有漫画')

    // 检查当日快照
    const snapshotDir = path.join(dataRoot, 'data', 'snapshots', 'toomics')
    const today = new Date().toISOString().split('T')[0]
    const snapshotFile = path.join(snapshotDir, `${today}-${this.langTag}-all.json`)

    if (fs.existsSync(snapshotFile)) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'))
        const mangas = snapshot.mangas || []
        // 空快照（manga_count=0）必定是上次扫描失败产生的无效数据，丢弃并重新扫描
        if (mangas.length === 0) {
          fs.unlinkSync(snapshotFile)
          write_log('[toomics all] 当日快照为空（上次扫描失败），删除并重新扫描')
        } else {
          mangas.sort(() => Math.random() - 0.5)
          for (const manga of mangas) {
            // 入队前比对本地章节数，无更新则跳过不入队
            if (manga.chapterCount != null && manga.chapterCount > 0) {
              const folderName = make_can_be_floder(manga.name)
              if (!hasChapterUpdate(folderName, manga.chapterCount, manga.website, manga.url)) {
                continue
              }
            }
            mangaTask.add(manga)
          }
          write_log(`[toomics all] 使用当日快照，${mangas.length} 部漫画（跳过浏览器扫描）`)
          return
        }
      } catch (error) {
        write_log(`[toomics all] 快照读取失败，重新扫描: ${error instanceof Error ? error.message : error}`)
      }
    }

    // Step 1: 浏览器初始化
    if (!this.browser.browser?.connected) {
      await this.browser.init()
    }
    if (!this.browser.browser) return

    await this.browser.get_cookie()

    // Step 2: 打开排行榜页面（使用 try/finally 确保 page 始终被关闭）
    const page = await this.browser.new_page()
    if (!page) return

    try {
      await this.loadRankingPage(page)

      // Step 3: 人类化滚动，触发图片懒加载
      console.log('开始滚动页面,等待加载图片')
      await page.mouse.move(1000, 1000)
      await humanScroll({
        page,
        scrollStep: this.scrollStep,
        scrollDelay: this.scrollDelay,
      })

      await page
        .waitForFunction(
          () => {
            const doc = (globalThis as any).document
            const imgs = doc.querySelectorAll('.list_wrap img.lazy')
            // 无 .lazy 图片说明已全部加载完成
            if (imgs.length === 0) return true
            const winHeight = (globalThis as any).window.innerHeight
            for (const img of imgs) {
              const rect = img.getBoundingClientRect()
              if (rect.bottom > 0 && rect.top < winHeight) {
                if (img.getAttribute('data-ll-status') === 'loaded') continue
                const src = img.getAttribute('src')
                if (!src || src.startsWith('data:image')) return false
              }
            }
            return true
          },
          { timeout: 30000 }
        )
        .catch(() => {})
      await delay(2000)

      // Step 4: 从页面 DOM 中提取所有漫画信息
      const mangas = await this.extractMangaList(page)

      // 扫描结果为空必定是页面加载失败（如 cookie 过期、网络异常等），
      // 不应写入快照，应直接抛错让任务调度层处理重试
      if (mangas.length === 0) {
        throw new Error('[toomics all] 扫描结果为空，可能 cookie 过期或页面加载异常')
      }

      // Step 5: 写入快照（原子操作：先写临时文件，再 rename）
      fs.mkdirSync(snapshotDir, { recursive: true })
      const snapshotData = {
        scan_date: today,
        lang_tag: this.langTag,
        manga_count: mangas.length,
        mangas,
      }
      const tempFile = `${snapshotFile}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tempFile, JSON.stringify(snapshotData, null, 2), 'utf-8')
      fs.renameSync(tempFile, snapshotFile)

      // Step 6: 增量合并到本地 JSON，并将漫画加入下载队列
      this.mergeToJson(mangas)

      // Step 7: 将浏览器内存中的封面图片写入磁盘缓存
      this.saveCovers(mangas)

      write_log('[toomics all] 扫描完成，快照已保存')
      this.browser.clear_buffs()
    } finally {
      // 确保 page 在任何异常情况下都能被关闭，防止 Chromium 内存泄漏
      await page.close().catch(() => {})
    }
  }

  /**
   * 加载排行榜页面并完成前置准备（成人模式切换、cookie 保存）
   *
   * 流程：
   *   - 先访问 https://toomics.com/ 首页（模拟自然浏览入口，降低防爬拦截风险）
   *   - 再导航至 /{langTag}/webtoon/ranking 排行榜页
   *   - 等待列表容器 .list_wrap 渲染完成
   *   - 调用 Base.setDisplay('A', ...) 切换到成人模式（18+ 内容可见）
   *   - 保存 cookie 到磁盘，供后续任务复用
   */
  private async loadRankingPage(page: Page) {
    const rankingUrl = `https://toomics.com/${this.langTag}/webtoon/ranking`
    const referer = `https://toomics.com/${this.langTag}/`

    // 先访问首页，建立可信的浏览会话，再跳转到排行榜
    await page
      .goto('https://toomics.com/', { waitUntil: 'networkidle2' })
      .catch(() => {})

    await page
      .goto(rankingUrl, { waitUntil: 'networkidle2', referer })
      .catch(() => {})

    // 等待漫画列表容器渲染完成
    await page.waitForSelector('.list_wrap').catch(() => {})
    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})

    // 切换成人模式：调用站点全局对象 Base.setDisplay('A', path)
    await page
      .evaluate(() => {
        const Base = (globalThis as any).Base
        const location = (globalThis as any).location
        Base.setDisplay('A', location.pathname)
      })
      .catch(() => {})

    await page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})

    // 保存 cookie，供后续下载任务复用（避免重复登录）
    await this.browser.save_cookie()
  }

  /**
   * 从排行榜页面 DOM 中提取所有漫画的基本信息
   *
   * 页面结构（简化）：
   *   <div class="list_wrap">
   *     <ul>
   *       <li>
   *         <a href="/sc/webtoon/detail/toon-12345">...</a>
   *         <h4>漫画名称</h4>
   *         <img src="https://...cover.jpg" />
   *         <span class="text">简介...</span>
   *         <span class="section_remai">共 120 话</span>
   *         ...18+ / End 标记...
   *       </li>
   *       ...
   *     </ul>
   *   </div>
   */
  private async extractMangaList(page: Page): Promise<MangaInfo[]> {
    return await page.evaluate(() => {
      const doc = (globalThis as any).document

      const lis = doc.querySelectorAll('.list_wrap li')
      return Array.from(lis).map((li: any): MangaInfo => {
        const website = 'toomics'
        const name = li.querySelector('h4')?.innerText.trim()
        const url = 'https://toomics.com' + li.querySelector('a')?.getAttribute('href')
        const id = Number(url.split('/').pop())
        const cover = li.querySelector('img')?.getAttribute('src')
        const describe = li.querySelector('.text')?.innerHTML
        // 检测页面中的成人标记（18+ 图标或文字）
        const audlt = /18\+/.test(li.innerHTML)
        // 检测完结标记（End 图标或文字）
        const finsihed = /End/.test(li.innerHTML)
        // 章节数：格式通常为 "共 120 话" 或 "120/120"，取最后一个数字
        let chapterCount = li.querySelector('.section_remai')?.innerText.trim()
        chapterCount = chapterCount.split('/')[1] || chapterCount.split('/')[0]

        return {
          website,
          name,
          url,
          id,
          cover,
          covers: [cover],
          describe,
          chapterCount: parseFloat(chapterCount) || 0,
          audlt,
          finsihed,
        }
      })
    })
  }

  /**
   * 将扫描到的漫画列表增量合并到本地 JSON 文件
   *
   * 合并策略：
   *   - 新漫画（id 不存在）→ 直接追加
   *   - 已有漫画 → 更新字段，同时累积历史封面 URL 到 covers 数组
   *              （封面 URL 会随时间变化，保留历史便于回退）
   *
   * 每条漫画同步加入 mangaTask 下载队列
   */
  private mergeToJson(mangas: MangaInfo[]) {
    let json: MangaInfo[] = []
    if (fs.existsSync(this.jsonFile)) {
      json = read_json(this.jsonFile)
    }

    for (const manga of mangas) {
      const existingIndex = json.findIndex((old) => Number(old.id) === Number(manga.id))

      if (existingIndex === -1) {
        // 新漫画，直接追加
        json.push(manga)
      } else {
        // 已有漫画：合并封面历史（累积不重复的封面 URL）
        const existingCovers = json[existingIndex]?.covers || []
        if (/^https?:\/\//i.test(manga.cover) && !existingCovers.includes(manga.cover)) {
          existingCovers.push(manga.cover)
        }
        // 过滤掉非 http(s) 协议的无效封面 URL
        const validCovers = existingCovers.filter((cover: string) => /^https?:\/\//i.test(cover))
        manga.covers = validCovers
        json[existingIndex] = manga
      }

      // 入队前比对本地章节数，无更新则跳过不入队
      if (manga.chapterCount != null && manga.chapterCount > 0) {
        const folderName = make_can_be_floder(manga.name)
        if (!hasChapterUpdate(folderName, manga.chapterCount, manga.website, manga.url)) {
          continue
        }
      }

      // 将漫画加入下载任务队列，由 MangaTask 调度后续章节下载
      mangaTask.add(manga)
    }

    fs.writeFileSync(this.jsonFile, JSON.stringify(json, null, 2))
  }

  /**
   * 将浏览器内存 buffer 中的封面图片写入磁盘缓存
   *
   * 文件命名规则：{漫画id}-{原始文件名}，如 12345-cover.jpg
   *
   * 跳过条件：
   *   - 文件已存在（增量下载，避免重复写入）
   *   - buffer 不存在或体积过小（< 250 字节，可能是占位图或加载失败）
   */
  private saveCovers(mangas: MangaInfo[]) {
    if (!fs.existsSync(this.coverPath)) {
      fs.mkdirSync(this.coverPath, { recursive: true })
    }

    for (const manga of mangas) {
      const coverFile = manga.cover.split('/').pop()
      const coverPath = `${this.coverPath}/${manga.id}-${coverFile}`

      // 已存在则跳过（增量缓存）
      if (fs.existsSync(coverPath)) continue

      const buffer = this.browser.buffs[manga.cover]
      // buffer 体积 > 250 字节才视为有效图片（排除占位图/1x1 像素图）
      if (buffer && buffer.length > 250) {
        fs.writeFileSync(coverPath, buffer)
      } else {
        console.error('没有找到图片', manga.cover)
      }
    }
  }
}
