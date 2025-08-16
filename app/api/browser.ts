import puppeteer from "puppeteer";
import fs from "fs";
import { end_app, get_config, write_log } from "#utils/index";
import crypto from "crypto";
import path from "path";

// 创建安全目录名
function createSafeDirname(url: string): string {
    return crypto.createHash('md5').update(url).digest('hex');
}

// 获取图片扩展名
function getImageExtension(contentType: string) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
        'image/tiff': '.tiff',
        'image/x-icon': '.ico',
        'image/vnd.microsoft.icon': '.ico',
        'image': '.bin', // 默认处理未知类型为二进制文件
    };
    return map[contentType] || '.bin';
}

type configType = {
    cookieFile: string
    cookieFileNoUser: string
}

const defaultParams = {
    nouser: false,
    website: 'toomics'
}

class UseBrowser {
    public browser: puppeteer.Browser | null = null;
    public buffs: any = {}
    private cookieFile: string = ''
    config: any
    private websiteConfig: configType
    website: string = ''
    constructor({ nouser, website }: any = defaultParams) {
        this.config = get_config()
        this.websiteConfig = this.config[website]
        this.website = website;

        if (nouser) {
            this.cookieFile = this.websiteConfig.cookieFileNoUser || 'data/cookies.json'
        } else {
            this.cookieFile = this.websiteConfig.cookieFile || 'data/cookies.json'
        }
    }

    async init() {
        this.browser = await puppeteer.launch({
            headless: this.config.headless,
            timeout: 60 * 1000,
            args: ['--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',// 容器环境必备参数‌:ml-citation{ref="5,6" data="citationList"}
                '--disable-blink-features=AutomationControlled', // 隐藏自动化特征‌:ml-citation{ref="3" data="citationList"}
                '--disable-web-security',
                '--disable-gpu',
                // '--single-process',
                '--disable-software-rasterizer',
                '--lang=zh-CN,zh', // 设置浏览器语言
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
            ],
            defaultViewport: {
                width: 1920,
                height: 1440,
            },
        })
    }

    async get_cookie() {
        if (!this.browser) return;
        if (fs.existsSync(this.cookieFile)) {
            const cookie1 = fs.readFileSync(this.cookieFile, 'utf-8')
            const cookie = JSON.parse(cookie1)
            await this.browser.setCookie(...cookie)
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
            await this.browser.setCookie(...cookies);
        }
    }

    async save_cookie() {
        if (!this.browser) return;
        const cookies = await this.browser.cookies().catch(() => null);
        if (!cookies) {
            write_log('[cookie]获取cookie失败')
            this.browser?.close()
            throw new Error('获取cookie失败')
        };
        fs.writeFileSync(this.cookieFile, JSON.stringify(cookies, null, 2));
        console.log('cookie更新成功', new Date().toLocaleString());
        end_app()
    }

    async new_page() {
        if (!this.browser) return null;
        const page = await this.browser.newPage()
        let navigator: any;

        /**
         * 以下三段为浏览仿真
         */
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA-Platform': '"Windows"', // 新版指纹头‌:ml-citation{ref="3" data="citationList"}
            'Upgrade-Insecure-Requests': '1'
        });

        // 消除navigator.webdriver属性‌:ml-citation{ref="3" data="citationList"}
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        });

        // 覆盖plugins属性
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3] // 返回非空数组
            });
        });

        /**
         * * 监听图片加载事件，保存图片到内存
         * * 这里的图片是指漫画封面图，可能会有其他图片也会被保存
         */
        page.on('response', async (response) => {
            // if (response.request().resourceType() === 'image')
            const contentType = response.headers()['content-type'];
            // console.log(contentType, response.url());
            if (/image/i.test(contentType)) {
                const url = response.url();
                try {
                    const buffer = await response.buffer();
                    this.buffs[url] = buffer;
                } catch (e) {
                }
            }
        })
        return page
    }

    clear_buffs() {
        this.buffs = {}
    }
}


class UseToomicsBrowser extends UseBrowser {
    private CACHE_ROOT: string = 'M:\\manga\\toomics-cache';
    constructor() {
        super({ nouser: false, website: 'toomics' });
        this.CACHE_ROOT = this.config.coverCache || this.CACHE_ROOT;
    }

    async new_page() {
        if (!this.browser) return null;
        const page = await this.browser.newPage()
        let navigator: any;

        /**
         * 以下三段为浏览仿真
         */
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA-Platform': '"Windows"', // 新版指纹头‌:ml-citation{ref="3" data="citationList"}
            'Upgrade-Insecure-Requests': '1'
        });

        // 消除navigator.webdriver属性‌:ml-citation{ref="3" data="citationList"}
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });
        });

        // 覆盖plugins属性
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3] // 返回非空数组
            });
        });

        await page.setRequestInterception(true);

        /**
         * * 监听请求，处理图片缓存
         * * 这里的图片是指漫画封面图，可能会有其他图片
         */
        page.on('request', async (request) => {
            const contentType = request.resourceType();
            if (contentType === 'image') {
                const currentUrl = page.url();
                const imageUrl = request.url();

                // 创建基于当前页面URL的缓存目录
                const dirName = createSafeDirname(currentUrl);
                let cacheDir = path.join(this.CACHE_ROOT, dirName);

                if (currentUrl.includes('/detail/')) {
                    // 详情页，使用单独的缓存目录
                    cacheDir = this.CACHE_ROOT + '-chapter';
                }

                // 创建图片缓存文件名
                const imageKey = createSafeDirname(imageUrl);
                const ext = imageUrl.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg|tiff|ico)$/i)?.[0] || '.bin'; // 获取图片扩展名
                const cachePath = path.join(cacheDir, `${imageKey}${ext}`);

                // 检查缓存是否存在
                if (fs.existsSync(cachePath)) {
                    // console.log(`[Cache Hit] ${cachePath}`, contentType, ext);
                    const buffer = fs.readFileSync(cachePath);
                    request.respond({
                        status: 200,
                        contentType,
                        body: buffer
                    });
                } else {
                    // console.log(`[Cache Miss] ${cachePath}`, contentType, ext);
                    request.continue();
                }
            } else {
                request.continue();
            }
        });

        /**
         * * 监听图片加载事件，保存图片到内存
         * * 这里的图片是指漫画封面图，可能会有其他图片也会被保存
         */
        page.on('response', async (response) => {
            const contentType = response.headers()['content-type'];
            if (/image/i.test(contentType)) {
                // console.log(`[Image Response] ${response.url()}`, contentType);

                const url = response.url();
                try {
                    const currentUrl = await page.url();
                    const imageUrl = response.url();
                    const buffer = await response.buffer();

                    // 创建缓存目录结构
                    const dirName = createSafeDirname(currentUrl);
                    let cacheDir = path.join(this.CACHE_ROOT, dirName);
                    if (currentUrl.includes('/detail/')) {
                        // 详情页，使用单独的缓存目录
                        cacheDir = this.CACHE_ROOT + '-chapter';
                    }
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }

                    // 保存图片到缓存
                    const imageKey = createSafeDirname(imageUrl);
                    const ext = getImageExtension(contentType);
                    const cachePath = path.join(cacheDir, `${imageKey}${ext}`);
                    fs.writeFileSync(cachePath, buffer);
                    this.buffs[url] = buffer;
                } catch (err) {
                    console.error('Failed to cache image:', err);
                }
            }
        })
        return page
    }
}
const toomicsBrowser = new UseToomicsBrowser();
const bilibiliBrowser = new UseBrowser({ website: 'bilibili' });
const toomicsBrowserNoUser = new UseBrowser({ nouser: true, website: 'toomics' })
const omegascansBrowser = new UseBrowser({ website: 'omegascans' });

export { toomicsBrowser, bilibiliBrowser, toomicsBrowserNoUser, omegascansBrowser };