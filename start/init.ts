import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// @ts-ignore
const cron = require('node-cron');

import { subscribe_read } from '#api/subsribe';
import { mangaTask, refreshHighPriorityCache, refreshMediumPriorityCache } from '#api/task';
import { subsribeType } from '#type/index.js'
import { get_config, make_can_be_floder, set_config, dataRoot, write_json, write_log } from '#utils/index';
import MangaResult from '#models/manga_result'
import ToomicsAll from '#services/toomics-all'
import ToomicsDayUpdate from '#services/toomics-update'
import fs from 'fs'
import path from 'node:path'
import OmegaScansUpdate from '#services/omegascans-update'
import ToZip from '#services/tozip';
let subsribeCron: any = { stop: () => { } }
let toomicsScAllCoversCron: any = { stop: () => { } }
let toomicsTcAllCoversCron: any = { stop: () => { } }
let toomicsScUpdateCron: any = { stop: () => { } }
let toomicsTcUpdateCron: any = { stop: () => { } }

const crons = [subsribeCron, toomicsScAllCoversCron, toomicsTcAllCoversCron, toomicsScUpdateCron, toomicsTcUpdateCron];

const dataPath = dataRoot + 'data/'

export function create_config() {
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true })
  }

  if (get_config()) return;

  set_config({
    "headless": true,
    "cron": {
      "enable": false,
      "interval": "0 0 11,23 * * *"
    },
    "endAfterSetCookie": false,
    "autoRemoveSubscribe": true,
    "toomics": {
      "userName": "lkw199712@163.com",
      "passWord": "123qwe",
      "downloadLockedMeta": false,
      "cookieFile": "data/toomics-cookies.json",
      "scrollStep": 800,
      "scrollDelay": 500,
      "downloadPath": "M:\\manga"
    },
    "bilibili": {
      "cookieFile": "data/bilibili-cookies.json",
      "downloadLockedMeta": false,
      "scrollStep": 1000,
      "scrollDelay": 500,
      "downloadPath": "M:\\manga"
    }
  })

}

export function create_scan_cron() {
  const config = get_config().cron;
  if (!config?.enable) return;
  // 停止旧扫描任务
  crons.forEach(cron => {
    if (cron && cron.stop) { cron.stop() }
  })
  // 获取配置
  const scanInterval = config.interval || "0 0 2,14 * * *" // 每天0点和12点执行一次
  // 定时扫描任务

  subsribeCron = cron.schedule(scanInterval, async () => {
    // 刷新优先级缓存
    refreshHighPriorityCache()
    await refreshMediumPriorityCache()

    // 清空cookie记录
    if (config.clearCookies) {
      write_json('data/toomics-cookie.json', [])
    }

    // 订阅简体漫画
    mangaTask.add({
      "website": 'toomics-covers-sc',
      "id": 0,
      "name": ''
    })

    // 订阅繁体漫画
    mangaTask.add({
      "website": 'toomics-covers-tc',
      "id": 0,
      "name": ''
    })

    // 订阅OmegaScans
    mangaTask.add({
      "website": 'omegascans-update',
      "id": 0,
      "name": ''
    })

    const subsribe = subscribe_read()
    for (let i = 0; i < subsribe.length; i++) {
      const item: subsribeType = subsribe[i]
      const shouldSkip = await shouldSkipSubscription(item)
      if (shouldSkip) continue

      // 对 toomics 订阅，入队前比对本地章节数与线上章节数，无更新则不入队
      if (item.website === 'toomics' && typeof item.chapterCount === 'number' && item.chapterCount > 0) {
        const folderName = make_can_be_floder(item.name)
        if (!hasChapterUpdate(folderName, item.chapterCount, item.website, item.url)) {
          write_log(`[订阅分配] ${item.name} 无新章节 (本地已齐)，跳过入队`)
          continue
        }
      }

      mangaTask.add(item)
    }

    // 压缩简体漫画
    mangaTask.add({ website: 'toomics-compress-sc', id: 0, name: '' })

    // 压缩繁体漫画
    mangaTask.add({ website: 'toomics-compress-tc', id: 0, name: '' })

    // 压缩OmegaScans
    mangaTask.add({ website: 'omegascans-compress', id: 0, name: '' })
  });
}

/**
 * 检查指定漫画是否有新章节需要下载（纯文件系统判定，无需浏览器）
 *
 * 复用 Toomics.check_update() 的计数逻辑：
 *   本地章节目录数 + 仅存在于压缩目录的 zip 数 + 0.9 容差 < 线上章节数 → 有更新
 * 0.9 容差用于应对请假条、临时公告等非整数章节（如 60.5）
 */
function hasChapterUpdate(mangaName: string, chapterCount: number, website: string, url?: string): boolean {
  // 从 URL 推断语言标签，匹配实际下载目录（与 Toomics 构造器一致）
  let configKey = website
  if (url) {
    if (/\/tc\//.test(url)) configKey = 'toomics-tc'
    else if (/\/en\//.test(url)) configKey = 'toomics-en'
    else if (/\/sc\//.test(url)) configKey = 'toomics-sc'
    else configKey = 'toomics-tc'
  }

  const config = get_config(configKey) || {}
  const downloadPath = config?.downloadPath || ''
  const compressPath = config?.compressPath || ''
  if (!downloadPath || !mangaName) return true // 路径无效时保守处理，允许入队

  const mangaFolder = path.join(downloadPath, mangaName)
  const compressFolder = path.join(compressPath, mangaName)

  let localCount = 0
  if (fs.existsSync(mangaFolder)) {
    localCount = fs.readdirSync(mangaFolder).filter(
      (item) => fs.statSync(path.join(mangaFolder, item)).isDirectory() && item !== '.smanga'
    ).length
  }

  let compressedOnly = 0
  if (fs.existsSync(compressFolder)) {
    const localNames = new Set(fs.existsSync(mangaFolder) ? fs.readdirSync(mangaFolder) : [])
    compressedOnly = fs.readdirSync(compressFolder).filter(
      (item) => item.endsWith('.zip') && /\d/.test(item) && !localNames.has(item.replace('.zip', ''))
    ).length
  }

  // write_log(`[toomics all] ${mangaName}, ${chapterCount}, ${configKey}, localCount: ${localCount}, compressedOnly: ${compressedOnly}`)
  return localCount + compressedOnly + 0.9 < chapterCount
}

export async function task_allocation() {
  // 刷新优先级缓存（HIGH 同步 + MEDIUM 异步）
  refreshHighPriorityCache()
  await refreshMediumPriorityCache()

  const subsribe = subscribe_read()
  for (let i = 0; i < subsribe.length; i++) {
    const item: subsribeType = subsribe[i]
    const shouldSkip = await shouldSkipSubscription(item)
    if (shouldSkip) continue

    // 对 toomics 订阅，入队前比对本地章节数与线上章节数，无更新则不入队
    if (item.website === 'toomics' && typeof item.chapterCount === 'number' && item.chapterCount > 0) {
      const folderName = make_can_be_floder(item.name)
      if (!hasChapterUpdate(folderName, item.chapterCount, item.website, item.url)) {
        write_log(`[订阅分配] ${item.name} 无新章节 (本地已齐)，跳过入队`)
        continue
      }
    }

    mangaTask.add(item)
  }
}

export { hasChapterUpdate }

/** 检查订阅是否应跳过：查 manga_results.crawledAt，若在 skipDays 内则返回 true */
async function shouldSkipSubscription(item: subsribeType): Promise<boolean> {
  if (!item.id || !item.website) return false

  const config = get_config()
  const siteConfig = config?.[item.website]
  const skipDays = Number(siteConfig?.skipDays || 0)
  if (skipDays <= 0) return false

  const identityKey = `${item.website}:${item.id}`
  const lastResult = await MangaResult.findBy('identityKey', identityKey)
  if (!lastResult?.crawledAt) return false

  const daysSince = (Date.now() - new Date(lastResult.crawledAt).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSince < skipDays) {
    write_log(`[订阅分配] ${item.name || item.id} 跳过，上次扫描 ${daysSince.toFixed(1)} 天前（阈值 ${skipDays} 天）`)
    return true
  }
  return false
}
