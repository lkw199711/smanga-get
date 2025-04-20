import * as fs from 'fs'
import { downloadImage } from '#api/bilibili'
import { subsribeType } from '#type/index.js'
import { delay, saveBase64Image, write_log } from '#utils/index'
import puppeteer from 'puppeteer'
import path from 'path'
import { subscribe_remove } from '#api/subsribe'

type chapterType = {
    targetId: number
    title: string
    ord: number
    payMode: boolean
    payGold: number
    isLocked: boolean
    isFree: boolean
    cover: string
    publishDate: string
    size: number
    count: number
}

export default class Bilibili {
    private domain = 'https://manga.bilibili.com'
    private website: string
    private mangaId: number
    private mangaName: string
    private downloadPath: string
    private downloadLockedMeta: boolean
    private useMoblie: boolean = false
    public browser: puppeteer.Browser | null = null
    private page: puppeteer.Page | null = null
    private chapterPage: puppeteer.Page | null = null
    private meta: any = null
    private metaUpdate: boolean = false
    private chapters: any = null
    constructor(params: subsribeType) {
        this.website = params.website
        this.mangaId = params.id
        this.mangaName = params.name
        this.downloadLockedMeta = false
        if (process.env.DOWNLOAD_PATH) {
            this.downloadPath = path.join(process.env.DOWNLOAD_PATH, this.website);
        } else {
            this.downloadPath = path.join(process.cwd(), this.website);
        }
    }

    /**
     * @description: 开始下载
     */
    async start() {
        await this.init()

        console.log(this.mangaName + ' 正在分析')

        if (!this.browser) return
        if (!this.page) return
        // 解析章节

        //https://manga.bilibili.com/detail/mc31006?from=manga_search
        await this.page.goto(`${this.domain}/detail/mc${this.mangaId}`, { waitUntil: 'networkidle2', timeout: 60 * 1000 }).catch(() => { })

        // 等待获取元数据或timeout

        // 漫画名删除特殊字符
        const mangaName = this.meta.title.replaceAll(/[<>:"/\\|?*]/g, '')
        // 创建元数据文件夹
        const metaFolder = `${this.downloadPath}/${mangaName}-smanga-info`
        if (!fs.existsSync(metaFolder)) await fs.promises.mkdir(metaFolder, { recursive: true })
        const metaFile = `${metaFolder}/meta.json`
        if (fs.existsSync(metaFile)) {
            const rawData = fs.readFileSync(metaFile, 'utf-8')
            const oldMetaData = JSON.parse(rawData)

            const oldChapterLength = oldMetaData.chapters.filter((item: any) => !item.isLocked).length
            const newChapterLength = this.chapters.filter((item: any) => !item.isLocked).length

            // 漫画已完结 并全部购买
            if (this.meta.finished === true && newChapterLength === this.chapters.length) {
                // 移除订阅链接
                subscribe_remove({ website: this.website, id: this.mangaId })
                console.log(this.mangaName + ' 已完结，已移除订阅链接')
            }

            // 检查封面是否更新
            if (this.meta.verticalCover !== oldMetaData.verticalCover) {

                let newNum = 0;
                while (oldMetaData['verticalCover' + newNum]) {
                    newNum++;
                }

                // 将就封面存为新建序号
                this.meta['verticalCover' + newNum] = oldMetaData.verticalCover
                fs.renameSync(`${metaFolder}/cover.jpg`, `${metaFolder}/cover${newNum}.jpg`)
                this.metaUpdate = true
            }

            // 章节更新
            if (oldChapterLength !== newChapterLength) {
                this.metaUpdate = true
            }

            if (this.metaUpdate) {
                await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))
            } else {
                console.log(this.mangaName + ' 没有更新')
            }
        } else {
            // 写入元数据
            await fs.writeFileSync(metaFile, JSON.stringify(this.meta, null, 2))

            // 下载banner图
            const banners = this.meta.banners
            for (let i = 0; i < banners.length; i++) {
                const banner = banners[i]
                const localPath = `${metaFolder}/banner${i.toString().padStart(2, '0')}.jpg`
                await downloadImage(banner, localPath)
            }

            // 封面图
            await downloadImage(this.meta.horizontalCover, `${metaFolder}/horizontalCover.jpg`)
            await downloadImage(this.meta.squareCover, `${metaFolder}/squareCover.jpg`)
            await downloadImage(this.meta.verticalCover, `${metaFolder}/verticalCover.jpg`)
            await downloadImage(this.meta.verticalCover, `${metaFolder}/cover.jpg`)
        }

        // 下载章节
        for (let i = 0; i < this.chapters.length; i++) {
            const chapter = this.chapters[i]
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
            
            // 下载封面
            if (!fs.existsSync(`${chapterFolder}.jpg`)) {
                await downloadImage(chapter.cover, `${chapterFolder}.jpg`)
            }
            await this.download_chapter(chapter, chapterFolder)
        }

        this.chapterPage?.close()
        this.page.close()

        console.log(mangaName + ' 订阅完毕')
    }

    async init() {
        this.browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',// 容器环境必备参数‌:ml-citation{ref="5,6" data="citationList"}
                '--disable-blink-features=AutomationControlled', // 隐藏自动化特征‌:ml-citation{ref="3" data="citationList"}
                '--disable-web-security',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--lang=zh-CN,zh', // 设置浏览器语言
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
            ],
            defaultViewport: {
                width: 1080,
                height: 1920,
            },
        });

        if (fs.existsSync('bilibili_cookie.json')) {
            const cookies = JSON.parse(fs.readFileSync('bilibili_cookie.json', 'utf-8'));
            await this.browser.setCookie(...cookies);
        } else {
            // 示例：将字符串 "session=abc; user=123" 转为 Puppeteer 所需格式
            const cookieStr = process.env.BILIBILI_COOKIE || '';
            const cookies = cookieStr.split(';').map(pair => {
                const [name, value] = pair.trim().split('=');
                return {
                    name: name,
                    value: value,
                    domain: '.bilibili.com', // 替换为目标网站主域名
                    path: '/',
                    secure: false,
                    sameParty: false,
                    httpOnly: false
                };
            });
            this.browser.setCookie(...cookies);
        }

        await this.set_cookie()

        // 初始化漫画页
        this.page = await this.browser.newPage()
        this.page.on('response', async response => {
            if (/ComicDetail/.test(response.url())) {
                const ComicDetailResponse = await response.json()
                // 获取章节列表与漫画元数据
                this.get_meta(ComicDetailResponse)
            }
        });

        // 初始化章节页
        let navigator: any;
        this.chapterPage = await this.browser.newPage()
        await this.chapterPage.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA-Platform': '"Windows"', // 新版指纹头‌:ml-citation{ref="3" data="citationList"}
            'Upgrade-Insecure-Requests': '1'
        });

        // 消除navigator.webdriver属性‌:ml-citation{ref="3" data="citationList"}
        await this.chapterPage.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        });

        // 覆盖plugins属性
        await this.chapterPage.evaluate(() => {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3] // 返回非空数组
            });
        });
    }

    /**
     * 下载章节
     * @param chapterId
     * @param downloadPath
     */
    async download_chapter(chapter: chapterType, downloadPath: string) {
        console.log(`${this.meta.title} 正在下载章节 ${this.get_order(chapter.ord)} ${chapter.title}`)
        //'https://manga.bilibili.com/mc31006/693731?from=manga_detail'
        if (!this.browser) return
        if (!this.chapterPage) return

        let document: any;

        const url = `${this.domain}/mc${this.mangaId}/${chapter.targetId}?from=manga_detail`

        await this.chapterPage.goto(url, { waitUntil: 'networkidle2' }).catch(() => { })

        await this.set_cookie();

        await this.chapterPage.setViewport({ width: 1080, height: 1440 })

        await this.chapterPage.locator('.image-loaded').wait()

        await this.chapterPage.mouse.move(1100, 2200)

        await delay(1000)

        let scrollTop = -1;
        const scrollStep = 1200; // 滚动步长
        const scrollDelay = 500; // 滚动延迟（毫秒）

        //.ps--active-y
        // 不断滚动 直到页面底部
        console.log('开始滚动页面,等待加载图片');
        const ps = await this.chapterPage.$('.ps--active-y');
        if (!ps) {
            write_log(`[chapter download] ${this.meta.title} ${chapter.title} 滚动失败`)
            return
        }

        while (1) {
            const scrollFloat = Math.floor(Math.random() * 201) - 100 // 随机滚动范围
            await this.chapterPage.locator('.ps--active-y').scroll({
                scrollTop: scrollTop + scrollStep + scrollFloat,
            }).catch(() => { scrollTop -= 100 })

            // 获取当前滚动位置
            const newScrollTop = await this.chapterPage.evaluate((el: any) => el.scrollTop, ps)

            if (newScrollTop === scrollTop) break

            scrollTop = newScrollTop
            const delayFloat = Math.floor(Math.random() * 101) - 50 // 随机延迟范围
            await delay(scrollDelay + delayFloat)
        }

        await delay(1000)

        // 获取所有 canvas 元素
        const allCanvasElements = await this.chapterPage.$$('.image-item canvas');
        let canvasElements = await this.chapterPage.$$('.image-loaded canvas');

        // 20秒等待canvas全部加载
        for (let i = 0; i < 10; i++) {
            if (canvasElements.length === allCanvasElements.length) break
            await delay(2000)
        }

        if (canvasElements.length !== allCanvasElements.length || canvasElements.length === 0) {
            write_log(`[chapter download] ${this.meta.title} ${chapter.title} 下载失败,请手动下载`)
            return
        }

        /*
                // 截取屏幕截图并保存到指定路径
                const screenshotPath = path.join(downloadPath, 'baidu_homepage.png'); // 保存到当前目录
                await chapterPage.screenshot({ path: screenshotPath });
        */
        for (let i = 0; i < canvasElements.length; i++) {
            const canvasElement = canvasElements[i];

            // 获取 PNG 格式的数据 URL
            const canvasDataURL = await this.chapterPage.evaluate(canvas => {
                var iframe2 = document.createElement('iframe');
                document.body.appendChild(iframe2);
                return iframe2.contentWindow.HTMLCanvasElement.prototype.toDataURL.call(canvas);
            }, canvasElement);

            const picName = i.toString().padStart(5, '0') + '.jpg'

            // 定义图片保存路径
            const imagePath = path.join(downloadPath, picName);

            // 保存图片
            saveBase64Image(canvasDataURL, imagePath);
        }

        write_log(`[chapter download] ${this.meta.title} ${chapter.title} 下载完成`)
    }

    async set_cookie() {
        if (!this.browser) return;
        const cookies = await this.browser.cookies()
        fs.writeFileSync('bilibili-cookies.json', JSON.stringify(cookies, null, 2));
        console.log('bilibili-cookie更新成功', new Date().toLocaleString());
    }

    get_order(ord: number) {
        const arr = ord.toString().split('.')

        if (arr.length > 1) return arr[0].padStart(5, '0') + '.' + arr[1]

        return ord.toString().padStart(5, '0')
    }

    get_meta(ComicDetailResponse: any) {
        if (ComicDetailResponse.code !== 0) return null
        const data = ComicDetailResponse.data

        this.chapters = data.ep_list.map((item: any) => {
            return {
                targetId: item.id,
                title: item.title,
                ord: item.ord,
                payMode: item.pay_mode === 1,
                payGold: item.gold,
                isLocked: item.is_locked,
                isFree: item.is_in_free,
                cover: item.cover,
                publishDate: item.pub_time,
                size: item.size,
                count: item.image_count,
            }
        })

        this.meta = {
            targetId: data.id,
            title: data.title,
            horizontalCover: data.horizontal_cover,
            squareCover: data.square_cover,
            verticalCover: data.vertical_cover,
            author: data.author_name.join(','),
            classify: data.styles.join(','),
            laster: data.last_ord,
            finished: data.is_finish === 1,
            describe: data.evaluate,
            count: data.total,
            tags: data.tags,
            publishDate: data.release_time,
            updateDate: data.renewal_time,
            payMode: data.pay_mode === 1,
            banners: data.horizontal_covers,
            chapters: this.chapters,
        }
    }
}