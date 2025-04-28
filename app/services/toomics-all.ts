
import { toomicsBrowser } from '#api/browser';
import fs from 'fs';
import { delay, get_config, get_os, read_json } from '#utils/index';

const linuxStr = get_os() === 'Linux' ? '/' : '';
export default class ToomicsAll {
    private coverPath: string = linuxStr + 'data/toomics-covers'
    private jsonFile: string = linuxStr + 'data/toomics-all.json'
    private scrollStep: number = 400 // 滚动的步长
    private scrollDelay: number = 500 // 滚动的延迟时间
    constructor() {
        const config = get_config().toomics;
        this.coverPath = config.coverCache;
    }
    async start() {
        console.log('[toomics all] 开始扫描所有漫画')
        if (!toomicsBrowser.browser?.connected) {
            await toomicsBrowser.init('toomics')
        }

        if (!toomicsBrowser.browser) return;

        await toomicsBrowser.get_cookie();

        const page = await toomicsBrowser.new_page();
        if (!page) return

        await page.goto('https://toomics.com/sc/webtoon/ranking', { waitUntil: 'networkidle2', referer: 'https://toomics.com/sc/' }).catch(() => { })
        await page.waitForSelector('.list_wrap').catch(() => { });
        await toomicsBrowser.save_cookie()
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
            function get_end() {
                const lis = document.querySelectorAll('.list_wrap li')
                return Array.from(lis).map((li: any) => {
                    const website = 'toomics'
                    const name = li.querySelector('h4')?.innerText.trim()
                    const url = 'https://toomics.com' + li.querySelector('a')?.getAttribute('href')
                    const id = url.split('/').pop()
                    const cover = li.querySelector('img')?.getAttribute('src')
                    const describe = li.querySelector('.text')?.innerHTML
                    const audlt = /18\+/.test(li.innerHTML)
                    const finsihed = /End/.test(li.innerHTML)
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
                        audlt,
                        finsihed,
                    }
                })
            }

            return get_end()
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

            if (toomicsBrowser.buffs[manga.cover]) {
                fs.writeFileSync(coverPath, toomicsBrowser.buffs[manga.cover])
            } else {
                console.error('没有找到图片', manga.cover)
            }
        }

        console.log('[toomics all] 扫描完成');
        toomicsBrowser.clear_buffs();
        page.close().catch(() => { })
    }
}