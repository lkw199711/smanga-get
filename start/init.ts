import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// @ts-ignore
const cron = require('node-cron');

import fs from 'fs'
import path from 'node:path'
import OmegaScansUpdate from '#services/omegascans-update'
import ToZip from '#services/tozip';
import { subscribe_read } from '#api/subsribe';
import { mangaTask, refreshHighPriorityCache, refreshMediumPriorityCache } from '#api/task';
import { subsribeType } from '#type/index.js'
import { get_config, make_can_be_floder, set_config, dataRoot, write_json, write_log } from '#utils/index';
import MangaResult from '#models/manga_result'
import ToomicsAll from '#services/toomics-all'
import ToomicsDayUpdate from '#services/toomics-update'
let subsribeCron: any = { stop: () => { } }
let toomicsScAllCoversCron: any = { stop: () => { } }
let toomicsTcAllCoversCron: any = { stop: () => { } }
let toomicsScUpdateCron: any = { stop: () => { } }
let toomicsTcUpdateCron: any = { stop: () => { } }

const crons = [subsribeCron, toomicsScAllCoversCron, toomicsTcAllCoversCron, toomicsScUpdateCron, toomicsTcUpdateCron];

const dataPath = path.join(dataRoot, 'data')

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
  // 修复模式：强制所有任务入队，用于补全损坏的 meta.json
  // if (process.env.FORCE_CHAPTER_UPDATE === '1') return true
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

    // gentleman / omegascans 等非 toomics 订阅：打印入队信息
    if (item.website !== 'toomics') {
      write_log(`[订阅分配] ${item.website}:${item.id} ${item.name} 入队`)
    }

    mangaTask.add(item)
  }
}

export { hasChapterUpdate }

/**
 * 修复模式：读取 data/repair-manga-list.json，直接将条目加入下载队列（绕过订阅匹配）。
 *
 * 文件格式：
 *   [
 *     { "website": "toomics", "id": "8271", "name": "突然成為公寓管理員" }
 *   ]
 *
 * 设置 FORCE_CHAPTER_UPDATE=1 使下载器无条件重新获取 meta.json 全量章节。
 */
export async function repair_meta_queue() {
  const listFile = path.join(dataRoot || '', 'data', 'repair-manga-list.json')
  if (!fs.existsSync(listFile)) {
    write_log('[修复] repair-manga-list.json 不存在，跳过')
    return
  }

  let repairList: { website: string; id: string; name?: string }[]
  try {
    repairList = JSON.parse(fs.readFileSync(listFile, 'utf-8'))
  } catch {
    write_log('[修复] repair-manga-list.json 解析失败')
    return
  }

  if (!Array.isArray(repairList) || repairList.length === 0) {
    write_log('[修复] 修复列表为空')
    return
  }

  // 强制跳过 hasChapterUpdate 检查，使下载器重新获取完整章节列表
  process.env.FORCE_CHAPTER_UPDATE = '1'

  // 刷新优先级缓存，使 toomics 任务能按优先级插入队列
  refreshHighPriorityCache()
  await refreshMediumPriorityCache()

  for (const item of repairList) {
    mangaTask.add({
      website: item.website,
      id: String(item.id),
      name: item.name || '',
    } as subsribeType)
    write_log(`[修复] 入队: ${item.website} ${item.name || item.id}`)
  }

  write_log(`[修复] 共入队 ${repairList.length} 个任务`)
}

/**
 * 扫描下载目录，取最近更新的 58 部漫画，写入 repair-manga-list.json。
 *
 * 排序依据：漫画目录下所有文件的最大 mtime（即最近一次章节下载时间）。
 * mangaId 从 meta.json 中首个章节的 URL 提取（/toon/xxxx）。
 * 不做任何章节完整性判断，由人工确认列表后再触发 repair。
 *
 * @returns 写入的漫画数量
 */
export async function scan_broken_meta(): Promise<number> {
  const listFile = path.join(dataRoot || '', 'data', 'repair-manga-list.json')
  const LIMIT = 58

  // 收集所有 toomics 下载路径
  const configKeys = ['toomics', 'toomics-tc', 'toomics-sc', 'toomics-en']
  const config = get_config()

  type MangaEntry = { website: string; id: string; name: string; mtime: number }
  const entries: MangaEntry[] = []

  for (const key of configKeys) {
    const downloadPath = config?.[key]?.downloadPath as string | undefined
    if (!downloadPath || !fs.existsSync(downloadPath)) continue

    const dirs = fs.readdirSync(downloadPath, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('.')) continue

      const mangaPath = path.join(downloadPath, dir.name)
      const metaFile = path.join(mangaPath, '.smanga', 'meta.json')
      if (!fs.existsSync(metaFile)) continue

      // 从 meta.json 的首个章节 URL 中提取 mangaId（/toon/数字）
      let mangaId = ''
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        const chapters = Array.isArray(meta.chapters) ? meta.chapters : []
        for (const ch of chapters) {
          const match = ch.url?.match(/\/toon\/(\d+)/)
          if (match) { mangaId = match[1]; break }
        }
      } catch { /* meta.json 损坏 */ }
      if (!mangaId) continue

      // 取漫画目录下所有子目录/文件的最大 mtime（反映最近一次章节下载）
      let mtime = 0
      try {
        const items = fs.readdirSync(mangaPath, { withFileTypes: true })
        for (const item of items) {
          if (item.name.startsWith('.')) continue
          try {
            const st = fs.statSync(path.join(mangaPath, item.name))
            if (st.mtimeMs > mtime) mtime = st.mtimeMs
          } catch { /* 跳过无法访问的 */ }
        }
      } catch { /* 跳过无法读取的目录 */ }
      if (mtime === 0) {
        try { mtime = fs.statSync(mangaPath).mtimeMs } catch {}
      }

      entries.push({ website: 'toomics', id: mangaId, name: dir.name, mtime })
    }
  }

  // 按 mtime 降序，取前 58
  entries.sort((a, b) => b.mtime - a.mtime)
  const top = entries.slice(0, LIMIT)

  // 写入供人工确认的列表
  const list = top.map((e) => ({ website: e.website, id: e.id, name: e.name }))
  fs.writeFileSync(listFile, JSON.stringify(list, null, 2), 'utf-8')

  // 输出报告
  write_log(`[扫描] 共扫描 ${entries.length} 部漫画，取最近更新的 ${top.length} 部:`)
  for (const e of top) {
    const date = new Date(e.mtime).toISOString().slice(0, 10)
    write_log(`  toomics:${e.id} ${e.name} ${date}`)
  }

  return top.length
}

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

/**
 * 清理遗留的 -smanga-info 旧格式元数据目录，并将对应漫画加入修复列表。
 *
 * 操作流程：
 *   1. 扫描 toomics 下载目录，发现同时存在 .smanga/ 和 {名称}-smanga-info/ 的漫画
 *   2. 删除旧的 {名称}-smanga-info/ 目录
 *   3. 从 .smanga/meta.json 的章节 URL 中提取 mangaId
 *   4. 合并写入 repair-manga-list.json（不去重已存在的条目）
 *
 * @returns { deleted: 删除的目录数, added: 新增入修复列表的漫画数 }
 */
export async function clean_legacy_meta_dirs(): Promise<{ deleted: number; added: number }> {
  const listFile = path.join(dataRoot || '', 'data', 'repair-manga-list.json')

  const configKeys = ['toomics', 'toomics-tc', 'toomics-sc', 'toomics-en']
  const config = get_config()

  // 加载已有的修复列表，避免重复添加
  let repairList: { website: string; id: string; name?: string }[] = []
  if (fs.existsSync(listFile)) {
    try { repairList = JSON.parse(fs.readFileSync(listFile, 'utf-8')) } catch {}
  }
  const existing = new Set(repairList.map((e) => `${e.website}:${e.id}`))

  let deleted = 0
  let added = 0
  const processed = new Set<string>() // 按漫画名去重（downloadPath 和 compressPath 可能重叠）

  for (const key of configKeys) {
    const paths: string[] = []
    const dp = config?.[key]?.downloadPath as string | undefined
    const cp = config?.[key]?.compressPath as string | undefined
    if (dp) paths.push(dp)
    if (cp && cp !== dp) paths.push(cp)

    for (const scanPath of paths) {
      if (!fs.existsSync(scanPath)) continue

      const dirs = fs.readdirSync(scanPath, { withFileTypes: true })
      for (const dir of dirs) {
        if (!dir.isDirectory() || dir.name.startsWith('.')) continue
        if (processed.has(dir.name)) continue

        const mangaPath = path.join(scanPath, dir.name)
        const newMetaFile = path.join(mangaPath, '.smanga', 'meta.json')
        const legacyMetaDir = `${mangaPath}-smanga-info`

        // 必须同时存在 .smanga/meta.json 和旧格式目录才处理
        if (!fs.existsSync(newMetaFile) || !fs.existsSync(legacyMetaDir)) continue

        processed.add(dir.name)

        // 从 .smanga/meta.json 提取 mangaId
        let mangaId = ''
        try {
          const meta = JSON.parse(fs.readFileSync(newMetaFile, 'utf-8'))
          const chapters = Array.isArray(meta.chapters) ? meta.chapters : []
          for (const ch of chapters) {
            const match = ch.url?.match(/\/toon\/(\d+)/)
            if (match) { mangaId = match[1]; break }
          }
        } catch { /* meta.json 损坏 */ }
        if (!mangaId) continue

        // 删除旧目录
        try {
          fs.rmSync(legacyMetaDir, { recursive: true, force: true })
          write_log(`[清理] 删除旧元数据目录: ${legacyMetaDir}`)
          deleted++
        } catch (e) {
          write_log(`[清理] 删除失败: ${legacyMetaDir}`)
          continue
        }

        // 加入修复列表（去重）
        const entryKey = `toomics:${mangaId}`
        if (!existing.has(entryKey)) {
          repairList.push({ website: 'toomics', id: mangaId, name: dir.name })
          existing.add(entryKey)
          added++
          write_log(`[清理] 加入修复列表: toomics:${mangaId} ${dir.name}`)
        }
      }
    }
  }

  fs.writeFileSync(listFile, JSON.stringify(repairList, null, 2), 'utf-8')
  write_log(`[清理] 共删除 ${deleted} 个旧目录，新增 ${added} 条修复记录`)

  return { deleted, added }
}
