import * as fs from 'fs'
import { downloadImage, get_html } from '#api/toomics'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe';

export default class Toomics {
    private domain = 'https://toomics.com';
    private website: string
    private mangaId: number
    private mangaName: string
    private downloadPath: string
    private downloadLockedMeta: boolean
    private downloadLockedChapter: boolean = false
    private useMoblie: boolean = false
    private html: string | null = null
    private meta: any = null
    private chapters: any = null
    constructor(params: subsribeType) {
        this.website = params.website
        this.mangaId = params.id
        this.mangaName = params.name
        this.downloadLockedMeta = false
        this.downloadLockedChapter = false
        this.downloadPath = `${process.env.DOWNLOAD_PATH}/${this.website}`
    }

    /**
     * @description: 开始下载
     */
    async start() {
        // 解析章节
        console.log(this.mangaName + ' 正在分析')

        // 元数据
        this.html = await get_html(`https://toomics.com/sc/webtoon/episode/toon/${this.mangaId}`)

        this.meta = this.get_meta()

        // 章节列表
        this.chapters = this.get_chapters()

        // 漫画名删除特殊字符
        const mangaName = this.meta.title.replaceAll(/[<>:"/\\|?*]/g, '')
        // 创建元数据文件夹
        const metaFolder = `${this.downloadPath}/${mangaName}-smanga-info`
        if (!fs.existsSync(metaFolder)) await fs.promises.mkdir(metaFolder, { recursive: true })
        const metaFile = `${metaFolder}/meta.json`
        if (fs.existsSync(metaFile)) {
            const rawData = fs.readFileSync(metaFile, 'utf-8')
            const oldMetaData = JSON.parse(rawData)

            if (this.meta.finished && this.downloadLockedChapter) {
                // 移除订阅链接
                subscribe_remove({ website: this.website, id: this.mangaId })
                console.log(this.mangaName + ' 已完结，已移除订阅链接')
            }

            if (oldMetaData.chapters.length !== this.chapters.length) {
                await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))
            } else {
                console.log(this.mangaName + ' 没有更新')
            }
        } else {
            // 写入元数据
            await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))

            // 封面图
            await downloadImage(this.meta.cover, `${metaFolder}/cover.jpg`)
            await downloadImage(this.meta.banner, `${metaFolder}/banner.jpg`)
            await downloadImage(this.meta.bannerBackground, `${metaFolder}/bannerBackground.jpg`)
        }

        // 下载章节
        for (let i = 0; i < this.chapters.length; i++) {
            const chapter = this.chapters[i]
            const chapterName = chapter.name.replaceAll(/[<>:"/\\|?*]/g, '')
            const chapterFolder = `${this.downloadPath}/${mangaName}/${chapterName}`
            if (!chapter.isFree && !this.downloadLockedChapter) {
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

            console.log(`${mangaName} 正在下载章节 ${chapterName}`)

            await downloadImage(chapter.cover, `${chapterFolder}.jpg`)
            await this.download_chapter(chapter.url, chapterFolder)
        }

        console.log(mangaName + ' 订阅完毕')
    }

    get_meta() {
        let title = this.html?.match(/(?<=<h2.+>)[^<]+/s)?.[0] || '';
        title = title.trim()
        let author = this.html?.match(/(?<=mb-0 text-xs font-normal text-gray-300\">)[^<]+/s)?.[0] || '';
        author = author.trim();
        const describe = this.html?.match(/(?<=name=\"description\" content=\")[^\"]+/s)?.[0] || '';
        const banner = this.html?.match(/(?<=<!-- pc -->.+srcset=\")[^\"]+/s)?.[0] || '';
        const bannerBackground = this.html?.match(/(?<=<!-- pc bg -->.+src=\")[^\"]+/s)?.[0] || '';
        const cover = this.html?.match(/(?<=<!-- mobile -->.+src=\")[^\"]+/s)?.[0] || '';
        const finishedTxt = this.html?.match(/(?<=text-3xs font-bold text-gray-900\">)[^<]+/s)?.[0] || '';
        const finished = finishedTxt.trim() === '完结' ? true : false

        return {
            title, author, finished, describe, banner, cover, bannerBackground,
        }
    }

    get_chapters() {
        const chapterBoxs = this.html?.match(/(?<=normal_ep).+?(?=<\/li>)/gs) || [];
        const chapters = chapterBoxs.map((box: string) => {
            let index = box.match(/(?<=small>)[^<]+/s)?.[0] || ''
            index = index.trim()
            let subName = box.match(/(?<=strong.+?>)[^<]+/s)?.[0] || ''
            subName = subName.trim()
            const name = index + ' ' + subName;
            const cover = box.match(/(?<=data-original=\")[^\"]+/)?.[0] || ''
            const date = box.match(/(?<=text-muted\">)[^<]+/s)?.[0] || ''
            const url = box.match(/\/sc\/webtoon\/detail[^\']+/)?.[0] || ''

            let isFree = false
            const freeTxt = box.match(/(?<=class=\"label.+\">)[^<]+/s)?.[0] || ''
            if (freeTxt === '免费') {
                isFree = true
            }

            return { name, cover, date, url: this.domain + url, isFree }
        })

        // 更新元数据日期
        this.meta.publishDate = chapters[0].date
        this.meta.chapters = chapters;
        return chapters;
    }

    /**
     * 下载章节
     * @param chapterId
     * @param downloadPath
     */
    async download_chapter(url: string, downloadPath: string) {
        const html = await get_html(url)
        // 获取图片列表
        //let images1 = html.match(/(?<=<img id="set_image_.+src=\")http:[^\"]+[.png|.jpg]/g) || []
        let images = html.match(/(?<=src=\")https:.+?toomics.+?[.png|.jpg]*(?=\")/g) || []

        for (let i = 0; i < images.length; i++) {
            const image = images[i]
            const picName = i.toString().padStart(5, '0')
            const localPath = `${downloadPath}/${picName}.jpg`
            await downloadImage(image, localPath)
        }
    }
}