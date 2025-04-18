/*
 * @Author: lkw199711 lkw199711@163.com
 * @Date: 2024-09-29 00:13:56
 * @LastEditors: lkw199711 lkw199711@163.com
 * @LastEditTime: 2024-11-17 18:11:49
 * @FilePath: \manga-get\app\services\subsribe_service.ts
 */
import * as fs from 'fs'
import { downloadImage, get_meta, image_index, image_token } from '#api/index'
import { log } from 'console'
import { subsribeType } from '#type/index.js'

// import { downloadImage } from '#utils/index'
export class Bilibili {
  private website: string
  private mangaId: number
  private mangaName: string
  private downloadPath: string
  private downloadLockedMeta: boolean
  private useMoblie: boolean = false
  constructor(params: subsribeType) {
    this.website = params.website
    this.mangaId = params.id
    this.mangaName = params.name
    this.downloadLockedMeta = false
    this.downloadPath = `M:\\manga\\${this.website}`
  }

  /**
   * @description: 开始下载
   */
  async start() {
    console.log(this.mangaName + ' 正在分析')
    // 解析章节
    // 元数据
    const meta = await get_meta(this.mangaId)
    // 章节列表
    const chapters = meta.chapters
    // 漫画名删除特殊字符
    const mangaName = meta.title.replaceAll(/[<>:"/\\|?*]/g, '')
    // 创建元数据文件夹
    const metaFolder = `${this.downloadPath}/${mangaName}-smanga-info`
    if (!fs.existsSync(metaFolder)) await fs.promises.mkdir(metaFolder, { recursive: true })
    const metaFile = `${metaFolder}/meta.json`
    if (fs.existsSync(metaFile)) {
      const rawData = fs.readFileSync(metaFile, 'utf-8')
      const oldMetaData = JSON.parse(rawData)

      // console.log(oldLength,newLength);

      if (
        oldMetaData.chapters.filter((item: any) => !item.isLocked).length !==
        meta.chapters.filter((item: any) => !item.is_locked).length
      ) {
        await fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
      } else {
        console.log(this.mangaName + ' 没有更新')
        return
      }
    } else {
      // 写入元数据
      await fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))

      // 下载banner图
      const banners = meta.banners
      for (let i = 0; i < banners.length; i++) {
        const banner = banners[i]
        const localPath = `${metaFolder}/banner${i.toString().padStart(2, '0')}.jpg`
        await downloadImage(banner, localPath)
      }

      // 封面图
      await downloadImage(meta.horizontalCover, `${metaFolder}/horizontalCover.jpg`)
      await downloadImage(meta.squareCover, `${metaFolder}/squareCover.jpg`)
      await downloadImage(meta.verticalCover, `${metaFolder}/verticalCover.jpg`)
      await downloadImage(meta.verticalCover, `${metaFolder}/cover.jpg`)
    }

    // 下载章节
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]
      const chapterName = chapter.title.replaceAll(/[<>:"/\\|?*]/g, '')
      const chapterFolder = `${this.downloadPath}/${mangaName}/${this.get_order(chapter.ord)} ${chapterName}`
      if (chapter.isLocked) {
        // 虽然未解锁 但是仍然下载封面 创建目录
        if (this.downloadLockedMeta && !fs.existsSync(chapterFolder)) {
          await fs.promises.mkdir(chapterFolder, { recursive: true })
          await downloadImage(chapter.cover, `${chapterFolder}.jpg`)
        }
        continue
      }

      // 已下载 跳过
      if (fs.existsSync(chapterFolder)) {
        const files = fs.readdirSync(chapterFolder)
        if (files.length > 0) continue
      } else {
        // 创建章节文件夹
        await fs.promises.mkdir(chapterFolder, { recursive: true })
      }

      console.log(`${mangaName} 正在下载章节 ${this.get_order(chapter.ord)} ${chapterName}`)

      await downloadImage(chapter.cover, `${chapterFolder}.jpg`)
      await this.download_chapter(chapter.targetId, chapterFolder)
    }

    console.log(mangaName + ' 订阅完毕')
  }

  /**
   * 下载章节
   * @param chapterId
   * @param downloadPath
   */
  async download_chapter(chapterId: number, downloadPath: string) {
    // 获取图片列表
    const images = await image_index(chapterId)
    log(images)
    const paths = images.map((item: any) => item.path)
    //   console.log(images)
    const tokens = await image_token(paths)
    for (let i = 0; i < tokens.length; i++) {
      const item = tokens[i]
      // const url = `${item.url}?token=${item.token}`
      const url = item.complete_url
      const picName = i.toString().padStart(5, '0')
      const localPath = `${downloadPath}/${picName}.jpg`
      await downloadImage(url, localPath)
      await avifToJpg(localPath, `${downloadPath}/${picName}.jpg`)
    }
  }

  get_order(ord: number) {
    const arr = ord.toString().split('.')

    if (arr.length > 1) return arr[0].padStart(5, '0') + '.' + arr[1]

    return ord.toString().padStart(5, '0')
  }
}
