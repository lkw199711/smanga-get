import * as fs from 'fs'
import { downloadImage, get_html } from '#api/toomics'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe';
import path from 'path';
import { delay, write_log } from '#utils/index';
import puppeteer from 'puppeteer';
import { browser, browserPhone } from '#api/browser';
export default class Toomics {
    private domain = 'https://toomics.com';
    private website: string
    private mangaId: number
    private mangaName: string
    private mangaUrl: string = ''
    private downloadPath: string
    private downloadLockedMeta: boolean
    private downloadLockedChapter: boolean = false
    private html: string | null = null
    private meta: any = null
    private chapters: any = null
    private adult: boolean = false
    private mangaFolder: string = ''
    private metaFolder: string = ''
    private metaUpdate: boolean = false
    private metaOverWrite: boolean = false

    private page: puppeteer.Page | null = null
    private chapterPage: puppeteer.Page | null = null
    private checkPage: puppeteer.Page | null = null
    private metaPage: puppeteer.Page | null = null
    private chapterPageImages: any = {}

    private scrollStep: number = 1000 // 滚动步长
    private scrollDelay: number = 500 // 滚动延迟
    constructor(params: subsribeType) {
        this.website = params.website
        this.mangaId = params.id
        this.mangaName = params.name
        this.downloadLockedMeta = false
        // 是否下载付费章节
        this.downloadLockedChapter = process.env.TOOMICS_DWONLOAD_VIP === 'on'

        if (process.env.DOWNLOAD_PATH) {
            this.downloadPath = path.join(process.env.DOWNLOAD_PATH, this.website);
        } else {
            this.downloadPath = path.join(process.cwd(), this.website);
        }

        this.adult = params.adult || false
    }

    /**
     * @description: 开始下载
     */
    async start() {
        // 解析章节
        console.log(this.mangaName + ' 正在分析')

        // 获取元数据
        await this.get_meta()

        // 获取章节列表
        this.get_chapters()

        await this.download_meta()

        // 任务初始化
        await this.init().catch((err) => {
            console.error(this.mangaName + ' 任务初始化失败', 'toomics响应超时', err)
            return
        });
        // return;
        if (!browser) return

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

            console.log(`${this.mangaName} 正在下载章节 ${chapterName}`)
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
        this.page?.close()
        this.chapterPage?.close()
        this.checkPage?.close()
        this.metaPage?.close()

        console.log(this.mangaName + ' 订阅完毕')
    }

    /**
     * 任务初始化
     * @description 新建浏览器 新建页面 放原声兼容性
     * 检查cookie是否有效 登录并存储cookie
     * @returns 
     */
    async init() {

        if (fs.existsSync('toomics-cookies.json')) {
            const cookie1 = fs.readFileSync('toomics-cookies.json', 'utf-8')
            const cookie = JSON.parse(cookie1)
            browser.setCookie(...cookie)
        } else {
            const cookieStr = process.env.TOOMICS_COOKIE || '';
            const cookies = cookieStr.split(';').map(pair => {
                const [name, value] = pair.trim().split('=');
                return {
                    name: name,
                    value: value,
                    domain: '.toomics.com', // 替换为目标网站主域名
                    path: '/',
                    secure: false,
                    sameParty: false,
                    httpOnly: false
                };
            });
            browser.setCookie(...cookies);
        }


        this.page = await browser.newPage()

        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA-Platform': '"Windows"', // 新版指纹头‌:ml-citation{ref="3" data="citationList"}
            'Upgrade-Insecure-Requests': '1'
        });

        let navigator: any;
        // 消除navigator.webdriver属性‌:ml-citation{ref="3" data="citationList"}
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        });

        // 覆盖plugins属性
        await this.page.evaluate(() => {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3] // 返回非空数组
            });
        });

        await this.page.goto(this.domain + '/sc', {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000,
        })

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
            await this.page.locator('input[name="user_id"]').fill(process.env.TOOMICS_EMAIL || '').catch(() => { })
            await delay(1000)
            await this.page.locator('input[name="user_pw"]').fill(process.env.TOOMICS_PASSWORD || '').catch(() => { })
            await delay(1000)

            // 点击登录按钮
            await this.page.locator('button[type="submit"]').click().catch(() => { })
            await delay(2000)

            // 等待导航完成
            await this.page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => { })

            if (/flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs.test(await this.page?.content())) {
                write_log('登录失败，请检查账号密码')
                return
            }
        }

        await this.set_cookie();
    }

    /**
     * 获取漫画元数据 注意现在用的是移动端页面
     * @returns 
     */
    async get_meta() {
        console.log('正在获取元数据');

        //this.html = await get_html(`https://toomics.com/sc/webtoon/episode/toon/${this.mangaId}`, true)
        this.mangaUrl = `https://toomics.com/sc/webtoon/episode/toon/${this.mangaId}`
        this.html = await this.get_html(this.mangaUrl)

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
        const audlt = this.adult;

        this.meta = {
            title, author, finished, audlt, describe, banner, cover, bannerBackground,
        }

        if (!finished) {
            this.downloadPath = this.downloadPath + '-连载'
        }

        this.mangaName = title.replaceAll(/[<>:"/\\|?*]/g, '')
    }

    async download_meta() {
        // 创建元数据文件夹
        this.metaFolder = `${this.downloadPath}/${this.mangaName}-smanga-info`
        this.mangaFolder = `${this.downloadPath}/${this.mangaName}`
        if (!fs.existsSync(this.metaFolder)) await fs.promises.mkdir(this.metaFolder, { recursive: true })
        if (!fs.existsSync(this.mangaFolder)) await fs.promises.mkdir(this.mangaFolder, { recursive: true })

        const metaFile = `${this.metaFolder}/meta.json`
        if (fs.existsSync(metaFile)) {
            const rawData = fs.readFileSync(metaFile, 'utf-8')
            const oldMetaData = JSON.parse(rawData)

            // 检查封面是否更新
            if (this.meta.cover !== oldMetaData.cover) {

                let newNum = 0;
                while (oldMetaData['cover' + newNum]) {
                    newNum++;
                }

                // 将就封面存为新建序号
                this.meta['cover' + newNum] = oldMetaData.cover
                fs.renameSync(`${this.metaFolder}/cover.jpg`, `${this.metaFolder}/cover${newNum}.jpg`)
                this.metaUpdate = true
            }

            // 章节更新
            if (oldMetaData.chapters.length !== this.chapters.length) {
                this.metaUpdate = true
            }

            // 移除完结的订阅
            if (this.meta.finished && this.downloadLockedChapter) {
                subscribe_remove({ website: this.website, id: this.mangaId })
                console.log(this.mangaName + ' 已完结，已移除订阅链接')
            }
        }

        if (!fs.existsSync(metaFile) || this.metaOverWrite || this.metaUpdate) {
            // 写入元数据
            await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))

            // 封面图
            await downloadImage(this.meta.cover, `${this.metaFolder}/cover.jpg`)
            await downloadImage(this.meta.banner, `${this.metaFolder}/banner.jpg`)
            await downloadImage(this.meta.bannerBackground, `${this.metaFolder}/bannerBackground.jpg`)
        } else {
            console.log(this.mangaName + ' 没有更新')
        }

        for (let i = 0; i < this.chapters.length; i++) {
            const chapter = this.chapters[i]
            const chapterName = chapter.name.replaceAll(/[<>:"/\\|?*]/g, '')
            const chapterFolder = `${this.mangaFolder}/${chapterName}`
            // 下载章节封面
            if (this.metaOverWrite || !fs.existsSync(`${chapterFolder}.jpg`)) {
                await downloadImage(chapter.cover, `${chapterFolder}.jpg`)
            }
        }
    }

    get_chapters() {
        const chapterBoxs = this.html?.match(/(?<=normal_ep).+?(?=<\/li>)/gs) || [];
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
        this.chapters = chapters;
        return chapters;
    }

    async get_end_manga() {
        const endMangaUrl = 'https://toomics.com/sc/webtoon/ranking/genre/2'
        // const html = await get_html(endMangaUrl)
        const endMangaBoxs = html.match(/(?<=<li>.+?<div class=\"visual\">).+?(?=<\/li>)/gs) || [];

        const endMangaList = endMangaBoxs.map((box: string) => {
            let title = box.match(/(?<=title\">)[^<"]+/)?.[0] || ''
            title = title.trim()
            const endTxt = box.match(/(?<=ico_fin\">)[^<]+/s)?.[0] || ''
            const isEnd = endTxt.trim() === 'End' ? true : false
            const adultTxt = box.match(/(?<=ico_19plus\">)[^<]+/s)?.[0] || ''
            const adult = adultTxt.trim() === '18+' ? true : false
            let cover = box.match(/(?<=src=\")[^\"]+/)?.[0] || ''
            if (!cover) cover = box.match(/(?<=data-original=\")[^\"]+/)?.[0] || ''
            const url = box.match(/(?<=href=\")[^\"]+/)?.[0] || ''
            const id = url.match(/(?<=toon\/)[0-9]+/s)?.[0] || ''
            return { name: title, id, cover, url: this.domain + url, isEnd, adult }
        })

        fs.writeFileSync('toomicsEnd.json', JSON.stringify(endMangaList, null, 2), 'utf-8')

    }

    async download_chapter(chapterName: string, url: string, downloadPath: string) {
        let errImgs = 0, repeatImg = 0;
        if (!browser) return;
        this.chapterPage = await browser.newPage()
        // 储存图片到内存
        this.chapterPage.on('response', async (response) => {
            const url = response.url();
            if (response.request().resourceType() === 'image') {
                try {
                    const buffer = await response.buffer();
                    this.chapterPageImages[url] = buffer;
                } catch (e) { }
            }
        })

        // 开始下载章节
        console.log('正在下载章节:', chapterName)

        await this.chapterPage.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000,
            referer: this.mangaUrl
        }).catch(() => { })

        // 获取最新cookie
        await this.set_cookie()

        // 不断滚动 直到页面底部
        console.log('开始滚动页面,等待加载图片');
        let scrollY = -1;
        let window: any, document: any;
        await this.chapterPage.mouse.move(1000, 1000)
        while (1) {
            await this.chapterPage.mouse.wheel({ deltaY: this.scrollStep })
            await delay(this.scrollDelay)
            const nowScrollY = await this.chapterPage.evaluate(() => window.scrollY)
            if (nowScrollY === scrollY) break
            scrollY = nowScrollY
        }

        // 等待三秒之后开始下载
        await delay(3000)

        // 等待图片网络请求完成
        await this.chapterPage.waitForNetworkIdle().catch(() => { })
        const finishedImages: any = {};
        // 获取所有图片的url
        const imageUrls = await this.chapterPage.evaluate(() => {
            const els = document.querySelectorAll('img[id^="set_image_"]')
            const urls = Array.from(els).map((el: any) => el.src)
            return urls;
        })

        // 检测是否有图片加载失败
        for (let i = 0; i < imageUrls.length; i++) {
            const imageUrl = imageUrls[i]
            if (!this.chapterPageImages[imageUrl]) {
                errImgs++
                console.error('图片下载失败:', imageUrl)
            }
        }

        // 有错误图片则不进行下载 留空文件夹
        if (errImgs > 0) {
            write_log(`[chapter download]${chapterName} 下载失败,错误图片 ${errImgs} 张`)
            await this.chapterPage.close()
            return
        } else {
            // 数量正确 进行下载
            for (let i = 0; i < imageUrls.length; i++) {
                const imageUrl = imageUrls[i]
                const picName = i.toString().padStart(5, '0')
                const localPath = `${downloadPath}/${picName}.jpg`

                if (finishedImages[imageUrl]) {
                    console.log('检测到重复图片', imageUrl);
                    repeatImg++
                    continue;
                }

                fs.writeFileSync(localPath, this.chapterPageImages[imageUrl])

                finishedImages[imageUrl] = localPath
            }

            let repeatStr = '';
            if (repeatImg > 0) {
                repeatStr = `,重复图片 ${repeatImg} 张`;
            }

            write_log(`[chapter download]${chapterName} 下载完成 ${repeatStr}`)
        }

        this.chapterPageImages = {}
        this.chapterPage.close()

        await delay(3000)

    }

    async get_html(url: string) {
        if (!browserPhone) {
            return ''
        }

        let Base: any;

        if (fs.existsSync('toomics-cookies-nouser.json')) {
            const cookie1 = fs.readFileSync('toomics-cookies-nouser.json', 'utf-8')
            const cookie = JSON.parse(cookie1)
            browserPhone.setCookie(...cookie)
        }

        this.checkPage = await browserPhone.newPage()
        await this.checkPage.goto(this.domain + '/sc', { waitUntil: 'networkidle2', timeout: 60 * 1000 })
        let pcHtml = await this.checkPage.content()
        if (/<button class=\"group active\">/.test(pcHtml)) {
            console.log('元数据成人模式未开启,尝试打开成人模式');
            await this.checkPage.evaluate(() => {
                Base.setDisplay('A', '/sc');
            })

            await this.checkPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
        }

        pcHtml = await this.checkPage.content()

        if (/<button class=\"group active\">/.test(pcHtml)) {
            throw new Error('成人模式打开失败,退出任务')
        }

        this.set_cookie_nouser();

        this.checkPage.close()

        this.metaPage = await browserPhone.newPage()

        await this.metaPage.goto(url, { waitUntil: 'networkidle2', referer: 'https://toomics.com/sc/webtoon/search' }).catch(() => { })
        await this.set_cookie_nouser()

        if (/ep\//.test(this.metaPage.url())) {
            await this.metaPage.locator('h1 a').click().catch(() => { })
            await this.metaPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { })
            await delay(2000)
            await this.set_cookie_nouser()
        }

        await delay(2000)
        const html = await this.metaPage.content()

        await this.metaPage.close()
        return html
    }

    async set_cookie() {
        if (!browser) return;
        const cookies = await browser.cookies()
        fs.writeFileSync('toomics-cookies.json', JSON.stringify(cookies, null, 2));
        console.log('toomics-cookie更新成功', new Date().toLocaleString());
    }

    async set_cookie_nouser() {
        if (!browserPhone) return;
        const cookies = await browserPhone.cookies()
        fs.writeFileSync('toomics-cookies-nouser.json', JSON.stringify(cookies, null, 2));
        console.log('toomics-cookie-nouser更新成功', new Date().toLocaleString());
    }

    // 以下为暂未使用的方法
    // 元数据
    // await this.page?.goto(`https://toomics.com/sc/webtoon/episode/toon/${this.mangaId}`, {
    //     waitUntil: 'networkidle2'
    // })

    get_chapters_pc() {
        const chapterBoxs = this.html?.match(/(?<=normal_ep).+?(?=<\/li>)/gs) || [];
        const chapters = chapterBoxs.map((box: string) => {
            let index = box.match(/(?<=class=\"num\">)[^<]+/s)?.[0] || ''
            index = index.trim()
            let subName = box.match(/(?<=strong.+?>)[^<]+/s)?.[0] || ''
            subName = subName.trim()
            const name = index + ' ' + subName;
            const cover = box.match(/(?<=data-original=\")[^\"]+/)?.[0] || ''
            const date = box.match(/(?<=datetime=\")[^\"]+/s)?.[0] || ''
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

    async get_cookie() {
        if (!browser) return;
        const cookie1 = fs.readFileSync('toomics-cookies.json', 'utf-8')
        const cookie = JSON.parse(cookie1)
        browser.setCookie(...cookie)
        this.page = await browser.newPage()
        await this.page?.goto('https://toomics.com', {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000,
        })

        await delay(30 * 1000)

        const cookies = await browser.cookies();
        fs.writeFileSync('toomics-cookies.json', JSON.stringify(cookies, null, 2));
    }
}