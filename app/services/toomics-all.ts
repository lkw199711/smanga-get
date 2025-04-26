
import useBrowser from '#api/browser';
import fs from 'fs';
import { end_app, delay, read_json } from '#utils/index';
export default class ToomicsAll {
    private buffs: any = {}
    private coverPath: string = 'data/toomics-covers'
    private jsonFile: string = 'data/toomics-all.json'
    private scrollStep: number = 400 // 滚动的步长
    private scrollDelay: number = 500 // 滚动的延迟时间
    private cookieFile: string = 'data/toomics-cookies.json'
    async start() {
        if (!useBrowser.browser?.connected) {
            await useBrowser.init()
        }

        if (!useBrowser.browser) return;

        if (fs.existsSync(this.cookieFile)) {
            const cookie1 = fs.readFileSync(this.cookieFile, 'utf-8')
            const cookie = JSON.parse(cookie1)
            useBrowser.browser.setCookie(...cookie)
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
            useBrowser.browser.setCookie(...cookies);
        }

        const page = await useBrowser.browser.newPage()

        // 储存图片到内存
        page.on('response', async (response) => {
            if (response.request().resourceType() === 'image') {
                const url = response.url();
                try {
                    const buffer = await response.buffer();
                    // const hash = crypto.createHash('md5').update(buffer).digest('hex');
                    this.buffs[url] = buffer;
                } catch (e) { }
            }
        })

        await page.goto('https://toomics.com/sc/webtoon/ranking', { waitUntil: 'networkidle2', referer: 'https://toomics.com/sc/' }).catch(() => { })
        await page.waitForSelector('.list_wrap').catch(() => { });
        this.set_cookie()
        // 不断滚动 直到页面底部
        console.log('开始滚动页面,等待加载图片');
        let scrollY = -1;
        let window: any, document: any;
        await page.mouse.move(1000, 1000)

        // 向下滚动到底部
        while (1) {
            let protocolError = false
            await page.mouse.wheel({ deltaY: this.scrollStep }).catch(() => { protocolError = true })
            await delay(this.scrollDelay)
            const nowScrollY = await page.evaluate(() => window.scrollY).catch(() => { protocolError = true })
            if (protocolError) continue

            if (nowScrollY === scrollY) break
            scrollY = nowScrollY
        }

        await page.waitForNetworkIdle().catch(() => { })
        await delay(2000)

        const mangas = await page.evaluate(() => {
            const lis = document.querySelectorAll('.list_wrap li')
            return Array.from(lis).map((li: any) => {
                const website = 'toomics'
                const name = li.querySelector('h4')?.innerText.trim()
                const url = 'https://toomics.com' + li.querySelector('a')?.getAttribute('href')
                const id = url.split('/').pop()
                const cover = li.querySelector('img')?.getAttribute('src')
                const describe = li.querySelector('.text')?.innerHTML
                let chapterCount = li.querySelector('.section_remai')?.innerText.trim()
                chapterCount = chapterCount.split('/')[1] || chapterCount.split('/')[0]
                return {
                    website,
                    name,
                    url,
                    id: Number(id),
                    cover,
                    covers: [cover],
                    describe,
                    chapterCount: Number(chapterCount),
                }
            })
        })

        let json: any = []
        if (fs.existsSync(this.jsonFile)) {
            json = read_json(this.jsonFile)
        }

        if (!fs.existsSync(this.coverPath)) {
            fs.mkdirSync(this.coverPath, { recursive: true })
        }

        mangas.forEach((manga: any) => {
            const mangaIndex = json.findIndex((old: any) => Number(old.id) === Number(manga.id))
            if (mangaIndex === -1) {
                json.push(manga)
            } else {
                let covers = json[mangaIndex]?.covers || []
                if (!covers.includes(manga.cover)) {
                    covers.push(manga.cover)
                }
                manga.covers = covers
                json[mangaIndex] = manga
            }

        })

        fs.writeFileSync(this.jsonFile, JSON.stringify(json, null, 2))

        for (const manga of mangas) {
            const coverFile = manga.cover.split('/').pop()
            const coverPath = `${this.coverPath}/${manga.id}-${coverFile}`
            if (fs.existsSync(coverPath)) {
                continue
            }

            if (this.buffs[manga.cover]) {
                fs.writeFileSync(coverPath, this.buffs[manga.cover])
            } else {
                console.error('没有找到图片', manga.cover)
            }
        }
        // toomics-covers
    }

    async set_cookie() {
        if (!useBrowser.browser) return;
        const cookies = await useBrowser.browser.cookies()
        fs.writeFileSync(this.cookieFile, JSON.stringify(cookies, null, 2));
        console.log('toomics-cookie更新成功', new Date().toLocaleString());
        end_app()
    }
}