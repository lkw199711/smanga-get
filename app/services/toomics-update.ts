import { toomicsBrowser } from "#api/browser";
import { toomicsTask } from "#api/task";
import { write_log, get_config, delay } from "#utils/index";
export default class ToomicsDayUpdate {
    private langTag; // 语言标签
    private url = 'https://toomics.com/sc/webtoon/ongoing_all'
    private updateOnlyDay: boolean;
    watting: boolean = false
    constructor(langTag?: string) {
        this.langTag = langTag || 'sc'; // 默认为简体中文
        this.url = `https://toomics.com/${langTag}/webtoon/ongoing_all`
        const config = get_config()?.toomics || {}
        this.watting = get_config()?.watting;
        this.updateOnlyDay = config?.updateOnlyDay;
    }
    async start() {
        write_log('[toomics update] 开始扫描漫画更新')
        if (!toomicsBrowser.browser?.connected) {
            await toomicsBrowser.init()
        }

        if (!toomicsBrowser.browser) return;

        await toomicsBrowser.get_cookie();

        const page = await toomicsBrowser.new_page();
        if (!page) return

        await page.goto(this.url, { waitUntil: 'networkidle2', referer: `https://toomics.com/${this.langTag}/` }).catch(() => { })
        await page.waitForSelector('.list_wrap').catch(() => { });
        await toomicsBrowser.save_cookie();

        while (this.watting) {
            delay(3000)
            await toomicsBrowser.save_cookie();
        }

        let document: any, mangas: any;
        if (this.updateOnlyDay) {
            mangas = await page.evaluate(() => {
                function get_days() {
                    const alldays = document.querySelectorAll('.allday')
                    const weekday = new Date().getDay();
                    const todayIndex = (weekday - 1 + 7) % 7
                    const yesterdayIndex = (weekday - 2 + 7) % 7

                    const todays = alldays[todayIndex].querySelectorAll('li')
                    const yesterday = alldays[yesterdayIndex].querySelectorAll('li')


                    const lis = Array.from(todays).concat(Array.from(yesterday))
                    return lis.map((li: any) => {
                        const website = 'toomics'
                        const name = li.querySelector('h4')?.innerText.trim()
                        const urlTxt = 'https://toomics.com' + li.querySelector('a')?.getAttribute('onclick')
                        // @ts-ignore
                        const url = 'https://toomics.com' + urlTxt.match(/(?<=\').+?(?=\')/)[0]
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

                return get_days()
            })
        } else {
            mangas = await page.evaluate(() => {
                const lis = Array.from(document.querySelectorAll('.list_wrap li'))
                return lis.map((li: any) => {
                    const website = 'toomics'
                    const name = li.querySelector('h4')?.innerText.trim()
                    const urlTxt = 'https://toomics.com' + li.querySelector('a')?.getAttribute('onclick')
                    // @ts-ignore
                    const url = 'https://toomics.com' + urlTxt.match(/(?<=\').+?(?=\')/)[0]
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
            })
        }


        mangas.forEach((manga: any) => {
            toomicsTask.add(manga) // 添加到任务队列
        })

        write_log(`[toomics update], ${mangas.length} 部漫画更新`);

        page.close().catch(() => { })
    }
}