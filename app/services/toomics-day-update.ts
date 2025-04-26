import { toomicsBrowser } from "#api/browser";
import { toomicsTask } from "#api/task";
export default class ToomicsDayUpdate {
    private url = 'https://toomics.com/sc/webtoon/ongoing_all'
    constructor() { }
    async start() {
        if (!toomicsBrowser.browser?.connected) {
            await toomicsBrowser.init()
        }

        if (!toomicsBrowser.browser) return;

        await toomicsBrowser.get_cookie();

        const page = await toomicsBrowser.new_page();
        if (!page) return

        await page.goto(this.url, { waitUntil: 'networkidle2', referer: 'https://toomics.com/sc/' }).catch(() => { })
        await page.waitForSelector('.list_wrap').catch(() => { });
        await toomicsBrowser.save_cookie();

        let document: any;
        const mangas = await page.evaluate(() => {
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

        mangas.forEach((manga: any) => {
            toomicsTask.add(manga) // 添加到任务队列
        })

        console.log('[toomics update]', mangas.length, '部漫画更新');

        page.close().catch(() => { })
    }
}