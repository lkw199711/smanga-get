import { end_app, read_json, write_log, delay, make_can_be_floder, get_config, dataRoot } from "#utils/index";
import { omegascansBrowser } from "#api/browser";
import { mangaTask } from "#api/task";
import fs, { writeFileSync } from "fs";
import path from "node:path";

/** 统计本地已下载的章节目录数（包括压缩包） */
function countLocalChapters(mangaFolder: string): number {
  if (!fs.existsSync(mangaFolder)) return 0
  const entries = fs.readdirSync(mangaFolder)
  let count = 0
  for (const entry of entries) {
    const fullPath = path.join(mangaFolder, entry)
    if (fs.statSync(fullPath).isDirectory()) {
      // 跳过 .smanga 元数据目录
      if (entry === '.smanga') continue
      count++
    }
  }
  return count
}

export default class OmegaScansUpdate {
  page: any; // Puppeteer 页面对象
  downloadPath: string; // 下载路径
  private onProgress?: any

  constructor(params: any, onProgress?: any) {
    const config = get_config('omegascans') || {}
    this.downloadPath = config.downloadPath
  }

  async start() {
    if (!omegascansBrowser.browser) {
      await omegascansBrowser.init();
      await omegascansBrowser.get_cookie();
    }
    if (!omegascansBrowser.browser) return;
    this.page = await omegascansBrowser.new_page();

    const res = await this.request_interface(`https://api.omegascans.org/query?series_type=Comic&perPage=9999&adult=true&order=desc&orderBy=latest&page=1`);
    const mangaList = res.data || [];

    if (mangaList && mangaList.length > 0) {
      writeFileSync(`${dataRoot}data/omegascans.json`, JSON.stringify(mangaList, null, 2), 'utf-8');
    } else {
      write_log('[manga update]漫画列表获取失败');
      return;
    }
    // console.log(mangaList.length);
    // process.exit(0)
    mangaList.filter((manga: any) => {
      if (manga.status === 'Dropped') return false; // 跳过已放弃的漫画

      const mangaName = make_can_be_floder(manga.title);
      const paid_chapters = manga.paid_chapters || [];
      const chapters_count = manga?.meta?.chapters_count || 0;
      const mangaFolder = `${this.downloadPath}/${mangaName}`;
      const metaFolder = `${this.downloadPath}/${mangaName}/.smanga`;
      const metaFile = `${metaFolder}/meta.json`;

      // 计算可下载的章节数
      manga.chapterCount = chapters_count - paid_chapters.length;

      // 入队前比对：本地已下载 >= 可下载章节数 → 无更新，跳过不入队
      const localCount = countLocalChapters(mangaFolder);
      if (localCount >= manga.chapterCount) return;

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
        chapterCount: manga.chapterCount,
      }
      // console.log(params)
      mangaTask.add(params)
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
      waitUntil: 'networkidle2',
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
