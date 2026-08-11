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
import { tryIndexMangaMetaFile, recordChapterDownload } from '#api/manga'
import { omegascansBrowser } from '#api/browser'
import path from 'node:path'
import {
  countLocalChapters,
  getLocalChapterNames,
  localChapterExists,
} from '#services/omegascans_local'

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

    this.mangaFolder = path.join(this.downloadPath, this.name)
    this.metaFolder = path.join(this.downloadPath, this.name, '.smanga')
    this.mangaPath = path.join(this.downloadPath, this.name)
    this.mangaCompressPath = path.join(this.compressPath, this.name)
    if (onProgress) this.onProgress = onProgress
  }

  async start() {
    // if (fs.existsSync(`${this.downloadPath}/${this.name}`)) {
    //   return
    // }
    if (this.chapterCount <= 0) return
    if (!(await this.check_update())) return
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
    // 进入下载循环前过滤本地已存在的章节，避免对已下载章节执行任何后置步骤
    const localChapterNames = getLocalChapterNames(this.mangaFolder, this.mangaCompressPath)
    const pendingChapters = validChapters.filter((c: any) => !localChapterNames.has(c.name))
    const paidCount = chaptersToDownload.length - validChapters.length
    const existCount = validChapters.length - pendingChapters.length
    write_log(
      `[subscribe]${this.name} 章节共 ${chaptersToDownload.length}，付费跳过 ${paidCount}，本地已存在 ${existCount}，待下载 ${pendingChapters.length}`
    )
    this.onProgress?.setTotal(pendingChapters.length)

    // 只为本次真正需要下载的章节补封面，避免遍历历史章节并逐个发起网络请求。
    await this.download_chapter_covers(pendingChapters)

    // 先建立 manga_result，获取 mangaResultId 供逐章入库使用
    const indexResult = await tryIndexMangaMetaFile(path.join(this.metaFolder, 'meta.json'), {
      website: 'omegascans',
      source: 'download',
      sourcePath: this.mangaFolder,
    })
    const mangaResultId = indexResult?.indexId ?? 0

    let downloadedCount = 0
    for (const chapter of pendingChapters) {
      end_app() // 结束应用
      this.onProgress?.message(`正在下载章节: ${chapter.name}`)
      const downloaded = await this.download_chapter(chapter)
      // 已下载章节被跳过时，不入库、不清缓存、不执行章节间延时，直接进入下一话
      if (!downloaded) {
        this.onProgress?.report(`${chapter.name} 已存在，跳过`)
        continue
      }
      downloadedCount++
      // 逐章入库：记录本次实际下载的章节
      if (mangaResultId > 0) {
        recordChapterDownload(
          mangaResultId,
          {
            name: chapter.name,
            title: chapter.title,
            date: chapter.date,
            url: chapter.url,
            cover: chapter.cover,
            isFree: chapter.isFree,
            price: chapter.price,
          },
          downloadedCount
        ).catch(() => {})
      }
      this.onProgress?.report(`${chapter.name} 下载完成`)
      omegascansBrowser.clear_buffs() // 清除浏览器缓存
      await this.afterChapterDownload()
    }

    // 逐章入库已完成，manga_result 已在下载前建立，无需再调 tryIndexMangaMetaFile

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
   * @description 检查章节是否已存在于本地（章节目录非空或存在压缩包）
   */
  private chapter_exists(chapter: any): boolean {
    const chapterName = make_can_be_floder(chapter.name)
    return localChapterExists(this.mangaFolder, this.mangaCompressPath, chapterName)
  }

  /**
   * @description 检查是否有更新
   * @returns 是否有更新
   */
  async check_update() {
    const localChapterCount = countLocalChapters(this.mangaFolder, this.mangaCompressPath)

    // 检查是否有更新（本地已下载 >= 可下载章节数 → 无更新）
    if (localChapterCount < this.chapterCount) {
      return true
    }
    console.log(this.name, '已下载章节数', localChapterCount, '可下载章节数', this.chapterCount)
    return false
  }

  /**
   * @description 下载章节
   * @returns 是否实际执行了下载（本地已存在被跳过时返回 false）
   */
  async download_chapter(chapter: any): Promise<boolean> {
    if (!omegascansBrowser?.browser) return false

    const chapterName = make_can_be_floder(chapter.name)
    const chapterFolder = path.join(this.mangaFolder, chapterName)

    // 已下载 跳过（双保险，外层循环已提前过滤）
    if (this.chapter_exists(chapter)) {
      return false
    }
    if (!fs.existsSync(chapterFolder)) {
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
      return await this.download_chapter(chapter) // 重试下载
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
      return await this.download_chapter(chapter) // 重试下载
    }
    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i]
      const imageName = `${i.toString().padStart(5, '0')}.jpg`
      const imagePath = path.join(chapterFolder, imageName)

      this.onProgress?.message(`正在下载章节: ${chapter.name} (${i + 1}/${imageUrls.length})`)
      this.onProgress?.subProgress(i + 1, imageUrls.length)

      if (!fs.existsSync(imagePath)) {
        // 每张图片独立重试，最多 3 次；全部失败则跳过该图继续下一张
        let imageSuccess = false
        for (let attempt = 1; attempt <= 3; attempt++) {
          const error = await this.download_image(imageUrl, imagePath)
            .then(() => null)
            .catch((e: any) => e)

          if (!error) {
            imageSuccess = true
            break
          }
          write_log(
            `[chapter download]图片下载失败 第${attempt}次 ${this.name} ${chapter.name} ${imageName}`
          )
          this.imageReTry++
        }

        if (!imageSuccess) {
          write_log(
            `[chapter download]图片最终失败(3次重试后跳过) ${this.name} ${chapter.name} ${imageName} ${imageUrl}`
          )

          // 单张图片失败过多（全局累计 > 10）则重置浏览器，防止浏览器状态异常蔓延
          if (this.imageReTry >= 10) {
            this.imageReTry = 0
            write_log(`[chapter download]图片累计失败次数过多，重置浏览器.`)
            await omegascansBrowser.browser?.close().catch(() => {})
            omegascansBrowser.browser = null
          }
        }
      }
    }

    this.retry = 0 // 成功，重置章节重试次数
    write_log(`[chapter download]漫画 ${this.name} ${chapter.name} 章节下载完成 `)
    return true
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

    const metaJsonPath = path.join(this.metaFolder, 'meta.json')
    if (fs.existsSync(metaJsonPath)) {
      const existingMeta = read_json(metaJsonPath)
      if (existingMeta.chapters.length < meta.chapters.length) {
        fs.writeFileSync(metaJsonPath, JSON.stringify(meta, null, 2), 'utf-8')
      }
    } else {
      fs.writeFileSync(metaJsonPath, JSON.stringify(meta, null, 2), 'utf-8')
    }

    // 下载封面和章节封面
    const coverPath = path.join(this.metaFolder, 'cover.jpg')
    if (!fs.existsSync(coverPath)) {
      if (!meta.cover) {
        write_log(`[manga cover]漫画 ${meta.title}，没有封面链接`)
        return
      } else {
        await this.download_image(meta.cover, coverPath).catch(() => {
          write_log(`[manga cover]封面下载失败 ${meta.title}`)
        })
      }
    }
  }

  private async download_chapter_covers(chapters: any[]) {
    for (const chapter of chapters) {
      const chapterCover = path.join(this.mangaFolder, chapter.name + '.jpg')
      const compressChapterCover = path.join(
        this.compressPath,
        this.mangaName,
        chapter.name + '.jpg'
      )
      const metaCacheChapterCover = path.join(
        'C:',
        '12manga-meta-cache',
        this.mangaName,
        chapter.name + '.jpg'
      )
      const metaChapterCover = path.join(
        'C:',
        '12manga-meta',
        this.mangaName,
        chapter.name + '.jpg'
      )

      if (fs.existsSync(metaCacheChapterCover)) continue
      if (fs.existsSync(metaChapterCover)) continue

      if (fs.existsSync(compressChapterCover)) continue
      if (!fs.existsSync(chapterCover)) {
        if (!chapter.cover) {
          write_log(`[manga cover]漫画 ${this.meta.title}, 章节 ${chapter.name}，没有封面链接`)
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
      this.page = await omegascansBrowser.new_page()
    }
  }

  async download_image(url: string, filePath: string) {
    // url = encodeURI(url); // 确保URL是正确的格式
    url = url.replace(/ /g, '%20') // 替换空格为%20
    if (!omegascansBrowser.browser) return
    if (this.page.isClosed()) {
      this.page = await omegascansBrowser.new_page()
    }

    // 直接捕获 page.goto() 的 HTTP 响应，从其 buffer 获取图片数据。
    // 不再依赖 omegascansBrowser.buffs，因为 goto 到图片 URL 时
    // 资源类型为 'document'（主帧导航），不会被 handleImageResponse 捕获。
    const gotoResponse = await this.page
      .goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60 * 1000,
      })
      .catch(() => null)

    if (!gotoResponse) {
      console.log(`[download_image]下载图片失败 111`)
      await this.page?.close()
      throw new Error(`page.goto failed for ${url}`)
    }

    if (!gotoResponse.ok()) {
      console.log(`[download_image]下载图片失败 HTTP ${gotoResponse.status()}`)
      await this.page?.close()
      throw new Error(`Image fetch HTTP ${gotoResponse.status()} for ${url}`)
    }

    if (!this.e2eFastMode) {
      await delay(1000) // 等待1秒以确保图片加载完成
    }

    const buffer = await gotoResponse.buffer().catch(() => null)
    if (!buffer) {
      console.log(`[download_image]下载图片失败 222`)
      await this.page?.close()
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
