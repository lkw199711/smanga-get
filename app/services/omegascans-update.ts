
import { end_app, read_json, write_log, delay, make_can_be_floder, get_config } from "#utils/index";
import { omegascansBrowser } from "#api/browser";
import { omegascansTask } from "#api/task";
import fs, { writeFileSync } from "fs";

export default class OmegaScansUpdate {
    page: any; // Puppeteer 页面对象
    downloadPath: string; // 下载路径
    constructor(params: any) {
        const config = get_config()?.omegascans || {}
        this.id = params.id || 0;
        this.name = params.name || "OmegaScans";
        this.name = make_can_be_floder(this.name);
        this.params = params
        this.downloadPath = config.downloadPath + '/omegascans'
    }

    async start() {
        if (!omegascansBrowser.browser) {
            await omegascansBrowser.init();
        }
        if (!omegascansBrowser.browser) return;
        this.page = await omegascansBrowser.browser.newPage();

        const res = await this.request_interface(`https://api.omegascans.org/query?series_type=Comic&perPage=9999&adult=true&order=desc&orderBy=latest&page=1`);
        const mangaList = res.data || [];

        if (mangaList && mangaList.length > 0) {
            writeFileSync('data/omegascans.json', JSON.stringify(mangaList, null, 2), 'utf-8');
        } else {
            write_log('[manga update]漫画列表获取失败');
            return;
        }
        // console.log(res.data);
        // process.exit();
        mangaList.filter((manga: any) => {
            if (manga.status === 'Dropped') return false; // 跳过已放弃的漫画

            const mangaName = make_can_be_floder(manga.title);
            const mangaFolder = `${this.downloadPath}/${mangaName}`;
            const metaFolder = `${this.downloadPath}/${mangaName}-smanga-info`;
            const metaFile = `${metaFolder}/meta.json`;

            if (fs.existsSync(metaFile)) {
                const oldMeta = read_json(metaFile) || {};
                if (oldMeta?.status === 'Completed' && manga.status === 'Completed') return;
            }

            return true;
        }).forEach((manga: any) => {
            const params = {
                id: manga.id,
                name: manga.title,
                url: `https://omegascans.org/comics/${manga.series_slug}`,
                series_slug: manga.series_slug,
                status: manga.status,
                website: 'omegascans',
            }
            // console.log(params)
            omegascansTask.add(params)
        })
    }

    async page_open() {
        if (!omegascansBrowser.browser) return;
        if (this.page.isClosed()) {
            this.page = await omegascansBrowser.browser.newPage();
        }
    }

    async request_interface(url: string) {
        await this.page_open(); // 确保页面已打开
        await this.page.goto(url, {
            waitUntil: 'domcontentloaded',
        }).catch((error: any) => {
            write_log(`[manga update]漫画列表获取失败`);
            throw error; // 重新抛出错误以便上层处理
        })
        await omegascansBrowser.save_cookie();
        const chaptersResponse = await this.page.content();
        await this.page.close(); // 关闭页面
        const chapterTxt = chaptersResponse.match(/\{.*\}/s)?.[0];
        return JSON.parse(chapterTxt);
    }
}
