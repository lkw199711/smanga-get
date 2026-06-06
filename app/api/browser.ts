import puppeteer from "rebrowser-puppeteer";
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
    return map[contentType as keyof typeof map] || '.bin';
}

type configType = {
    cookieFile: string
    cookieFileNoUser: string
}

function readCookieFile(cookieFile: string) {
    const cookieText = fs.readFileSync(cookieFile, 'utf-8').trim()
    if (!cookieText) return []

    const cookies = JSON.parse(cookieText)
    return Array.isArray(cookies) ? cookies : []
}

function parseCookieString(cookieStr: string, domain: string) {
    if (!cookieStr.trim()) return []

    return cookieStr.split(';').map(pair => {
        const [name, value] = pair.trim().split('=');
        if (!name) return null

        return {
            name,
            value: value || '',
            domain,
            path: '/',
            secure: false,
            sameParty: false,
            httpOnly: false
        };
    }).filter(Boolean)
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

    /**
     * 获取代理启动参数
     */
    private get proxyArgs(): string[] {
        const proxy = this.config.proxy
        if (proxy?.enable && proxy.server) {
            return [`--proxy-server=${proxy.server}`]
        }
        return []
    }

    /**
     * 设置页面代理认证
     */
    protected async setProxyAuth(page: puppeteer.Page) {
        const proxy = this.config.proxy
        if (proxy?.enable && proxy.username) {
            await page.authenticate({ username: proxy.username, password: proxy.password || '' })
        }
    }

    async init(options: { headless?: boolean } = {}) {
        const headless = options.headless ?? this.config.headless
        const executablePath = this.config.executablePath
            || process.env.PUPPETEER_EXECUTABLE_PATH
            || puppeteer.executablePath()
        this.browser = await puppeteer.launch({
            headless,
            executablePath,
            timeout: 60 * 1000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--lang=zh-CN,zh',
                ...this.proxyArgs,
            ],
            defaultViewport: {
                width: 1920,
                height: 1440,
            },
        })
    }

    async get_cookie() {
        if (!this.browser) return;
        let cookies: any[] = []
        if (fs.existsSync(this.cookieFile)) {
            cookies = readCookieFile(this.cookieFile)
        } else {
            const cookieStr = process.env.TOOMICS_COOKIE || '';
            cookies = parseCookieString(cookieStr, '.toomics.com')
        }

        if (cookies.length) {
            await this.browser.setCookie(...cookies);
        }
    }

    async save_cookie(runEndApp = true) {
        if (!this.browser) return;
        const cookies = await this.browser.cookies().catch(() => null);
        if (!cookies) {
            write_log('[cookie]获取cookie失败')
            this.browser?.close()
            throw new Error('获取cookie失败')
        };
        fs.writeFileSync(this.cookieFile, JSON.stringify(cookies, null, 2));
        console.log('cookie更新成功', new Date().toLocaleString());
        if (runEndApp) end_app()
    }

    async start_manual_auth(url: string) {
        if (this.browser && (this.browser as any).connected) {
            throw new Error(`${this.website} 手动认证浏览器已打开`)
        }

        await this.init({ headless: false })
        await this.get_cookie()
        const page = await this.new_page()
        if (!page) throw new Error('打开手动认证页面失败')
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60 * 1000,
        }).catch((error) => {
            write_log(`[manual auth] ${this.website} 打开页面失败: ${error.message}`)
        })
    }

    async finish_manual_auth() {
        if (!this.browser || !(this.browser as any).connected) {
            throw new Error(`${this.website} 手动认证浏览器未打开`)
        }

        await this.save_cookie(false)
        await this.browser.close()
        this.browser = null
    }

    async new_page() {
        if (!this.browser) return null;
        const page = await this.browser.newPage()
        let navigator: any;

        // 代理认证
        await this.setProxyAuth(page);

        /**
         * 以下三段为浏览仿真
         */
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA-Platform': '"Windows"', // 新版指纹头‌:ml-citation{ref="3" data="citationList"}
            'Upgrade-Insecure-Requests': '1'
        });

        // 消除navigator.webdriver属性（rebrowser 已处理，这里设为 false 更安全）
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        // 覆盖plugins属性，模拟真实 Chrome 插件
        await page.evaluateOnNewDocument(() => {
            const makePlugin = (name: string) => ({
                name,
                filename: `${name.toLowerCase().replace(/\s+/g, '_')}.dll`,
                description: `${name}`,
                length: 1,
                0: { type: 'application/x-google-chrome-plugin' },
                item: () => null,
                namedItem: () => null,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const plugins = [
                        makePlugin('Chrome PDF Plugin'),
                        makePlugin('Chrome PDF Viewer'),
                        makePlugin('Native Client'),
                    ] as any;
                    plugins.item = (i: number) => plugins[i] || null;
                    plugins.namedItem = (name: string) => plugins.find((p: any) => p.name === name) || null;
                    plugins.refresh = () => {};
                    return plugins;
                }
            });
        });

        // 修复 chrome.runtime
        await page.evaluateOnNewDocument(() => {
            const win = globalThis as any;
            if (!win.chrome) {
                Object.defineProperty(globalThis, 'chrome', {
                    get: () => ({ runtime: {} }),
                });
            }
        });

        // 修复 headless 模式下 window.outerWidth/outerHeight 可能为 0 的问题
        await page.evaluateOnNewDocument(() => {
            const win = globalThis as any;
            Object.defineProperty(globalThis, 'outerWidth', {
                get: () => win.innerWidth,
            });
            Object.defineProperty(globalThis, 'outerHeight', {
                get: () => win.innerHeight + 100,
            });
        });

        // 拦截广告和追踪请求，防止广告导致 networkidle2 超时
        const AD_DOMAINS = [
            'magsrv.com', 'pubadx.one', 'bkcdn.net', 'exoclick.com',
            'wpncdn.com', 'juicyads.com', 'trafficjunky.com',
            'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
            'googleadservices.com', 'google-analytics.com',
        ];
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const url = request.url();
            if ((resourceType === 'script' || resourceType === 'ping') &&
                AD_DOMAINS.some(domain => url.includes(domain))) {
                request.abort().catch(() => {});
            } else {
                request.continue().catch(() => {});
            }
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
    private CACHE_ROOT: string = '';
    constructor() {
        super({ nouser: false, website: 'toomics' });
        this.CACHE_ROOT = this.config.coverCache || this.config.cacheRoot || '';
    }

    async new_page() {
        if (!this.browser) return null;
        const page = await this.browser.newPage()
        let navigator: any;

        // 代理认证
        await this.setProxyAuth(page);

        /**
         * 以下三段为浏览仿真
         */
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-CH-UA-Platform': '"Windows"', // 新版指纹头‌:ml-citation{ref="3" data="citationList"}
            'Upgrade-Insecure-Requests': '1'
        });

        // 消除navigator.webdriver属性（rebrowser 已处理，这里设为 false 更安全）
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false
            });
        });

        // 覆盖plugins属性，模拟真实 Chrome 插件
        await page.evaluateOnNewDocument(() => {
            const makePlugin = (name: string) => ({
                name,
                filename: `${name.toLowerCase().replace(/\s+/g, '_')}.dll`,
                description: `${name}`,
                length: 1,
                0: { type: 'application/x-google-chrome-plugin' },
                item: () => null,
                namedItem: () => null,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const plugins = [
                        makePlugin('Chrome PDF Plugin'),
                        makePlugin('Chrome PDF Viewer'),
                        makePlugin('Native Client'),
                    ] as any;
                    plugins.item = (i: number) => plugins[i] || null;
                    plugins.namedItem = (name: string) => plugins.find((p: any) => p.name === name) || null;
                    plugins.refresh = () => {};
                    return plugins;
                }
            });
        });

        // 修复 chrome.runtime
        await page.evaluateOnNewDocument(() => {
            const win = globalThis as any;
            if (!win.chrome) {
                Object.defineProperty(globalThis, 'chrome', {
                    get: () => ({ runtime: {} }),
                });
            }
        });

        // 修复 headless 模式下 window.outerWidth/outerHeight 可能为 0 的问题
        await page.evaluateOnNewDocument(() => {
            const win = globalThis as any;
            Object.defineProperty(globalThis, 'outerWidth', {
                get: () => win.innerWidth,
            });
            Object.defineProperty(globalThis, 'outerHeight', {
                get: () => win.innerHeight + 100,
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
const gentlemanBrowser = new UseBrowser({ website: 'gentleman' });

export { UseBrowser, toomicsBrowser, bilibiliBrowser, toomicsBrowserNoUser, omegascansBrowser, gentlemanBrowser };
