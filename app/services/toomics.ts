import * as fs from 'fs'
import { downloadImage } from '#api/toomics'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe';
import path from 'path';
import { delay, end_app, get_config, read_json, write_log } from '#utils/index';
import puppeteer from 'puppeteer';
import { toomicsBrowser } from '#api/browser';
// const crypto = require('crypto');
export default class Toomics {
    private domain = 'https://toomics.com';
    private website: string = 'toomics'
    private mangaId: number
    private mangaName: string
    private mangaUrl: string = ''
    private downloadPath: string
    private downloadLockedMeta: boolean
    // 是否下载付费章节
    private downloadLockedChapter: boolean = true
    private meta: any = null
    private metaPageHtml: string = ''
    private chapters: any = null
    private adult: boolean = false
    private mangaFolder: string = ''
    private metaFolder: string = ''
    private metaUpdate: boolean = false
    private metaOverWrite: boolean = false
    private downloadMetaError: boolean = false
    private page: puppeteer.Page | null = null
    private chapterPage: puppeteer.Page | null = null
    private checkPage: puppeteer.Page | null = null
    private metaPage: puppeteer.Page | null = null
    private retry: number = 0 // 重试次数

    private scrollStep: number = 800 // 滚动步长
    private scrollDelay: number = 500 // 滚动延迟
    private userName: string
    private passWord: string
    private langTag: string = 'sc'
    constructor(params: subsribeType) {
        const config = get_config()?.toomics || {}
        this.mangaId = Number(params.id)
        this.mangaName = params.name
        this.downloadLockedMeta = config?.downloadLockedMeta
        this.userName = config?.userName || ''
        this.passWord = config?.passWord || ''
        this.scrollStep = config?.scrollStep || this.scrollStep
        this.scrollDelay = config?.scrollDelay || this.scrollDelay
        this.downloadPath = path.join(config?.downloadPath || '', this.website);
        this.adult = params.adult || false;
        if (params.langTag) this.langTag = params.langTag
    }

    /**
     * @description: 开始下载
     */
    async start() {
        // 解析章节
        console.log(this.mangaName + ' 正在分析')

        // 任务初始化
        await this.init()

        // 获取元数据
        await this.get_meta()

        // 下载章节
        for (let i = 0; i < this.chapters.length; i++) {
            const chapter = this.chapters[i]
            const chapterName = chapter.name.replaceAll(/[<>:"/\\|?*]/g, '')
            const chapterFolder = `${this.downloadPath}/${this.mangaName}/${chapterName}`
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

            await this.download_chapter(chapter.name, chapter.url, chapterFolder)
        }

        // 关闭浏览器 释放资源
        await this.page?.close().catch(() => { })
        await this.chapterPage?.close().catch(() => { })
        await this.checkPage?.close().catch(() => { })
        await this.metaPage?.close().catch(() => { })

        console.log(this.mangaName + ' 订阅完毕')
        // 移除完结的订阅
        if (get_config().autoRemoveSubscribe || this.meta.finished) {
            subscribe_remove({ website: this.website, id: this.mangaId })
            write_log(`[subscribe]${this.mangaName} 已移除订阅链接`)
        }

        // 自动结束程序
        end_app()
    }

    /**
     * 任务初始化
     * @description 新建浏览器 新建页面 放原声兼容性
     * 检查cookie是否有效 登录并存储cookie
     * @returns 
     */
    async init() {

        if (!toomicsBrowser.browser?.connected) {
            await toomicsBrowser.init('toomics')
        }

        if (!toomicsBrowser.browser) return;

        // 获取cookie
        await toomicsBrowser.get_cookie()

        this.page = await toomicsBrowser.new_page()
        if (!this.page) return

        await this.page.goto(this.domain + `/sc`, {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000,
        }).catch(() => { })

        const homePageHtml = await this.page.content()
        if (/flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs.test(homePageHtml)) {
            write_log('[cookie]cookie过期，尝试重新登录')

            // 关闭弹窗
            await this.page.locator('div.close_popup').click().catch(() => { })
            await delay(2000)

            // 点击菜单按钮
            await this.page.locator('button[title = "菜单"]').click().catch(() => { })
            await delay(2000)

            // 点击登录按钮
            await this.page.locator('button.bg-white').filter(button => button.innerText.trim() === '登录').click().catch(() => { })
            await delay(2000)

            // 点击使用邮箱登录
            await this.page.locator('button[onclick="Base.changeSignInForm();"]').click().catch(() => { })
            await delay(2000)

            // 填充用户名与密码
            await this.page.locator('input[name="user_id"]').fill(this.userName).catch(() => { })
            await delay(1000)
            await this.page.locator('input[name="user_pw"]').fill(this.passWord).catch(() => { })
            await delay(1000)

            // 点击登录按钮
            await this.page.locator('button[type="submit"]').click().catch(() => { })
            await delay(2000)

            // 等待导航完成
            await this.page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => { })

            if (/flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs.test(await this.page?.content())) {
                write_log('登录失败，请检查账号密码')
                throw new Error('登录失败，请检查账号密码')
                return
            }
        }

        await toomicsBrowser.save_cookie();
    }

    /**
     * 获取漫画元数据 注意现在用的是移动端页面
     * @returns 
     */
    async get_meta() {
        console.log('正在获取元数据');
        if (!toomicsBrowser.browser) {
            return ''
        }

        // 获取元数据页html
        await this.get_meta_html();

        let title = this.metaPageHtml?.match(/(?<=<h2.+>)[^<]+/s)?.[0] || '';
        title = title.trim()
        let author = this.metaPageHtml?.match(/(?<=mb-0 text-xs font-normal text-gray-300\">)[^<]+/s)?.[0] || '';
        author = author.trim();
        const describe = this.metaPageHtml?.match(/(?<=name=\"description\" content=\")[^\"]+/s)?.[0] || '';
        const banner = this.metaPageHtml?.match(/(?<=<!-- pc -->.+srcset=\")[^\"]+/s)?.[0] || '';
        const bannerBackground = this.metaPageHtml?.match(/(?<=<!-- pc bg -->.+src=\")[^\"]+/s)?.[0] || '';
        const cover = this.metaPageHtml?.match(/(?<=<!-- mobile -->.+src=\")[^\"]+/s)?.[0] || '';
        const finishedTxt = this.metaPageHtml?.match(/(?<=text-3xs font-bold text-gray-900\">)[^<]+/s)?.[0] || '';
        const finished = ['完结', '完結'].includes(finishedTxt.trim()) ? true : false
        const audlt = this.adult;

        this.meta = {
            title, author, finished, audlt, describe, banner, cover, bannerBackground,
        }

        if (!finished) {
            this.downloadPath = this.downloadPath + '-连载'
        }

        this.mangaName = title.replaceAll(/[<>:"/\\|?*]/g, '')

        // 获取章节列表
        this.get_chapters()

        let downloadMetaError = false
        if (!toomicsBrowser.buffs[banner]) {
            console.log('横幅图片下载失败');
            downloadMetaError = true
        }
        if (!toomicsBrowser.buffs[bannerBackground]) {
            console.log('横幅背景图片下载失败');
            downloadMetaError = true
        }

        this.chapters.forEach((chapter: any) => {
            if (!toomicsBrowser.buffs[chapter.cover]) {
                console.log('章节封面图片下载失败', chapter.cover);
                downloadMetaError = true
            }
        })

        // 下载元数据
        await this.download_meta()

        // 检测到错误图片 重新下载元数据
        if (downloadMetaError) {
            write_log(`[meta]${this.mangaName} 下载元数据失败,重新执行元数据获取`)
            this.downloadMetaError = true
            await this.get_meta()
        } else {
            this.downloadMetaError = false
            toomicsBrowser.clear_buffs()
        }
    }

    get_chapters() {
        const chapterBoxs = this.metaPageHtml?.match(/(?<=normal_ep).+?(?=<\/li>)/gs) || [];
        const chapters = chapterBoxs.map((box: string) => {
            let index = box.match(/(?<=small>)[^<]+/s)?.[0] || ''
            index = index.trim()
            let subName = box.match(/(?<=strong.+?>)[^<]+/s)?.[0] || ''
            subName = subName.trim()
            if (subName === '') {
                subName = box.match(/(?<=Up<\/span>)[^<]+/s)?.[0] || ''
                subName = subName.trim()
            }
            const name = index + ' ' + subName;
            const cover = box.match(/(?<=data-original=\")[^\"]+/)?.[0] || ''
            const date = box.match(/(?<=text-muted\">)[^<]+/s)?.[0] || ''
            const url = box.match(/\/(sc|tc)\/webtoon\/detail[^\']+/)?.[0] || ''

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
        this.chapters = chapters;
    }

    async download_meta() {
        let homeMeta = null;
        if (fs.existsSync('data/toomics-all.json')) {
            const json = read_json('data/toomics-all.json')
            const manga = json.find((manga: any) => Number(manga.id) === this.mangaId)
            if (manga) {
                homeMeta = manga
            }
        }

        // 创建元数据文件夹
        this.metaFolder = `${this.downloadPath}/${this.mangaName}-smanga-info`
        this.mangaFolder = `${this.downloadPath}/${this.mangaName}`
        if (!fs.existsSync(this.metaFolder)) await fs.promises.mkdir(this.metaFolder, { recursive: true })
        if (!fs.existsSync(this.mangaFolder)) await fs.promises.mkdir(this.mangaFolder, { recursive: true })

        const metaFile = `${this.metaFolder}/meta.json`
        if (fs.existsSync(metaFile)) {
            const rawData = fs.readFileSync(metaFile, 'utf-8')
            const oldMetaData = JSON.parse(rawData)

            // 章节更新
            if (oldMetaData.chapters.length !== this.chapters.length) {
                this.metaUpdate = true
            }
        }

        // 写入封面
        if (homeMeta) {
            // 更新主封面
            this.download_cover(homeMeta.cover, `${this.metaFolder}/cover.jpg`, true)
            // 下载所有封面
            homeMeta.covers.forEach((cover: string, index: number) => {
                const coverName = `cover${index}.jpg`
                this.download_cover(cover, `${this.metaFolder}/${coverName}`)
            })

            if (homeMeta.covers.length > this.meta?.covers?.length) {
                this.meta.covers = homeMeta.covers
                this.metaUpdate = true
            }
        }

        if (!fs.existsSync(metaFile) || this.metaOverWrite || this.metaUpdate || this.downloadMetaError) {
            // 写入元数据
            await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))

            // 封面图
            // fs.writeFileSync(`${this.metaFolder}/cover.jpg`, toomicsBrowser.buffs[this.meta.cover])
            fs.writeFileSync(`${this.metaFolder}/banner.jpg`, toomicsBrowser.buffs[this.meta.banner])
            fs.writeFileSync(`${this.metaFolder}/bannerBackground.jpg`, toomicsBrowser.buffs[this.meta.bannerBackground])
        } else {
            console.log(this.mangaName + ' 没有更新')
        }


        // 下载章节封面
        for (let i = 0; i < this.chapters.length; i++) {
            const chapter = this.chapters[i]
            const chapterName = chapter.name.replaceAll(/[<>:"/\\|?*]/g, '')
            const chapterCover = `${this.mangaFolder}/${chapterName}.jpg`
            // 下载章节封面
            if (!fs.existsSync(chapterCover)) {
                fs.writeFileSync(chapterCover, toomicsBrowser.buffs[chapter.cover])
            }
        }
    }

    download_cover(url: string, localPath: string, overWrite: boolean = false) {
        const imageName = url.split('/').pop()
        if (!imageName) {
            return
        }
        if (!overWrite && fs.existsSync(localPath)) {
            return
        };
        const imagePath = `data/toomics-covers/${this.mangaId}-${imageName}`
        if (!fs.existsSync(imagePath)) {
            console.error('封面图片不存在,请检查全部漫画获取程序', imagePath)
            return
        };

        fs.copyFileSync(imagePath, localPath)
    }

    async get_meta_html() {
        this.metaPage = await toomicsBrowser.new_page();
        if (!this.metaPage) return
        this.metaPage.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1')
        this.mangaUrl = `https://toomics.com/${this.langTag}/webtoon/episode/toon/${this.mangaId}`
        await this.metaPage.goto(this.mangaUrl, { waitUntil: 'networkidle2', referer: `https://toomics.com/${this.langTag}/webtoon/search`, timeout: 180 * 1000 }).catch(() => { })
        await toomicsBrowser.save_cookie();

        if (/ep\//.test(this.metaPage.url())) {
            await this.metaPage.locator('h1 a').click().catch(() => { })
            await this.metaPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
            await delay(2000)
            await toomicsBrowser.save_cookie();
        }

        // 不断滚动 直到页面底部
        console.log('开始滚动页面,等待加载图片');
        let scrollY = -1;
        let window: any;
        await this.metaPage.mouse.move(1000, 1000)

        // 向上滚动到顶部
        while (1) {
            let protocolError = false
            await this.metaPage.mouse.wheel({ deltaY: -this.scrollStep }).catch(() => { protocolError = true })
            await delay(this.scrollDelay)
            const nowScrollY = await this.metaPage.evaluate(() => window.scrollY).catch(() => { protocolError = true })
            if (protocolError) continue

            if (nowScrollY === 0) break
            scrollY = nowScrollY
        }

        // 向下滚动到底部
        while (1) {
            let protocolError = false
            await this.metaPage.mouse.wheel({ deltaY: this.scrollStep }).catch(() => { protocolError = true })
            await delay(this.scrollDelay)
            const nowScrollY = await this.metaPage.evaluate(() => window.scrollY).catch(() => { protocolError = true })
            if (protocolError) continue

            if (nowScrollY === scrollY) break
            scrollY = nowScrollY
        }

        await this.metaPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
        await delay(1000)
        this.metaPageHtml = await this.metaPage.content()

        await this.metaPage.close()
    }

    /**
     * 下载章节
     * @description: 下载章节 通过浏览器模拟下载 图片下载失败有两种 一种是请求失败 无图片 另一种是图片请求成功 但是图片内容为空
     * 重试三次后还未成功 打印错误 下载则跳过
     * @param chapterName 章节名称
     * @param url 章节链接
     * @param downloadPath 下载路径
     * @param reloadImageindexs 重试图片
     * @returns 
     */
    async download_chapter(chapterName: string, url: string, downloadPath: string, reloadImageindexs: number[] = []) {
        const errImgs: number[] = []
        const interfereImages: number[] = [];
        if (reloadImageindexs.length > 0) {
            this.retry++
            if (this.retry > 3) {
                write_log(`[chapter download]${chapterName} 重试次数过多,跳过`)
                this.retry = 0
                return
            }
        } else {
            this.retry = 0
        }
        if (!toomicsBrowser.browser) return;
        this.chapterPage = await toomicsBrowser.new_page();
        if (!this.chapterPage) return

        // 开始下载章节
        console.log('正在下载章节:', chapterName)

        await this.chapterPage.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000,
            referer: this.mangaUrl
        }).catch(() => { })

        // 获取最新cookie
        await toomicsBrowser.save_cookie();

        // 不断滚动 直到页面底部
        console.log('开始滚动页面,等待加载图片');
        let scrollY = -1;
        let window: any, document: any;
        await this.chapterPage.mouse.move(1000, 1000)
        while (1) {
            await this.chapterPage.mouse.wheel({ deltaY: this.scrollStep }).catch(() => { })
            await delay(this.scrollDelay)
            const nowScrollY = await this.chapterPage.evaluate(() => window.scrollY).catch(() => { })
            if (nowScrollY === scrollY) break
            scrollY = nowScrollY
        }

        // 等待图片网络请求完成
        await this.chapterPage.waitForNetworkIdle().catch(() => { })

        // 等待三秒之后开始下载
        await delay(3000)

        // 获取所有图片的url
        const imageUrls = await this.chapterPage.evaluate(() => {
            const els = document.querySelectorAll('img[id^="set_image_"]')
            const urls = Array.from(els).map((el: any) => el.src)
            return urls;
        })

        // 数量正确 进行下载
        for (let i = 0; i < imageUrls.length; i++) {
            const imageUrl = imageUrls[i]
            const picName = i.toString().padStart(5, '0')
            const localPath = `${downloadPath}/${picName}.jpg`

            // 如果为重试模式 仅下载指定图片
            if (reloadImageindexs.length > 0 && !reloadImageindexs.includes(i)) {
                continue;
            }

            // 记录错误图片
            if (!toomicsBrowser.buffs[imageUrl]) {
                errImgs.push(i)
                continue
            }

            // 记录干扰图片
            if (toomicsBrowser.buffs[imageUrl].length < 250) {
                interfereImages.push(i)
            }

            fs.writeFileSync(localPath, toomicsBrowser.buffs[imageUrl])
        }

        toomicsBrowser.clear_buffs()
        this.chapterPage.close()

        if (interfereImages.length > 0) {
            const interfereStr = interfereImages.length > 0 ? `, 检测到干扰图片:${interfereImages}` : ''
            const errorStr = errImgs.length > 0 ? `, 请求失败图片:${errImgs}` : ''
            write_log(`[chapter download]${chapterName}下载失败${interfereStr}${errorStr},进行重新下载`);
            await this.download_chapter(chapterName, url, downloadPath, interfereImages.concat(errImgs))
            return
        }

        write_log(`[chapter download]${chapterName} 下载完成.`)

        await delay(3000)

        end_app();
    }
}