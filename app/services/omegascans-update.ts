import { read_json, write_log, make_can_be_floder, get_config, dataRoot } from '#utils/index'
import { omegascansBrowser } from '#api/browser'
import { mangaTask } from '#api/task'
import fs, { writeFileSync } from 'node:fs'
import path from 'node:path'
import { countLocalChapters } from '#services/omegascans_local'

export default class OmegaScansUpdate {
  page: any // Puppeteer 页面对象
  downloadPath: string // 下载路径
  compressPath: string // 压缩路径
  private onProgress?: any

  constructor(params: any, onProgress?: any) {
    const config = get_config('omegascans') || {}
    this.downloadPath = config.downloadPath
    this.compressPath = config.compressPath
  }

  async start() {
    // 确保快照目录存在
    const snapshotDir = path.join(dataRoot, 'data', 'snapshots', 'omegascans')
    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true })
    }

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const snapshotFile = path.join(snapshotDir, `${today}.json`)

    let res: any
    if (fs.existsSync(snapshotFile)) {
      try {
        res = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'))
        write_log(
          `[omegascans update] 使用当日快照，${res.data?.length || 0} 部漫画（跳过 API 请求）`
        )
      } catch (error) {
        write_log(
          `[omegascans update] 快照读取失败，重新请求: ${error instanceof Error ? error.message : error}`
        )
      }
    }

    if (!res) {
      // 当日快照可直接用于扫描；只有确实需要访问 API 时才启动浏览器。
      if (!omegascansBrowser.browser) {
        await omegascansBrowser.init()
        await omegascansBrowser.get_cookie()
      }
      if (!omegascansBrowser.browser) return

      this.page = await omegascansBrowser.new_page()
      res = await this.request_interface(
        `https://api.omegascans.org/query?series_type=Comic&perPage=9999&adult=true&order=desc&orderBy=latest&page=1`
      )

      // 写入快照（直接写目标文件，避免 Docker 9p 跨文件系统 temp→rename 不可见问题）
      try {
        const snapshotJson = JSON.stringify(res, null, 2)
        fs.writeFileSync(snapshotFile, snapshotJson, 'utf-8')
        write_log(`[omegascans update] API 请求完成，快照已保存`)
      } catch (error) {
        write_log(
          `[omegascans update] 快照写入失败: ${error instanceof Error ? error.message : error}`
        )
        throw error
      }
    }

    const mangaList = res.data || []

    if (mangaList && mangaList.length > 0) {
      writeFileSync(`${dataRoot}data/omegascans.json`, JSON.stringify(mangaList, null, 2), 'utf-8')
    } else {
      write_log('[manga update]漫画列表获取失败')
      return
    }
    // console.log(mangaList.length);
    // process.exit(0)
    mangaList
      .filter((manga: any) => {
        if (manga.status === 'Dropped') return false // 跳过已放弃的漫画

        const mangaName = make_can_be_floder(manga.title)
        const paidChapters = manga.paid_chapters || []
        const chaptersCount = manga?.meta?.chapters_count || 0
        const mangaFolder = path.join(this.downloadPath, mangaName)
        const mangaCompressFolder = path.join(this.compressPath, mangaName)
        const metaFolder = path.join(mangaFolder, '.smanga')
        const metaFile = path.join(metaFolder, 'meta.json')

        // 计算可下载的章节数
        manga.chapterCount = chaptersCount - paidChapters.length

        // 入队前比对：本地已下载 >= 可下载章节数 → 无更新，跳过不入队
        const localCount = countLocalChapters(mangaFolder, mangaCompressFolder)
        if (localCount >= manga.chapterCount) return

        if (fs.existsSync(metaFile)) {
          const oldMeta = read_json(metaFile) || {}
          if (oldMeta?.status === 'Completed' && manga.status === 'Completed') return
        }

        return true
      })
      .forEach((manga: any) => {
        const params = {
          id: manga.id,
          name: manga.title,
          url: `https://omegascans.org/comics/${manga.series_slug}`,
          series_slug: manga.series_slug,
          status: manga.status,
          website: 'omegascans',
          chapterCount: manga.chapterCount,
        }
        // console.log(params)
        mangaTask.add(params)
      })
  }

  async page_open() {
    if (!omegascansBrowser.browser) return
    if (this.page.isClosed()) {
      this.page = await omegascansBrowser.new_page()
    }
  }

  async request_interface(url: string) {
    await this.page_open() // 确保页面已打开
    await this.page
      .goto(url, {
        waitUntil: 'networkidle2',
      })
      .catch((error: any) => {
        write_log(`[manga update]漫画列表获取失败`)
        throw error // 重新抛出错误以便上层处理
      })
    await omegascansBrowser.save_cookie()
    const chaptersResponse = await this.page.content()
    await this.page.close() // 关闭页面
    const chapterTxt = chaptersResponse.match(/\{.*\}/s)?.[0]
    return JSON.parse(chapterTxt)
  }
}
