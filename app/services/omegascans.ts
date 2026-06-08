import {
  end_app,
  read_json,
  write_log,
  delay,
  copy_folder,
  get_failed_chapters,
} from '#utils/index'
import { betweenChapterDelay } from '#utils/human'
import { zip_directory } from '#utils/zip'
import { get_config, make_can_be_floder } from '#utils/index'
import { dataRoot } from '#utils/index'
import fs from 'node:fs'
import { subscribe_remove } from '#api/subsribe'
import { tryIndexMangaMetaFile } from '#api/manga'
import { omegascansBrowser } from '#api/browser'
import path from 'node:path'

export default class OmegaScans {
  id: number = 0
  name: string = 'OmegaScans'
  mangaName: string = ''
  params: any
  mangaFolder: string = ''
  metaFolder: string = ''
  downloadPath: string = 'downloads/omegascans'
  compressPath: string = 'downloads/omegascans-compress'
  cookieFile: string = 'data/cookies/omegascans.json'
  meta: any = {}
  chapterCount: number = 0 // 可下载的章节数
  retry: number = 0 // 重试次数
  imageReTry: number = 0 // 图片下载重试次数
  mangaPage: any
  page: any // Puppeteer 页面对象
  mangaCompressPath: string
  mangaPath: string
  config: any
  private downloadChapterLimit: number = 0
  private e2eFastMode = false
  private onProgress?: {
    setTotal: (n: number) => void
    report: (msg: string) => void
    message: (msg: string) => void
    subProgress: (current: number, total: number) => void
  }
  constructor(params: any, onProgress?: any) {
    const config = get_config()?.omegascans || {}
    this.id = params.id || 0
    this.name = params.name || 'OmegaScans'
    this.name = make_can_be_floder(this.name)
    this.mangaName = this.name
    this.params = params
    this.downloadPath = config.downloadPath
    this.compressPath = config.compressPath
    this.chapterCount = params.chapterCount || 0
    this.config = config
    this.downloadChapterLimit = Number(config?.downloadChapterLimit || 0)
    this.e2eFastMode = Boolean(config?.e2eFastMode)

    this.mangaFolder = `${this.downloadPath}/${this.name}`
    this.metaFolder = `${this.downloadPath}/${this.name}/.smanga`
    this.mangaPath = `${this.downloadPath}/${this.name}`
    this.mangaCompressPath = `${this.compressPath}/${this.name}`
    if (onProgress) this.onProgress = onProgress
  }

  async start() {
    // if (fs.existsSync(`${this.downloadPath}/${this.name}`)) {
    //   return
    // }
    if (this.chapterCount <= 0) return
    if (!this.check_update()) return
    // 创建元数据文件夹
    if (!fs.existsSync(this.metaFolder))
      await fs.promises.mkdir(this.metaFolder, { recursive: true })
    if (!fs.existsSync(this.mangaFolder))
      await fs.promises.mkdir(this.mangaFolder, { recursive: true })
    end_app() // 结束应用

    if (!omegascansBrowser.browser) {
      await omegascansBrowser.init()
      await omegascansBrowser.get_cookie()
    }
    if (!omegascansBrowser.browser) return
    this.page = await omegascansBrowser.new_page()

    await this.get_meta()

    const chaptersToDownload = this.limitChaptersToDownload(this.meta.chapters)
    const validChapters = chaptersToDownload.filter((c: any) => c.price <= 0)
    this.onProgress?.setTotal(validChapters.length)

    let downloadedCount = 0
    const downloadedChapters: any[] = []
    for (const chapter of chaptersToDownload) {
      if (chapter.price > 0) {
        write_log(
          `[subscribe]${this.name} 章节 ${chapter.name} 需要付费 ${chapter.price}，跳过下载`
        )
        continue
      }
      end_app() // 结束应用
      this.onProgress?.message(`正在下载章节: ${chapter.name}`)
      await this.download_chapter(chapter)
      downloadedCount++
      downloadedChapters.push(chapter)
      this.onProgress?.report(`${chapter.name} 下载完成`)
      omegascansBrowser.clear_buffs() // 清除浏览器缓存
      await this.afterChapterDownload()
    }

    // 仅当有实际章节下载时才写入记录表（只记录已下载章节）
    if (downloadedCount > 0) {
      // 重写 meta.json：只包含实际下载的章节，付费章节不入库
      const filteredMeta = { ...this.meta, chapters: downloadedChapters }
      fs.writeFileSync(`${this.metaFolder}/meta.json`, JSON.stringify(filteredMeta, null, 2), 'utf-8')
      await tryIndexMangaMetaFile(`${this.metaFolder}/meta.json`, {
        website: 'omegascans',
        source: 'download',
        sourcePath: this.mangaFolder,
      })
    }

    if (this.config?.autoCompress) {
      await this.compress_manga()
    }

    subscribe_remove({ website: this.params.website, id: this.params.id })
    write_log(`[subscribe]${this.name} 下载完毕, 已移除订阅链接`)

    end_app()
  }

  private limitChaptersToDownload(chapters: any[]) {
    if (this.downloadChapterLimit <= 0) return chapters

    return chapters.slice(0, this.downloadChapterLimit)
  }

  private async afterChapterDownload() {
    if (this.e2eFastMode) return

    await betweenChapterDelay()
  }

  /**
   * @description 检查是否有更新
   * @returns 是否有更新
   */
  async check_update() {
    const mangaFloder = `${this.downloadPath}/${this.mangaName}`
    const compressFloder = `${this.compressPath}/${this.mangaName}`
    let mangaChapterFloders: any = []
    let mangacompressChapterFloders = []
    // 筛选目录中的章节文件夹
    if (fs.existsSync(mangaFloder)) {
      mangaChapterFloders = fs.readdirSync(mangaFloder)
      mangaChapterFloders = mangaChapterFloders.filter((item: any) =>
        fs.statSync(path.join(mangaFloder, item)).isDirectory()
      )
    }

    // 筛选目录中的压缩章节文件夹
    if (fs.existsSync(compressFloder)) {
      mangacompressChapterFloders = fs.readdirSync(compressFloder)
      mangacompressChapterFloders = mangacompressChapterFloders.filter((item: any) => {
        return !mangaChapterFloders.includes(item.replace('.zip', '')) && item.endsWith('.zip')
      })
    }

    // 检查是否有更新（本地已下载 >= 可下载章节数 → 无更新）
    if (mangaChapterFloders.length + mangacompressChapterFloders.length < this.chapterCount) {
      return true
    }
    console.log(
      this.name,
      '已下载章节数',
      mangaChapterFloders.length + mangacompressChapterFloders.length,
      '可下载章节数',
      this.chapterCount
    )
    return false
  }

  async download_chapter(chapter: any) {
    if (!omegascansBrowser?.browser) return

    const chapterName = make_can_be_floder(chapter.name)
    const chapterFolder = `${this.mangaFolder}/${chapterName}`

    // 已下载 跳过
    if (fs.existsSync(chapterFolder)) {
      const files = fs.readdirSync(chapterFolder)
      if (files.length > 0) {
        return
      }
    } else if (fs.existsSync(`${this.compressPath}/${this.mangaName}/${chapterName}.zip`)) {
      return
    } else {
      // 创建章节文件夹
      await fs.promises.mkdir(chapterFolder, { recursive: true })
    }

    const chapterUrl = `https://omegascans.org/series/${this.meta.slug}/${chapter.slug}`
    /*
        const [chapterHtml, error] = await axios.get(chapterUrl).then((res) => {
            return [res, null]
        }).catch((error: any) => {
            return [null, error];
        });
*/
    await this.page_open()
    const [, pageError] = await this.page
      .goto(chapterUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60 * 1000,
      })
      .then(() => [null, null])
      .catch((openError: any) => [null, openError])
    const chapterHtml = await this.page.content().catch(() => false)
    await omegascansBrowser.save_cookie()
    await this.page.close() // 关闭页面

    if (pageError) {
      write_log(`[chapter download]章节页打开失败 ${chapter.name} from ${chapterUrl}`)
      this.retry++
      if (this.retry > 3) {
        this.retry = 0 // 重置重试次数
        throw pageError // 重新抛出错误以便上层处理
      }
      write_log(`[chapter download]重试第 ${this.retry} 次`)
      await this.download_chapter(chapter) // 重试下载
      return
    }

    // page.goto 成功，不重置 retry（下面还有 HTML 匹配可能失败）

    // 提取章节图片：<img> 标签，src 指向 uploads 目录的 omegascans CDN 图片
    const imageUrls = [...chapterHtml.matchAll(/<img[^>]+src="([^"]+\/uploads\/[^"]+)"/g)].map(
      (m) => m[1]
    )

    // 兼容旧格式：<link rel="preload" as="image">
    if (imageUrls.length === 0) {
      const preloadUrls = [
        ...chapterHtml.matchAll(/<link[^>]*rel="preload"[^>]*as="image"[^>]*href="([^"]+)"[^>]*>/g),
      ].map((m) => m[1])
      imageUrls.push(...preloadUrls)
    }

    if (imageUrls.length === 0) {
      write_log(
        `[chapter download]HTML结构不匹配 ${chapter.name}，前2000字符: ${String(chapterHtml).substring(0, 2000)}`
      )
      write_log(`[chapter download]章节页打开失败 ${chapter.name} from ${chapterUrl}`)
      this.retry++
      if (this.retry > 3) {
        this.retry = 0 // 重置重试次数
        throw new Error(`chapter download failed after ${this.retry} retries`)
      }
      write_log(`[chapter download]重试第 ${this.retry} 次`)
      await this.download_chapter(chapter) // 重试下载
      return
    }
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i]
      const imageName = `${i.toString().padStart(5, '0')}.jpg`
      const imagePath = `${chapterFolder}/${imageName}`

      this.onProgress?.message(`正在下载章节: ${chapter.name} (${i + 1}/${imageUrls.length})`)
      this.onProgress?.subProgress(i + 1, imageUrls.length)

      if (!fs.existsSync(imagePath)) {
        const [, imageError] = await this.download_image(imageUrl, imagePath)
          .then(() => [null, null])
          .catch((downloadError: any) => [null, downloadError])

        // 尝试重新下载一次
        if (imageError) {
          await this.download_image(imageUrl, imagePath).catch(async () => {
            this.retry++
            if (this.retry > 3) {
              this.retry = 0 // 重置重试次数
              write_log(`[chapter download]下载图片失败 次数过多 重置浏览器.`)
              await omegascansBrowser.browser?.close() // 关闭浏览器
              omegascansBrowser.browser = null // 清除浏览器实例
              throw imageError // 重新抛出错误以便上层处理
            }

            write_log(
              `[chapter download]下载图片失败 ${this.name} ${chapter.name} ${imageName} ${imageUrl}, 请手动检查. `
            )
          })
        }
      }
    }

    this.retry = 0 // 成功，重置重试次数
    write_log(`[chapter download]漫画 ${this.name} ${chapter.name} 章节下载完成 `)
  }

  async get_meta() {
    let meta: any = {}
    const allManga = read_json(path.join(dataRoot || '', 'data', 'omegascans.json'))
    const manga = allManga.find((item: any) => item.id === this.id)
    if (!manga) {
      throw new Error(
        `未在 omegascans.json 中找到 id=${this.id} 的漫画，请先运行 omegascans-update 任务更新数据`
      )
    }

    meta.id = manga.id
    meta.title = manga.title
    meta.subTitle = manga.alternative_names
    meta.describe = manga.description
    meta.cover = manga.thumbnail
    meta.imageCount = manga.total_views
    meta.status = manga.status
    meta.finished = manga.status === 'Completed'
    meta.rating = manga.rating
    meta.slug = manga.series_slug
    /*
                const mangaPageHtml = await axios.get(`https://omegascans.org/series/${manga.series_slug}`).catch((error: any) => {
                    write_log(`[manga meta]漫画页打开失败 ${manga.title}`);
                    throw error; // 重新抛出错误以便上层处理
                })
        */
    await this.page_open()
    await this.page
      .goto(`https://omegascans.org/series/${manga.series_slug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 40 * 1000,
      })
      .catch((error: any) => {
        write_log(`[manga meta]漫画页打开失败 ${manga.title}`)
        throw error // 重新抛出错误以便上层处理
      })
    const mangaPageHtml = await this.page.content()
    await omegascansBrowser.save_cookie()
    await this.page.close() // 关闭页面

    const tagsHtml = mangaPageHtml.match(
      /<div class=\"flex flex-row flex-wrap gap-2\">([\s\S]*?)<\/div>/s
    )?.[0]
    const tags = tagsHtml?.match(/(?<=<span[^>]+>)[^<]+/gs)
    meta.tags = tags ? tags.map((tag: string) => tag.trim()) : []
    /*
                const chaptersResponse = await axios.get('https://api.omegascans.org/chapter/query', {
                    params: {
                        page: 1,
                        perPage: 999, // 获取所有章节
                        series_id: manga.id,
                    },
                }).catch((error: any) => {
                    write_log(`[manga meta]章节列表获取失败 ${manga.title}`);
                    throw error; // 重新抛出错误以便上层处理
                })
        */
    await this.page_open() // 确保页面已打开
    await this.page
      .goto('https://api.omegascans.org/chapter/query?page=1&perPage=999&series_id=' + manga.id, {
        waitUntil: 'domcontentloaded',
      })
      .catch((error: any) => {
        write_log(`[manga meta]章节列表获取失败 ${manga.title}`)
        throw error // 重新抛出错误以便上层处理
      })
    await omegascansBrowser.save_cookie()
    const chaptersResponse = await this.page.content()
    await this.page.close() // 关闭页面
    const chapterTxt = chaptersResponse.match(/\{.*\}/s)?.[0]
    const chaptersData = JSON.parse(chapterTxt)
    // console.log(chaptersData);
    // process.exit(0);

    let chapters = chaptersData.data.map((chapter: any) => {
      return {
        id: chapter.id,
        title: chapter.chapter_title,
        name: make_can_be_floder(chapter.chapter_name),
        cover: chapter.chapter_thumbnail,
        slug: chapter.chapter_slug,
        price: chapter.price,
        createdAt: chapter.created_at,
      }
    })

    // 章节升序排序
    chapters.sort((a: any, b: any) => {
      const indexA = a.name?.match(/\d+(?:\.\d+)?/)?.[0]
      const indexB = b.name?.match(/\d+(?:\.\d+)?/)?.[0]
      return Number.parseFloat(indexA) - Number.parseFloat(indexB)
    })
    chapters = this.limitChaptersToDownload(chapters)

    meta.chapters = chapters
    this.meta = meta

    if (fs.existsSync(`${this.metaFolder}/meta.json`)) {
      const existingMeta = read_json(`${this.metaFolder}/meta.json`)
      if (existingMeta.chapters.length < meta.chapters.length) {
        fs.writeFileSync(`${this.metaFolder}/meta.json`, JSON.stringify(meta, null, 2), 'utf-8')
      }
    } else {
      fs.writeFileSync(`${this.metaFolder}/meta.json`, JSON.stringify(meta, null, 2), 'utf-8')
    }

    // 下载封面和章节封面
    if (!fs.existsSync(`${this.metaFolder}/cover.jpg`)) {
      if (!meta.cover) {
        write_log(`[manga cover]漫画 ${meta.title}，没有封面链接`)
        return
      } else {
        await this.download_image(meta.cover, `${this.metaFolder}/cover.jpg`).catch(() => {
          write_log(`[manga cover]封面下载失败 ${meta.title}`)
        })
      }
    }

    for (const chapter of chapters) {
      const chapterCover = `${this.mangaFolder}/${chapter.name}.jpg`
      const compressChapterCover = `${this.compressPath}/${this.mangaName}/${chapter.name}.jpg`
      const metaCacheChapterCover = `C:\\12manga-meta-cache/${this.mangaName}/${chapter.name}.jpg`
      const metaChapterCover = `C:\\12manga-meta/${this.mangaName}/${chapter.name}.jpg`

      if (fs.existsSync(metaCacheChapterCover)) continue
      if (fs.existsSync(metaChapterCover)) continue

      if (fs.existsSync(compressChapterCover)) continue
      if (!fs.existsSync(chapterCover)) {
        if (!chapter.cover) {
          write_log(`[manga cover]漫画 ${meta.title}, 章节 ${chapter.name}，没有封面链接`)
          continue
        } else {
          await this.download_image(chapter.cover, chapterCover).catch(() => {
            write_log(`[chapter cover]章节封面下载失败 ${chapter.name}`)
          })
        }
      }
    }
  }

  async page_open() {
    if (!omegascansBrowser.browser) return
    if (this.page.isClosed()) {
      this.page = await omegascansBrowser.browser.newPage()
    }
  }

  async download_image(url: string, filePath: string) {
    // url = encodeURI(url); // 确保URL是正确的格式
    url = url.replace(/ /g, '%20') // 替换空格为%20
    if (!omegascansBrowser.browser) return
    if (this.page.isClosed()) {
      this.page = await omegascansBrowser.new_page()
    }
    // const imagePage = await omegascansBrowser.new_page();
    const [, pageError] = await this.page
      .goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60 * 1000, // 设置超时时间为30秒
      })
      .then(() => [null, null])
      .catch((openError: any) => [null, openError])

    if (pageError) {
      console.log(`[download_image]下载图片失败 111`)
      await this.page?.close() // 关闭页面
      throw pageError // 重新抛出错误以便上层处理
    }

    if (!this.e2eFastMode) {
      await delay(1000) // 等待1秒以确保图片加载完成
    }
    const buffer = await omegascansBrowser.buffs[url]
    if (!buffer) {
      console.log(`[download_image]下载图片失败 222`)
      await this.page?.close() // 关闭页面
      throw new Error(`Image buffer is empty for ${url}`)
    }
    fs.writeFileSync(filePath, buffer)

    return await this.page.close() // 关闭页面;
  }

  async compress_manga() {
    // 复制元数据
    copy_folder(this.metaFolder, path.join(this.mangaCompressPath, '.smanga'))
    const chapters = fs.readdirSync(this.mangaPath)
    const failedChapters = get_failed_chapters() || []
    for (const chapter of chapters) {
      const fullPath = path.join(this.mangaPath, chapter)
      if (chapter.startsWith('.')) continue
      if (failedChapters.includes(chapter)) continue
      if (!fs.statSync(fullPath).isDirectory()) {
        // 不是文件夹 直接复制
        const targetFile = path.join(this.mangaCompressPath, chapter)
        fs.copyFileSync(fullPath, targetFile)
      } else {
        // 是文件夹 压缩
        const files = fs.readdirSync(fullPath)
        if (files.length === 0) {
          // 空文件夹，删除并跳过
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
