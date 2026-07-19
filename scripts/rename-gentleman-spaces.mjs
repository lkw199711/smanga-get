#!/usr/bin/env node

/**
 * Gentleman 漫画目录空格命名迁移脚本
 *
 * 背景：
 *   旧版 gentleman 代码在 make_can_be_floder 之外额外剔除了空格，
 *   导致目录名为 "BeautifulDays"（旧格式）。
 *   新版保留空格，目录名为 "Beautiful Days"（新格式）。
 *   新旧不匹配导致无法识别旧漫画，触发重复下载。
 *
 * 用法：
 *   node scripts/rename-gentleman-spaces.mjs              # 预览模式（默认）
 *   node scripts/rename-gentleman-spaces.mjs --dry-run    # 预览模式
 *   node scripts/rename-gentleman-spaces.mjs --execute    # 实际执行
 *   node scripts/rename-gentleman-spaces.mjs --help       # 帮助
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 清理名称为合法目录名（与 app/utils/index.ts 中 make_can_be_floder 保持一致） */
function makeCanBeFolder(name) {
  return name
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/[&<>'"]/g, '')
    .trimStart()
    .trimEnd()
}

/** 安全读取 JSON 文件 */
function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 安全获取目录下的子目录名列表（排除 . 开头） */
function getSubdirs(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return []
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } catch {
    return []
  }
}

/**
 * 从绅士漫画列表页 HTML 中解析章节名（与 gentleman.ts get_page_chapters 逻辑一致）
 * 返回 make_can_be_floder 处理后的章节名数组（含空格，新格式）
 *
 * @param {string} html - 绅士漫画目录页 HTML
 * @returns {string[]}
 */
function parseChapterNamesFromHtml(html) {
  // 提取每个 <li> 条目中的 title 属性值作为章节名
  // HTML 结构: <li>...<a title="第 185 話"...>...</li>
  const names = []
  const liMatches = html.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || []
  for (const li of liMatches) {
    const titleMatch = li.match(/title="([^"]*)"/i)
    if (!titleMatch) continue
    const rawName = titleMatch[1]
    // 应用 make_can_be_floder（与 gentleman.ts 第 650 行一致）
    const cleanName = makeCanBeFolder(rawName.replace(/<[^>]+>/g, ''))
    if (cleanName) names.push(cleanName)
  }
  return names
}

/**
 * 尝试通过 HTTP 请求绅士漫画目录页获取章节名列表
 *
 * @param {string} mangaUrl - 漫画目录页完整 URL
 * @returns {Promise<string[]>} 章节名数组（含空格的新格式），失败返回空数组
 */
async function fetchChapterNamesFromWeb(mangaUrl) {
  if (!mangaUrl) return []
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const resp = await fetch(mangaUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timeout)
    if (!resp.ok) return []
    const html = await resp.text()
    return parseChapterNamesFromHtml(html)
  } catch {
    return []
  }
}

// ── 操作日志 ────────────────────────────────────────────────────────────────

/** @type {Array<{action: string, from: string, to: string}>} */
const operations = []

function logOp(action, from, to = '') {
  operations.push({ action, from, to })
}

function summaryLine(action, from, to) {
  if (to) {
    return `  ${action}\n    源: ${from}\n    目标: ${to}`
  }
  return `  ${action}\n    路径: ${from}`
}

// ── 核心迁移逻辑 ────────────────────────────────────────────────────────────

/**
 * 重命名目录中仍为旧格式（无空格）的章节目录。
 * 按优先级尝试获取正确章节名：
 *   1. 目标目录自身的 .smanga/meta.json
 *   2. referencePath（如 organizePath 对应目录）的章节子目录名
 *   3. webChapterNames（从绅士漫画网站抓取的章节名列表）
 *
 * @param {string} dirPath       - 需要检查的漫画目录路径
 * @param {string|null} referencePath - 可选的参考目录
 * @param {string[]} webChapterNames  - 从网站抓取的章节名（新格式，含空格）
 * @param {boolean} isExecute
 * @returns {{ renamed: number, needRename: number }}
 */
function renameChaptersInDir(dirPath, referencePath, webChapterNames, isExecute) {
  const allChapters = getSubdirs(dirPath)
  if (allChapters.length === 0) return { renamed: 0, needRename: 0 }

  // 筛选出需要重命名的章节（名称不含空格）
  /** @type {string[]} */
  const needRename = allChapters.filter(ch => ch.replace(/\s+/g, '') === ch)
  if (needRename.length === 0) return { renamed: 0, needRename: 0 }

  // 构建正确章节名查找表：去空格名 → 含空格名
  /** @type {Map<string, string>} */
  const targetMap = new Map()

  // 来源 1：自身 meta.json
  const metaFile = path.join(dirPath, '.smanga', 'meta.json')
  const meta = readJson(metaFile)
  if (meta && Array.isArray(meta.chapters)) {
    for (const mc of meta.chapters) {
      const mcName = (mc && mc.name) ? String(mc.name) : ''
      if (!mcName) continue
      const noSpace = mcName.replace(/\s+/g, '')
      if (noSpace !== mcName) {
        targetMap.set(noSpace, mcName)
      }
    }
  }

  // 来源 2：referencePath 的章节子目录名（新格式，含空格）
  if (targetMap.size === 0 && referencePath && fs.existsSync(referencePath)) {
    const refChapters = getSubdirs(referencePath)
    for (const refCh of refChapters) {
      const noSpace = refCh.replace(/\s+/g, '')
      if (noSpace !== refCh) {
        targetMap.set(noSpace, refCh)
      }
    }
  }

  // 来源 3：从网站抓取的章节名
  if (targetMap.size === 0 && webChapterNames.length > 0) {
    for (const wcName of webChapterNames) {
      if (!wcName) continue
      const noSpace = wcName.replace(/\s+/g, '')
      if (noSpace !== wcName) {
        targetMap.set(noSpace, wcName)
      }
    }
  }

  // 若仍无可用参考名，记录警告
  if (targetMap.size === 0) {
    logOp('章节无法重命名（缺少新格式参考名）',
      path.join(dirPath, `[${needRename.length}个章节，如 "${needRename[0]}"]`))
    return { renamed: 0, needRename: needRename.length }
  }

  let renamed = 0
  for (const oldCh of needRename) {
    const targetName = targetMap.get(oldCh)
    if (!targetName || targetName === oldCh) continue

    const oldChPath = path.join(dirPath, oldCh)
    const newChPath = path.join(dirPath, targetName)

    logOp('重命名章节目录', oldChPath, newChPath)
    if (isExecute) {
      if (fs.existsSync(newChPath)) {
        fs.rmSync(newChPath, { recursive: true, force: true })
      }
      fs.renameSync(oldChPath, newChPath)
    }
    renamed++
  }

  return { renamed, needRename: needRename.length }
}

/**
 * 迁移单个路径（downloadPath 或 organizePath）下的 gentleman 漫画目录
 *
 * @param {string} basePath      - 下载/归档根目录
 * @param {string} newName       - 新格式漫画名（含空格）
 * @param {string} oldName       - 旧格式漫画名（无空格）
 * @param {string|null} otherPath - 另一个路径的对应目录（用于章节名交叉参考）
 * @param {string[]} webChapterNames - 从网站抓取的章节名
 * @param {boolean} isExecute    - 是否实际执行
 * @returns {{ renamed: number, deleted: number, skipped: number, chapterRenamed: number }}
 */
function migrateManga(basePath, newName, oldName, otherPath, webChapterNames, isExecute) {
  const result = { renamed: 0, deleted: 0, skipped: 0, chapterRenamed: 0 }

  const oldPath = path.join(basePath, oldName)
  const newPath = path.join(basePath, newName)

  const oldExists = fs.existsSync(oldPath)
  const newExists = fs.existsSync(newPath)

  if (!oldExists && !newExists) {
    // 两个都不存在，跳过
    logOp('跳过（目录不存在）', oldPath)
    result.skipped++
    return result
  }

  if (!oldExists && newExists) {
    // ── 新目录已存在，但章节可能仍是旧格式 ──
    // （漫画目录已被重命名、但章节目录尚未处理的中间状态）
    const chResult = renameChaptersInDir(newPath, otherPath, webChapterNames, isExecute)
    result.chapterRenamed += chResult.renamed

    if (chResult.needRename === 0) {
      logOp('跳过（已是新格式）', newPath)
      result.skipped++
    } else if (chResult.renamed > 0) {
      logOp('章节已重命名（漫画目录已是新格式）', newPath)
    }
    // 若 needRename > 0 但 renamed === 0，已在 renameChaptersInDir 内部日志
    return result
  }

  if (oldExists && !newExists) {
    // ── 情况 1：只有旧目录 ──
    // 尝试从 meta.json 或 otherPath 获取章节名来辅助重命名
    const chResult = renameChaptersInDir(oldPath, otherPath, webChapterNames, isExecute)
    result.chapterRenamed += chResult.renamed

    // 重命名漫画目录
    logOp('重命名漫画目录', oldPath, newPath)
    if (isExecute) {
      fs.renameSync(oldPath, newPath)
    }
    result.renamed++
    return result
  }

  // ── 情况 2：新旧目录同时存在 ──
  // 策略：用新目录中的章节名匹配旧目录中的章节（去除空格后对比），
  //       重命名旧章节 → 删除新目录（重复下载的） → 重命名旧漫画目录

  const newChapters = getSubdirs(newPath)
  const oldChapters = getSubdirs(oldPath)

  // 构建旧章节查找表：去除空格后的名称 → 原始目录名
  // 注意：旧目录中的章节名不含空格，但也必须纳入映射（key = 自身）
  /** @type {Map<string, string>} */
  const oldChapterMap = new Map()
  for (const ch of oldChapters) {
    const noSpace = ch.replace(/\s+/g, '')
    // 总是添加：新章节名去空格后能匹配到旧章节的无空格名
    oldChapterMap.set(noSpace, ch)
  }

  // 遍历新目录中的章节，匹配并重命名旧章节
  for (const newCh of newChapters) {
    const newChNoSpace = newCh.replace(/\s+/g, '')
    if (newChNoSpace === newCh) {
      // 新章节名本身无空格，无需匹配
      continue
    }

    const oldChName = oldChapterMap.get(newChNoSpace)
    if (!oldChName) {
      // 无匹配的旧章节（可能是仅新目录独有的章节）
      continue
    }

    if (oldChName === newCh) {
      // 旧章节名已经是新格式，无需重命名
      continue
    }

    const oldChPath = path.join(oldPath, oldChName)
    const newChPath = path.join(oldPath, newCh)  // 目标位置在旧目录内

    logOp('重命名章节目录', oldChPath, newChPath)
    if (isExecute) {
      if (fs.existsSync(newChPath)) {
        // 如果旧目录内已有同名新格式章节（极少情况），先删除
        fs.rmSync(newChPath, { recursive: true, force: true })
      }
      fs.renameSync(oldChPath, newChPath)
    }
    result.chapterRenamed++
  }

  // 删除新目录（重复下载的）
  logOp('删除重复下载目录', newPath)
  if (isExecute) {
    fs.rmSync(newPath, { recursive: true, force: true })
  }
  result.deleted++

  // 重命名旧漫画目录 → 新名称
  logOp('重命名漫画目录', oldPath, newPath)
  if (isExecute) {
    fs.renameSync(oldPath, newPath)
  }
  result.renamed++

  return result
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  // 解析命令行参数
  const args = process.argv.slice(2)
  const isExecute = args.includes('--execute')
  const isHelp = args.includes('--help') || args.includes('-h')

  if (isHelp) {
    console.log(`
Gentleman 漫画目录空格命名迁移脚本

用法：
  node scripts/rename-gentleman-spaces.mjs              # 预览模式（默认）
  node scripts/rename-gentleman-spaces.mjs --dry-run    # 预览模式
  node scripts/rename-gentleman-spaces.mjs --execute    # 实际执行
  node scripts/rename-gentleman-spaces.mjs --help       # 帮助

说明：
  将旧格式目录名（去除空格）重命名为新格式（保留空格），
  解决新旧命名不匹配导致的重复下载问题。
  同时处理 gentleman 的 downloadPath 和 organizePath 两个目录。
`)
    return
  }

  // 确定 data 目录
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const projectRoot = path.resolve(scriptDir, '..')
  const dataDir = process.env.DATA_DIR || projectRoot
  const dataPath = (dataDir.endsWith('/') || dataDir.endsWith('\\'))
    ? path.join(dataDir, 'data')
    : path.join(dataDir, 'data')

  console.log(`项目根目录: ${projectRoot}`)
  console.log(`数据目录:   ${dataPath}`)
  console.log(`模式:       ${isExecute ? '执行模式' : '预览模式 (--dry-run)'}`)
  console.log('')

  // 读取配置
  const configFile = path.join(dataPath, 'config.json')
  const config = readJson(configFile)
  if (!config) {
    console.error(`错误：无法读取配置文件 ${configFile}`)
    process.exit(1)
  }

  const gentlemanConfig = config.gentleman
  if (!gentlemanConfig) {
    console.error('错误：配置文件中未找到 gentleman 配置节')
    process.exit(1)
  }

  const downloadPath = gentlemanConfig.downloadPath || ''
  const organizePath = gentlemanConfig.organizePath || ''

  if (!downloadPath) {
    console.error('错误：gentleman.downloadPath 未配置')
    process.exit(1)
  }

  console.log(`downloadPath:  ${downloadPath}`)
  console.log(`organizePath:  ${organizePath || '(未配置)'}`)
  console.log('')

  // 读取订阅列表
  const subscribeFile = path.join(dataPath, 'subscribe.json')
  const subscribes = readJson(subscribeFile)
  if (!subscribes || !Array.isArray(subscribes)) {
    console.error(`错误：无法读取订阅文件 ${subscribeFile}`)
    process.exit(1)
  }

  // 筛选 gentleman 订阅
  const gentlemanSubs = subscribes.filter(s => s.website === 'gentleman')
  console.log(`订阅总数: ${subscribes.length}`)
  console.log(`gentleman 订阅数: ${gentlemanSubs.length}`)
  console.log('')

  // 统计
  let totalMangaRenamed = 0
  let totalMangaDeleted = 0
  let totalMangaSkipped = 0
  let totalChapterRenamed = 0
  let totalNoChange = 0

  for (const sub of gentlemanSubs) {
    const subName = sub.name || ''
    if (!subName) {
      logOp('跳过（订阅名称为空）', `id=${sub.id || '?'}, url=${sub.url || '?'}`)
      totalMangaSkipped++
      continue
    }

    const newName = makeCanBeFolder(subName)
    const oldName = newName.replace(/\s+/g, '')

    if (oldName === newName) {
      // 名称中没有空格，无需处理
      totalNoChange++
      continue
    }

    console.log(`── 处理: "${subName}" ──`)
    console.log(`  新格式名: "${newName}"`)
    console.log(`  旧格式名: "${oldName}"`)

    // 从网站抓取章节名（作为第 3 优先级参考源）
    const mangaUrl = sub.url || ''
    const webChapterNames = mangaUrl ? await fetchChapterNamesFromWeb(mangaUrl) : []
    if (webChapterNames.length > 0) {
      console.log(`  从网站获取到 ${webChapterNames.length} 个章节名`)
    }

    // 处理 downloadPath
    const dlOther = organizePath ? path.join(organizePath, newName) : null
    const dlResult = migrateManga(downloadPath, newName, oldName, dlOther, webChapterNames, isExecute)
    totalMangaRenamed += dlResult.renamed
    totalMangaDeleted += dlResult.deleted
    totalMangaSkipped += dlResult.skipped
    totalChapterRenamed += dlResult.chapterRenamed

    // 处理 organizePath（如果配置了）
    if (organizePath) {
      const orgOther = path.join(downloadPath, newName)
      const orgResult = migrateManga(organizePath, newName, oldName, orgOther, webChapterNames, isExecute)
      totalMangaRenamed += orgResult.renamed
      totalMangaDeleted += orgResult.deleted
      totalMangaSkipped += orgResult.skipped
      totalChapterRenamed += orgResult.chapterRenamed
    }

    console.log('')
  }

  // ── 输出操作详情 ──
  if (operations.length > 0) {
    console.log('═'.repeat(70))
    console.log('操作详情:')
    console.log('═'.repeat(70))

    /** 按 action 分组输出 */
    const actionGroups = new Map()
    for (const op of operations) {
      const list = actionGroups.get(op.action) || []
      list.push(op)
      actionGroups.set(op.action, list)
    }

    for (const [action, ops] of actionGroups) {
      console.log(`\n[${action}] (${ops.length} 项)`)
      for (const op of ops) {
        console.log(summaryLine(action, op.from, op.to))
      }
    }
  }

  // ── 统计汇总 ──
  console.log('')
  console.log('═'.repeat(70))
  console.log('统计汇总:')
  console.log('═'.repeat(70))
  console.log(`  无需处理（名称无空格）: ${totalNoChange}`)
  console.log(`  漫画目录重命名:         ${totalMangaRenamed}`)
  console.log(`  重复下载目录删除:       ${totalMangaDeleted}`)
  console.log(`  章节目录重命名:         ${totalChapterRenamed}`)
  console.log(`  跳过:                   ${totalMangaSkipped}`)
  console.log('')

  if (!isExecute) {
    console.log('⚠ 当前为预览模式，未执行任何实际操作。')
    console.log('  确认无误后，使用 --execute 参数执行：')
    console.log('  node scripts/rename-gentleman-spaces.mjs --execute')
  } else {
    console.log('✓ 迁移完成。')
  }

  // ── 后续操作提示 ──
  const unresolvable = operations.filter(op => op.action === '章节无法重命名（缺少新格式参考名）')
  if (unresolvable.length > 0) {
    console.log('')
    console.log('═'.repeat(70))
    console.log('⚠ 部分章节目录无法自动重命名')
    console.log('═'.repeat(70))
    console.log('')
    console.log('原因：缺少含空格的参考章节名（meta.json 是旧代码生成，organizePath 使用数字编号）。')
    console.log('')
    console.log('解决方法：')
    console.log('  1. 运行 gentleman 下载器刷新这些漫画的元数据（只写 meta.json，不重复下载）：')
    console.log('     - 在 smanga-get-webui 中逐个触发这些漫画的任务')
    console.log('     - 或设置环境变量后启动：FORCE_CHAPTER_UPDATE=1 只刷新元数据')
    console.log('  2. meta.json 更新后，重新运行本脚本即可自动匹配并重命名章节目录：')
    console.log('     node scripts/rename-gentleman-spaces.mjs --execute')
    console.log('')
    console.log('涉及漫画：')

    // 收集去重后的漫画路径
    const seen = new Set()
    for (const op of unresolvable) {
      // 从路径中提取漫画名（路径格式：basePath/mangaName）
      const parts = op.from.split(/[/\\]/)
      const chapterHint = parts.pop()  // [N个章节...]
      const mangaName = parts.pop()
      const basePath = parts.join(path.sep)
      const key = `${basePath}|${mangaName}`
      if (!seen.has(key)) {
        seen.add(key)
        console.log(`    ${basePath}${path.sep}${mangaName}`)
        console.log(`      ↳ ${chapterHint}`)
      }
    }
    console.log('')
  }
}

main().catch((err) => {
  console.error('脚本执行出错:', err)
  process.exit(1)
})

