/**
 * Toomics 连载漫画更新扫描器
 *
 * 功能：访问 Toomics「连载中」列表页，根据配置扫描今日/昨日更新或全部连载漫画，
 *       将扫描到的漫画加入下载任务队列。
 *
 * 与 toomics-all 的区别：
 *   - toomics-all：扫描全站排行榜，写入 JSON + 缓存封面
 *   - toomics-update：仅扫描连载更新列表，直接加入任务队列（不写 JSON）
 */

import fs from 'node:fs'
import path from 'node:path'
import { toomicsBrowser } from '#api/browser'
import { mangaTask } from '#api/task'
import { write_log, get_config, delay, dataRoot } from '#utils/index'
import type { Page } from 'rebrowser-puppeteer'

/** 从列表页解析出的单部漫画信息（与 toomics-all.ts 保持一致） */
interface MangaInfo {
  website: string
  name: string
  url: string
  id: number
  cover: string
  covers: string[]
  describe: string
  chapterCount: number
  audlt: boolean
  finsihed: boolean
}

/**
 * page.evaluate 内部使用的序列化参数（不能传函数，只能传基本类型）
 * true = 仅扫描今日+昨日更新，false = 扫描全部连载
 */
type ScanMode = boolean

export default class ToomicsDayUpdate {
  private langTag: string        // 语言标签，如 'tc'（繁中）/ 'en'（英文）
  private url: string            // 连载列表页 URL
  private updateOnlyDay: boolean // 是否仅扫描今日+昨日更新的漫画
  waiting: boolean = false       // 人工等待标记：为 true 时暂停扫描，直到外部置 false
  private onProgress?: any

  constructor(langTag?: string, onProgress?: any) {
    this.langTag = langTag || 'tc'
    this.url = `https://toomics.com/${this.langTag}/webtoon/ongoing_all`
    const config = get_config()?.toomics || {}
    // 注意：config key "watting" 为历史遗留拼写，保持不变以兼容已有配置文件
    this.waiting = get_config()?.watting
    this.updateOnlyDay = config?.updateOnlyDay
    this.onProgress = onProgress
  }

  /**
   * 主入口：扫描连载更新列表并将漫画加入下载队列
   *
   * 流程：
   *   1. 检查当日快照是否存在 → 存在则直接使用快照，跳过浏览器扫描
   *   2. 初始化浏览器并加载 cookie
   *   3. 打开连载列表页
   *   4. 若 waiting=true，轮询等待直到外部解除（用于人工验证码处理等场景）
   *   5. 根据 updateOnlyDay 配置选择扫描范围（今日+昨日 / 全部连载）
   *   6. 扫描结果写入快照文件（原子写入）
   *   7. 随机打乱顺序后加入 mangaTask 队列
   */
  async start() {
    write_log('[toomics update] 开始扫描漫画更新')

    // 检查当日快照
    const snapshotDir = path.join(dataRoot, 'data', 'snapshots', 'toomics')
    const today = new Date().toISOString().split('T')[0]
    const snapshotFile = path.join(snapshotDir, `${today}-${this.langTag}.json`)

    if (fs.existsSync(snapshotFile)) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'))
        const mangas = snapshot.mangas || []
        mangas.sort(() => Math.random() - 0.5)
        for (const manga of mangas) {
          mangaTask.add(manga)
        }
        write_log(`[toomics update] 使用当日快照，${mangas.length} 部漫画（跳过浏览器扫描）`)
        return
      } catch (error) {
        write_log(`[toomics update] 快照读取失败，重新扫描: ${error instanceof Error ? error.message : error}`)
      }
    }

    // Step 1: 浏览器初始化
    if (!toomicsBrowser.browser?.connected) {
      await toomicsBrowser.init()
    }
    if (!toomicsBrowser.browser) return

    await toomicsBrowser.get_cookie()

    // Step 2: 打开连载列表页（try/finally 确保 page 始终被关闭）
    const page = await toomicsBrowser.new_page()
    if (!page) return

    try {
      await page
        .goto(this.url, {
          waitUntil: 'networkidle2',
          referer: `https://toomics.com/${this.langTag}/`,
        })
        .catch(() => {})

      await page.waitForSelector('.list_wrap').catch(() => {})
      await toomicsBrowser.save_cookie()

      // Step 3: 人工等待轮询
      while (this.waiting) {
        await delay(3000)
        await toomicsBrowser.save_cookie()
      }

      // Step 4: 从 DOM 中提取漫画列表
      const mangas = await this.extractMangaList(page, this.updateOnlyDay)

      // Step 5: 写入快照（原子操作：先写临时文件，再 rename）
      fs.mkdirSync(snapshotDir, { recursive: true })
      const snapshotData = {
        scan_date: today,
        lang_tag: this.langTag,
        update_only_day: this.updateOnlyDay,
        manga_count: mangas.length,
        mangas,
      }
      const tempFile = `${snapshotFile}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tempFile, JSON.stringify(snapshotData, null, 2), 'utf-8')
      fs.renameSync(tempFile, snapshotFile)

      // Step 6: 随机打乱顺序后加入下载队列
      mangas.sort(() => Math.random() - 0.5)
      for (const manga of mangas) {
        mangaTask.add(manga)
      }

      write_log(`[toomics update] 扫描完成，${mangas.length} 部漫画，快照已保存`)
    } finally {
      await page.close().catch(() => {})
    }
  }

  /**
   * 从连载列表页 DOM 中提取漫画信息
   *
   * @param page          Puppeteer Page 对象
   * @param updateOnlyDay true = 仅扫描今日+昨日更新的漫画（按星期 Tab 筛选）
   *                      false = 扫描页面上所有连载漫画
   *
   * 页面结构（updateOnlyDay=true 时）：
   *   <div class="allday">            ← 每个 allday 对应一个星期的 Tab
   *     <ul>
   *       <li>漫画条目...</li>
   *     </ul>
   *   </div>
   *   ...（共 7 个 allday，对应周一到周日）
   *
   * 页面结构（updateOnlyDay=false 时）：
   *   <div class="list_wrap">
   *     <ul>
   *       <li>漫画条目...</li>
   *     </ul>
   *   </div>
   *
   * 单条漫画的 DOM 结构：
   *   <li>
   *     <a onclick="location.href='/sc/webtoon/detail/toon-12345'">...</a>
   *     <h4>漫画名称</h4>
   *     <img src="https://...cover.jpg" />
   *     <span class="text">简介...</span>
   *     <span class="section_remai">共 120 话</span>
   *     ...18+ / End 标记...
   *   </li>
   */
  private async extractMangaList(page: Page, updateOnlyDay: boolean): Promise<MangaInfo[]> {
    return await page.evaluate((onlyDay: ScanMode) => {
      const doc = (globalThis as any).document

      /**
       * 从单个 <li> 元素中提取漫画信息
       * 注意：URL 嵌在 onclick 属性中，格式为 "location.href='/path/to/detail/toon-12345'"
       */
      function parseItem(li: any): MangaInfo {
        const website = 'toomics'
        const name = li.querySelector('h4')?.innerText.trim()

        // 从 onclick 属性中提取详情页路径（正则匹配单引号包裹的路径）
        const onclickAttr = li.querySelector('a')?.getAttribute('onclick') || ''
        const pathMatch = onclickAttr.match(/(?<=\').+?(?=\')/)
        const detailPath = pathMatch ? pathMatch[0] : ''
        const url = 'https://toomics.com' + detailPath

        const id = Number(url.split('/').pop())
        const cover = li.querySelector('img')?.getAttribute('src')
        const describe = li.querySelector('.text')?.innerHTML
        const audlt = /18\+/.test(li.innerHTML)
        const finsihed = /End/.test(li.innerHTML)

        // 章节数：格式通常为 "共 120 话" 或 "120/120"，取最后一个数字
        let chapterCount = li.querySelector('.section_remai')?.innerText.trim() || ''
        chapterCount = chapterCount.split('/')[1] || chapterCount.split('/')[0]

        return {
          website,
          name,
          url,
          id,
          cover,
          covers: [cover],
          describe,
          chapterCount: Number(chapterCount),
          audlt,
          finsihed,
        }
      }

      // 根据扫描模式选择不同的 li 元素集合
      let lis: any[]

      if (onlyDay) {
        // 按星期筛选：取今日和昨日的漫画合并
        const alldays = doc.querySelectorAll('.allday')
        const weekday = new Date().getDay() // 0=周日, 1=周一, ..., 6=周六
        // 将 JS 的周日=0 转换为页面 Tab 的索引（页面 Tab 从周一开始，0=周一）
        const todayIndex = (weekday - 1 + 7) % 7
        const yesterdayIndex = (weekday - 2 + 7) % 7

        const todayItems = alldays[todayIndex]?.querySelectorAll('li') || []
        const yesterdayItems = alldays[yesterdayIndex]?.querySelectorAll('li') || []
        lis = Array.from(todayItems).concat(Array.from(yesterdayItems))
      } else {
        // 全量扫描：取所有连载列表中的漫画
        lis = Array.from(doc.querySelectorAll('.list_wrap li'))
      }

      return lis.map(parseItem)
    }, updateOnlyDay as ScanMode)
  }
}
