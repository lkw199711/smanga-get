import * as fs from 'fs'
import { downloadImage, get_html } from '#api/toomics'
import { subsribeType } from '#type/index.js'
import { subscribe_remove } from '#api/subsribe';
import path from 'path';
import { delay, write_log } from '#utils/index';
import puppeteer from 'puppeteer';
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
    private adult: boolean = false

    private browser: puppeteer.Browser | null = null
    private page: puppeteer.Page | null = null
    private chapterPageImages: any = {}

    private scrollStep: number = 200 // 滚动步长
    private scrollDelay: number = 300 // 滚动延迟
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

        // 任务初始化
        await this.init().catch((err) => {
            console.error(this.mangaName + ' 任务初始化失败', 'toomics响应超时', err)
            return
        });

        if (!this.browser) return

        // 获取元数据
        await this.get_meta()

        // 获取章节列表
        this.get_chapters()

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
            if (!fs.existsSync(`${chapterFolder}.jpg`)) {
                await downloadImage(chapter.cover, `${chapterFolder}.jpg`)
            }
            await this.download_chapter(chapter.name, chapter.url, chapterFolder)
        }

        // 关闭浏览器 释放资源
        this.browser.close()

        console.log(mangaName + ' 订阅完毕')
    }

    /**
     * 任务初始化
     * @description 新建浏览器 新建页面 放原声兼容性
     * 检查cookie是否有效 登录并存储cookie
     * @returns 
     */
    async init() {
        this.browser = await puppeteer.launch({
            headless: false,
            timeout: 60 * 1000,
            args: ['--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',// 容器环境必备参数‌:ml-citation{ref="5,6" data="citationList"}
                '--disable-blink-features=AutomationControlled', // 隐藏自动化特征‌:ml-citation{ref="3" data="citationList"}
                '--disable-web-security',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--lang=zh-CN,zh', // 设置浏览器语言
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
                //'--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
            ],
            defaultViewport: {
                width: 1920,
                height: 1440,
            },
        });

        if (fs.existsSync('toomics-cookies.json')) {
            const cookie1 = fs.readFileSync('toomics-cookies.json', 'utf-8')
            const cookie = JSON.parse(cookie1)
            this.browser.setCookie(...cookie)
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
            this.browser.setCookie(...cookies);
        }


        this.page = await this.browser.newPage()

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

        const homePageHtml = await this.page?.content()
        //flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/
        if (/flex h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-base font-bold text-gray-900/gs.test(homePageHtml)) {
            write_log('cookie过期，尝试重新登录')

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
                // await this.browser?.close()
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
        this.html = await get_html(`https://toomics.com/sc/webtoon/episode/toon/${this.mangaId}`, true)

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
        let errImgs = 0;
        if (!this.browser) return;
        const chapterPage = await this.browser?.newPage()
        // 储存图片到内存
        chapterPage.on('response', async (response) => {
            const url = response.url();
            if (response.request().resourceType() === 'image') {
                try {
                    const buffer = await response.buffer();
                    const filename = url.split('/').pop() || url;
                    this.chapterPageImages[filename] = buffer;
                } catch (e) { }
            }
        })

        // 开始下载章节
        console.log('正在下载章节:', chapterName)

        await chapterPage.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000
        }).catch(() => { })

        // 获取最新cookie
        await this.set_cookie()

        // 不断滚动 直到页面底部
        console.log('开始滚动页面,等待加载图片');
        let scrollY = -1;
        let window: any, document: any;
        await chapterPage.mouse.move(1000, 1000)
        while (1) {
            await chapterPage.mouse.wheel({ deltaY: this.scrollStep })
            await delay(this.scrollDelay)
            const nowScrollY = await chapterPage.evaluate(() => window.scrollY)
            if (nowScrollY === scrollY) break
            scrollY = nowScrollY
        }

        // 等待三秒之后开始下载
        await delay(3000)

        // 等待图片网络请求完成
        await chapterPage.waitForNetworkIdle().catch(() => { })

        // 获取所有图片的url
        const imageUrls = await chapterPage.evaluate(() => {
            const els = document.querySelectorAll('img[id^="set_image_"]')
            const urls = Array.from(els).map((el: any) => el.src)
            return urls;
        })

        for (let i = 0; i < imageUrls.length; i++) {
            const imageUrl = imageUrls[i]
            const picName = i.toString().padStart(5, '0')
            const localPath = `${downloadPath}/${picName}.jpg`
            const key = imageUrl.split('/').pop() || imageUrl

            if (this.chapterPageImages[key]) {
                fs.writeFileSync(localPath, this.chapterPageImages[key])
            } else {
                errImgs++
                console.error('图片下载失败:', imageUrl)
            }
        }

        this.chapterPageImages = {}
        chapterPage.close()

        write_log(`[chapter download]${chapterName} 下载完成,错误图片 ${errImgs} 张`)
        await delay(3000)

    }

    async set_cookie() {
        if (!this.browser) return;
        const cookies = await this.browser.cookies()
        fs.writeFileSync('toomics-cookies.json', JSON.stringify(cookies, null, 2));
        console.log('toomics-cookie更新成功', new Date().toLocaleString());
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
        this.browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',// 容器环境必备参数‌:ml-citation{ref="5,6" data="citationList"}
                '--disable-blink-features=AutomationControlled', // 隐藏自动化特征‌:ml-citation{ref="3" data="citationList"}
                '--disable-web-security',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--lang=zh-CN,zh', // 设置浏览器语言
                //'--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
                '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
            ],
            defaultViewport: {
                width: 1920,
                height: 1920,
            },
        });

        const cookie1 = fs.readFileSync('toomics-cookies.json', 'utf-8')
        const cookie = JSON.parse(cookie1)
        this.browser.setCookie(...cookie)
        this.page = await this.browser.newPage()
        await this.page?.goto('https://toomics.com', {
            waitUntil: 'networkidle2',
            timeout: 60 * 1000,
        })

        await delay(30 * 1000)

        const cookies = await this.browser.cookies();
        fs.writeFileSync('toomics-cookies.json', JSON.stringify(cookies, null, 2));
    }
}