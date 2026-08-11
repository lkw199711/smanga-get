#!/usr/bin/env node

/**
 * 将平铺的漫画图片按文件名中的“话号 + 页码”整理为章节目录。
 *
 * 默认只预览，不修改文件。当前已知格式示例：
 *   001136.webp -> 001/136.webp
 *   000000a.webp -> 000/000a.webp
 */

/**
 * 使用示例
node scripts\organize-manga-images.mjs `
  --batch "D:\18H-manga整理\gentleman" `
  --output "D:\18H-manga整理\gentleman-o" `
  --mode copy `
  --execute `
  --allow-gaps
  --zip
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
])

// 自动发现时不能因为偶然出现一张六位数字文件就把整个夹带目录纳入整理。
const AUTO_SOURCE_MIN_MATCHED_IMAGES = 3
const AUTO_SOURCE_MIN_RECOGNIZED_RATIO = 0.8
const BATCH_REPORT_FILE = '_漫画图片规整检查报告.txt'

function printHelp() {
  console.log(`
漫画图片分话整理脚本

用法：
  node scripts/organize-manga-images.mjs <漫画目录...> --output <输出根目录> [选项]
  node scripts/organize-manga-images.mjs --batch <漫画库根目录...> --output <输出根目录> [选项]

选项：
  --execute              实际复制或移动文件；默认仅预览
  --batch                把输入目录的一级子目录分别作为漫画批量处理
  --output <目录>        必填；规整结果的输出根目录
  --mode <copy|move>     文件处理方式，默认 copy（复制）
  --copy                 等同于 --mode copy
  --move                 等同于 --mode move
  --zip-chapters         将每个输出章节打包为同名 ZIP，并删除输出章节散图
  --zip                  等同于 --zip-chapters
  --allow-gaps           允许在检测到缺页时执行
  --unmatched-mode <m>   无法识别图片的处理：extras（默认）、skip、error
  --allow-unmatched      兼容旧参数，等同于 --unmatched-mode skip
  --prefix-digits <n>    文件名前置分卷位数，默认 auto 自动推断
  --chapter-digits <n>   话号位数，默认 3
  --page-digits <n>      页码位数，默认 3
  --source <目录>        指定图片源目录，可重复；相对路径基于漫画目录
  --keep-empty-source    move 模式下保留已变空的源目录
  -h, --help             显示帮助

示例：
  # 预览：自动寻找漫画目录本身或其一级子目录中的平铺图片
  node scripts/organize-manga-images.mjs "U:\\gentleman\\某部漫画" --output "E:\\漫画规整"

  # 挑选多部漫画统一预览
  node scripts/organize-manga-images.mjs "D:\\漫画A" "D:\\漫画B" --output "E:\\漫画规整"

  # 预览漫画库根目录下的所有漫画
  node scripts/organize-manga-images.mjs --batch "D:\\18H-manga整理\\gentleman" --output "E:\\漫画规整"

  # 确认报告后执行；已知原图有缺页时需显式确认
  node scripts/organize-manga-images.mjs "U:\\gentleman\\某部漫画" --output "E:\\漫画规整" --mode move --execute --allow-gaps

  # 输出 001.zip、002.zip……；打包校验成功后删除输出章节目录中的散图
  node scripts/organize-manga-images.mjs "U:\\gentleman\\某部漫画" --output "E:\\漫画规整" --zip-chapters --execute

整理规则：
  默认把文件名开头 3 位作为话号、随后 3 位作为页码，剩余后缀保留。
  例如 023077.webp 会整理为 023/077.webp。
  没有完整“话号 + 页码”结构的全零特殊图片（如 000a.jpg、000b.webp）
  会作为封面存入输出漫画的 .smanga 目录，依次命名为 cover.jpg、cover2.jpg……
  完整编码的第 000 话图片（如 000001.jpg）仍会整理到 000 目录。
  若整理后仍没有 .smanga/cover.jpg，则用最早正常章节的第一张图生成封面；
  优先选择第 001 话及之后的最早章节，只有第 000 话时才使用第 000 话。
  最终采用的图片源目录名以 v2、v3 等结尾时，输出漫画目录会附加该版本号。
  自动兼容“分部前缀 + 话号 + 页码”的七位及更长数字编码；检测到多个
  分部前缀时，会按各分部的实际话号范围依次展开为连续话号。
  无章节编码的广告/附件默认按原名保存到 _extras，可用 --unmatched-mode 调整。
  自动发现只接纳至少 3 张符合编码、且可识别图片比例不低于 80% 的目录。
  使用 --source 显式指定目录时不应用上述自动筛选门槛。
  批量模式会在每个源漫画目录写入 ${BATCH_REPORT_FILE}，但预览不会传输图片。
  输出结构固定为“输出根目录/漫画目录名/话号/页码.扩展名”。
  使用 --zip-chapters 后，章节输出改为“输出根目录/漫画目录名/话号.zip”；
  ZIP 内直接存放该话图片，不包含额外的章节目录层级。.smanga 和 _extras 不打包。
`)
}

function fail(message) {
  throw new Error(message)
}

function readPositiveInteger(raw, optionName) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    fail(`${optionName} 必须是 1 到 12 之间的整数`)
  }
  return value
}

export function parseArgs(argv) {
  const options = {
    execute: false,
    batch: false,
    outputDir: '',
    transferMode: 'copy',
    transferModeExplicit: false,
    zipChapters: false,
    allowGaps: false,
    unmatchedMode: 'extras',
    prefixDigits: 'auto',
    chapterDigits: 3,
    pageDigits: 3,
    sources: [],
    keepEmptySource: false,
    help: false,
    mangaDirs: [],
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--execute') {
      options.execute = true
    } else if (arg === '--batch') {
      options.batch = true
    } else if (arg === '--output') {
      const outputDir = argv[++index]
      if (!outputDir) fail('--output 后必须提供输出根目录')
      options.outputDir = outputDir
    } else if (arg === '--mode') {
      const mode = argv[++index]
      if (mode !== 'copy' && mode !== 'move') fail('--mode 只能是 copy 或 move')
      if (options.transferModeExplicit && options.transferMode !== mode) {
        fail('不能同时指定 copy 和 move 两种模式')
      }
      options.transferMode = mode
      options.transferModeExplicit = true
    } else if (arg === '--copy' || arg === '--move') {
      const mode = arg.slice(2)
      if (options.transferModeExplicit && options.transferMode !== mode) {
        fail('不能同时指定 --copy 和 --move')
      }
      options.transferMode = mode
      options.transferModeExplicit = true
    } else if (arg === '--zip-chapters' || arg === '--zip') {
      options.zipChapters = true
    } else if (arg === '--allow-gaps') {
      options.allowGaps = true
    } else if (arg === '--allow-unmatched') {
      options.unmatchedMode = 'skip'
    } else if (arg === '--unmatched-mode') {
      const mode = argv[++index]
      if (!['extras', 'skip', 'error'].includes(mode)) {
        fail('--unmatched-mode 只能是 extras、skip 或 error')
      }
      options.unmatchedMode = mode
    } else if (arg === '--prefix-digits') {
      const value = argv[++index]
      if (value === 'auto') {
        options.prefixDigits = 'auto'
      } else {
        const prefixDigits = Number(value)
        if (!Number.isInteger(prefixDigits) || prefixDigits < 0 || prefixDigits > 12) {
          fail('--prefix-digits 必须是 auto 或 0 到 12 之间的整数')
        }
        options.prefixDigits = prefixDigits
      }
    } else if (arg === '--keep-empty-source') {
      options.keepEmptySource = true
    } else if (arg === '--chapter-digits') {
      options.chapterDigits = readPositiveInteger(argv[++index], arg)
    } else if (arg === '--page-digits') {
      options.pageDigits = readPositiveInteger(argv[++index], arg)
    } else if (arg === '--source') {
      const source = argv[++index]
      if (!source) fail('--source 后必须提供目录')
      options.sources.push(source)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg.startsWith('-')) {
      fail(`未知选项：${arg}`)
    } else {
      options.mangaDirs.push(arg)
    }
  }

  return options
}

function createNamePattern(chapterDigits, pageDigits) {
  return new RegExp(`^(\\d{${chapterDigits}})(\\d{${pageDigits}})(.*)$`)
}

function createZeroSpecialPattern(pageDigits) {
  return new RegExp(`^0{${pageDigits}}.*$`)
}

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())
}

function readDirectoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    fail(`无法读取目录 ${directory}：${error.message}`)
  }
}

function inspectSource(directory, namePattern, zeroSpecialPattern) {
  const entries = readDirectoryEntries(directory)
  const imageFiles = entries.filter((entry) => entry.isFile() && isImageFile(entry.name))
  const matchedCount = imageFiles.filter((entry) => namePattern.test(path.parse(entry.name).name)).length
  const specialCount = imageFiles.filter((entry) =>
    !namePattern.test(path.parse(entry.name).name)
      && zeroSpecialPattern.test(path.parse(entry.name).name)
  ).length
  const recognizedCount = matchedCount + specialCount
  const recognizedRatio = imageFiles.length === 0 ? 0 : recognizedCount / imageFiles.length
  return {
    directory,
    entries,
    imageFiles,
    matchedCount,
    specialCount,
    recognizedCount,
    recognizedRatio,
  }
}

function resolveExplicitSources(mangaDir, sources, namePattern, zeroSpecialPattern) {
  const resolved = []
  for (const source of sources) {
    const sourcePath = path.resolve(mangaDir, source)
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
      fail(`图片源目录不存在或不是目录：${sourcePath}`)
    }
    resolved.push(inspectSource(sourcePath, namePattern, zeroSpecialPattern))
  }
  return resolved
}

function getAutoExclusionReason(candidate) {
  if (candidate.imageFiles.length === 0) return '目录中没有图片'
  if (candidate.matchedCount === 0) return '没有符合“话号 + 页码”编码的图片'
  if (candidate.matchedCount < AUTO_SOURCE_MIN_MATCHED_IMAGES) {
    return `仅 ${candidate.matchedCount} 张图片符合编码，低于自动接纳门槛 ${AUTO_SOURCE_MIN_MATCHED_IMAGES}`
  }
  if (candidate.recognizedRatio < AUTO_SOURCE_MIN_RECOGNIZED_RATIO) {
    return `可识别图片比例 ${(candidate.recognizedRatio * 100).toFixed(1)}%，低于自动接纳门槛 ${AUTO_SOURCE_MIN_RECOGNIZED_RATIO * 100}%`
  }
  return ''
}

function discoverSources(mangaDir, namePattern, zeroSpecialPattern) {
  const sources = []
  const excludedSources = []
  const mangaRoot = inspectSource(mangaDir, namePattern, zeroSpecialPattern)
  const rootExclusionReason = getAutoExclusionReason(mangaRoot)
  if (!rootExclusionReason) {
    sources.push(mangaRoot)
  } else if (mangaRoot.imageFiles.length > 0) {
    excludedSources.push({ ...mangaRoot, reason: rootExclusionReason })
  }

  for (const entry of mangaRoot.entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.smanga') {
      excludedSources.push({
        directory: path.join(mangaDir, entry.name),
        imageFiles: [],
        matchedCount: 0,
        specialCount: 0,
        recognizedCount: 0,
        recognizedRatio: 0,
        reason: '元数据目录，固定排除',
      })
      continue
    }

    const candidate = inspectSource(
      path.join(mangaDir, entry.name),
      namePattern,
      zeroSpecialPattern
    )
    const reason = getAutoExclusionReason(candidate)
    if (reason) {
      excludedSources.push({ ...candidate, reason })
    } else {
      sources.push(candidate)
    }
  }

  return { sources, excludedSources }
}

function normalizeDestinationKey(filePath) {
  const normalized = path.normalize(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateSeparateOutputPath(mangaDir, outputMangaDir) {
  if (isSameOrInside(outputMangaDir, mangaDir) || isSameOrInside(mangaDir, outputMangaDir)) {
    fail(`输出漫画目录不能与源漫画目录重叠：${outputMangaDir}`)
  }
}

function getMissingPages(pageNumbers) {
  if (pageNumbers.length === 0) return []
  const unique = [...new Set(pageNumbers)].sort((left, right) => left - right)
  const start = unique[0] === 0 ? 0 : 1
  const end = unique[unique.length - 1]
  const present = new Set(unique)
  const missing = []
  for (let page = start; page <= end; page++) {
    if (!present.has(page)) missing.push(page)
  }
  return missing
}

function getExistingTargetNames(mangaDir, chapters) {
  const existing = new Map()
  for (const chapter of chapters) {
    const chapterDir = path.join(mangaDir, chapter)
    if (!fs.existsSync(chapterDir)) continue
    if (!fs.statSync(chapterDir).isDirectory()) {
      existing.set(chapter, null)
      continue
    }
    const names = new Set(
      fs.readdirSync(chapterDir).map((name) =>
        process.platform === 'win32' ? name.toLowerCase() : name
      )
    )
    existing.set(chapter, names)
  }
  return existing
}

function readExpectedImageCount(mangaDir, sources) {
  const metaFile = path.join(mangaDir, '.smanga', 'meta.json')
  if (!fs.existsSync(metaFile)) return null

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (!Array.isArray(meta.chapters)) return null
    const countByName = new Map()
    for (const chapter of meta.chapters) {
      const name = typeof chapter?.name === 'string' ? chapter.name : ''
      const count = Number(chapter?.imageNum)
      if (name && Number.isInteger(count) && count >= 0) countByName.set(name, count)
    }

    const sourceNames = sources
      .filter((source) => normalizeDestinationKey(source.directory) !== normalizeDestinationKey(mangaDir))
      .map((source) => path.basename(source.directory))
    if (sourceNames.length > 0 && sourceNames.every((name) => countByName.has(name))) {
      return sourceNames.reduce((total, name) => total + countByName.get(name), 0)
    }

    // 兼容元数据名称曾被错误编码、但整部漫画确实只有一个来源的旧数据。
    if (sources.length === 1 && meta.chapters.length === 1) {
      const count = Number(meta.chapters[0]?.imageNum)
      return Number.isInteger(count) && count >= 0 ? count : null
    }
    return null
  } catch {
    return null
  }
}

function preferMetadataSources(mangaDir, sources, excludedSources) {
  if (sources.length < 2) return sources
  const metaFile = path.join(mangaDir, '.smanga', 'meta.json')
  if (!fs.existsSync(metaFile)) return sources

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (!Array.isArray(meta.chapters)) return sources
    const metaNames = new Set(
      meta.chapters
        .map((chapter) => chapter?.name)
        .filter((name) => typeof name === 'string' && name)
    )
    const preferred = sources.filter((source) => metaNames.has(path.basename(source.directory)))
    if (preferred.length === 0 || preferred.length === sources.length) return sources

    const preferredKeys = new Set(
      preferred.map((source) => normalizeDestinationKey(source.directory))
    )
    for (const source of sources) {
      if (preferredKeys.has(normalizeDestinationKey(source.directory))) continue
      excludedSources.push({
        ...source,
        reason: '存在多个可识别版本，优先采用 .smanga/meta.json 当前记录的版本',
      })
    }
    return preferred
  } catch {
    return sources
  }
}

function findDeclaredChapterRange(sources) {
  const rangePattern = /(\d+)\s*[-~～—至到]\s*(\d+)\s*(?:話|话|章)/i
  for (const source of sources) {
    const match = path.basename(source.directory).match(rangePattern)
    if (match) return { start: Number(match[1]), end: Number(match[2]) }
  }
  return null
}

function createPrefixedNamePattern(prefixDigits, chapterDigits, pageDigits) {
  return new RegExp(
    `^\\d{${prefixDigits}}(\\d{${chapterDigits}})(\\d{${pageDigits}})(.*)$`
  )
}

function isAuxiliaryPage(pageNumber, suffix) {
  return pageNumber >= 500 && /[^0-9]/.test(suffix)
}

function calculatePrefixScore(sources, prefixDigits, options, declaredRange) {
  const pattern = createPrefixedNamePattern(
    prefixDigits,
    options.chapterDigits,
    options.pageDigits
  )
  const groups = new Map()
  let matchedCount = 0
  let withinDeclaredCount = 0
  const standardPattern = createPrefixedNamePattern(
    0,
    options.chapterDigits,
    options.pageDigits
  )
  const standardMatchedCount = sources.reduce(
    (total, source) => total + source.imageFiles.filter((entry) =>
      standardPattern.test(path.parse(entry.name).name)
    ).length,
    0
  )

  for (const source of sources) {
    for (const entry of source.imageFiles) {
      const stem = path.parse(entry.name).name
      const match = stem.match(pattern)
      if (!match) continue
      const chapterNumber = Number(match[1])
      const pageNumber = Number(match[2])
      const suffix = match[3]
      matchedCount++
      if (
        declaredRange
        && chapterNumber >= declaredRange.start
        && chapterNumber <= declaredRange.end + 5
      ) {
        withinDeclaredCount++
      }
      if (isAuxiliaryPage(pageNumber, suffix)) continue
      const pages = groups.get(match[1]) || []
      pages.push(pageNumber)
      groups.set(match[1], pages)
    }
  }

  let missingCount = 0
  for (const pages of groups.values()) missingCount += getMissingPages(pages).length
  const coverage = standardMatchedCount === 0 ? 0 : matchedCount / standardMatchedCount
  const withinRatio = declaredRange && matchedCount > 0
    ? withinDeclaredCount / matchedCount
    : 0.5
  const missingRatio = matchedCount + missingCount === 0
    ? 1
    : missingCount / (matchedCount + missingCount)
  const score = coverage * 2 + withinRatio * 2 - missingRatio - prefixDigits * 0.01
  return { prefixDigits, pattern, matchedCount, coverage, missingCount, score }
}

function inferPrefixFormat(sources, options) {
  if (options.prefixDigits !== 'auto') {
    return calculatePrefixScore(
      sources,
      options.prefixDigits,
      options,
      findDeclaredChapterRange(sources)
    )
  }

  const declaredRange = findDeclaredChapterRange(sources)
  const candidates = [0, 1, 2, 3].map((prefixDigits) =>
    calculatePrefixScore(sources, prefixDigits, options, declaredRange)
  )
  const standard = candidates[0]
  const eligible = candidates.filter((candidate) =>
    candidate.prefixDigits === 0
      || candidate.coverage >= AUTO_SOURCE_MIN_RECOGNIZED_RATIO
  )
  eligible.sort((left, right) => right.score - left.score)
  const best = eligible[0] || standard
  return best.prefixDigits > 0 && best.score >= standard.score + 0.25 ? best : standard
}

function buildSequentialPrefixChapterMap(sources, prefixFormat) {
  const offsets = new Map()
  if (prefixFormat.prefixDigits === 0) return { offsets, ranges: [] }

  const statsByPrefix = new Map()
  for (const source of sources) {
    for (const entry of source.imageFiles) {
      const stem = path.parse(entry.name).name
      const match = stem.match(prefixFormat.pattern)
      if (!match) continue
      const prefix = stem.slice(0, prefixFormat.prefixDigits)
      const chapter = Number(match[1])
      const stats = statsByPrefix.get(prefix) || {
        prefix,
        minChapter: chapter,
        maxChapter: chapter,
      }
      stats.minChapter = Math.min(stats.minChapter, chapter)
      stats.maxChapter = Math.max(stats.maxChapter, chapter)
      statsByPrefix.set(prefix, stats)
    }
  }

  const parts = [...statsByPrefix.values()].sort((left, right) =>
    left.prefix.localeCompare(right.prefix, 'en', { numeric: true })
  )
  if (parts.length <= 1) {
    for (const part of parts) offsets.set(part.prefix, 0)
    return { offsets, ranges: [] }
  }

  const ranges = []
  let previousTargetEnd = null
  for (const part of parts) {
    // 已经使用全局连续话号的后续分部保持原号；只有话号从头重置并与
    // 前一分部重叠时，才顺延到下一话。这样也能保留原始编号中的空档。
    const targetStart = previousTargetEnd === null
      ? part.minChapter
      : Math.max(part.minChapter, previousTargetEnd + 1)
    const offset = targetStart - part.minChapter
    const targetEnd = part.maxChapter + offset
    offsets.set(part.prefix, offset)
    ranges.push({ ...part, targetStart, targetEnd, offset })
    previousTargetEnd = targetEnd
  }
  return { offsets, ranges }
}

function readDirectoryVersion(directoryName) {
  const match = directoryName.match(/v(\d+)\s*$/i)
  if (!match) return null
  const version = Number(match[1])
  return Number.isInteger(version) && version >= 2 ? version : null
}

function resolveOutputMangaIdentity(mangaDir, sources) {
  const mangaName = path.basename(mangaDir)
  const rootVersion = readDirectoryVersion(mangaName)
  const versions = [rootVersion]
  for (const source of sources) {
    versions.push(readDirectoryVersion(path.basename(source.directory)))
  }
  const sourceVersion = Math.max(0, ...versions.filter((version) => version !== null))
  if (sourceVersion < 2) return { outputMangaName: mangaName, sourceVersion: null }

  if (rootVersion !== null) {
    const outputMangaName = mangaName.replace(/v\d+\s*$/i, `v${sourceVersion}`)
    return { outputMangaName, sourceVersion }
  }
  return { outputMangaName: `${mangaName} v${sourceVersion}`, sourceVersion }
}

export function buildPlan(mangaDir, sources, options, excludedSources = []) {
  const prefixFormat = inferPrefixFormat(sources, options)
  const namePattern = prefixFormat.pattern
  const prefixChapterMap = buildSequentialPrefixChapterMap(sources, prefixFormat)
  const zeroSpecialPattern = createZeroSpecialPattern(options.pageDigits)
  const outputIdentity = resolveOutputMangaIdentity(mangaDir, sources)
  const outputMangaDir = path.join(options.outputDir, outputIdentity.outputMangaName)
  validateSeparateOutputPath(mangaDir, outputMangaDir)
  const sourceMetaDir = path.join(mangaDir, '.smanga')
  const targetMetaDir = path.join(outputMangaDir, '.smanga')
  const shouldCopyMeta = fs.existsSync(sourceMetaDir) && fs.statSync(sourceMetaDir).isDirectory()
  const operations = []
  const unmatched = []
  const extraOperations = []
  const coverCandidates = []
  const groups = new Map()

  for (const source of sources) {
    for (const entry of source.imageFiles) {
      const extension = path.extname(entry.name)
      const stem = path.basename(entry.name, extension)
      const match = stem.match(namePattern)
      const isZeroSpecial = zeroSpecialPattern.test(stem)
      const sourceFile = path.join(source.directory, entry.name)

      if (!match && !isZeroSpecial) {
        unmatched.push(sourceFile)
        if (options.unmatchedMode === 'extras') {
          const targetDir = path.join(outputMangaDir, '_extras')
          const targetFile = path.join(targetDir, entry.name)
          const operation = {
            sourceFile,
            targetDir,
            targetFile,
            chapter: '_extras',
            page: '',
            pageNumber: null,
            suffix: '',
            auxiliary: true,
            extra: true,
          }
          operations.push(operation)
          extraOperations.push(operation)
        }
        continue
      }

      const sourcePrefix = match && prefixFormat.prefixDigits > 0
        ? stem.slice(0, prefixFormat.prefixDigits)
        : ''
      const chapterNumber = match
        ? Number(match[1]) + (prefixChapterMap.offsets.get(sourcePrefix) || 0)
        : 0
      const chapter = match
        ? String(chapterNumber).padStart(options.chapterDigits, '0')
        : '0'.repeat(options.chapterDigits)
      const page = match ? match[2] : '0'.repeat(options.pageDigits)
      const suffix = match ? match[3] : stem.slice(options.pageDigits)
      // 只有不具备完整“话号 + 页码”编码的全零特殊文件才是封面。
      // 完整编码的 000001 等文件属于第 000 话，必须保留章节。
      const isCover = !match && isZeroSpecial
      if (isCover) {
        coverCandidates.push({ sourceFile, sourceName: entry.name })
        continue
      }

      const targetName = `${page}${suffix}${extension}`
      const targetDir = path.join(outputMangaDir, chapter)
      const targetFile = path.join(targetDir, targetName)
      const pageNumber = Number(page)
      const auxiliary = isAuxiliaryPage(pageNumber, suffix)
      operations.push({
        sourceFile,
        targetDir,
        targetFile,
        chapter,
        page,
        pageNumber,
        suffix,
        auxiliary,
      })

      const group = groups.get(chapter) || {
        chapter,
        operations: [],
        pages: [],
        auxiliaryCount: 0,
      }
      group.operations.push(operations[operations.length - 1])
      if (auxiliary) {
        group.auxiliaryCount++
      } else {
        group.pages.push(pageNumber)
      }
      groups.set(chapter, group)
    }
  }

  const occupiedCoverNames = new Set()
  if (shouldCopyMeta) {
    for (const entry of fs.readdirSync(sourceMetaDir, { withFileTypes: true })) {
      if (entry.isFile()) occupiedCoverNames.add(entry.name.toLowerCase())
    }
  }
  const coverOperations = []
  coverCandidates.sort((left, right) =>
    left.sourceFile.localeCompare(right.sourceFile, 'zh-CN', { numeric: true })
  )
  let coverNumber = 1
  for (const candidate of coverCandidates) {
    let targetName
    do {
      targetName = coverNumber === 1 ? 'cover.jpg' : `cover${coverNumber}.jpg`
      coverNumber++
    } while (occupiedCoverNames.has(targetName.toLowerCase()))
    occupiedCoverNames.add(targetName.toLowerCase())
    coverOperations.push({
      ...candidate,
      targetDir: targetMetaDir,
      targetFile: path.join(targetMetaDir, targetName),
      targetName,
    })
  }

  let fallbackCoverOperation = null
  if (!occupiedCoverNames.has('cover.jpg') && groups.size > 0) {
    const orderedGroups = [...groups.values()].sort((left, right) =>
      left.chapter.localeCompare(right.chapter, 'en', { numeric: true })
    )
    const firstChapter = orderedGroups.find((group) => Number(group.chapter) > 0)
      || orderedGroups[0]
    const firstPage = [...firstChapter.operations].sort((left, right) => {
      if (left.pageNumber !== right.pageNumber) return left.pageNumber - right.pageNumber
      return path.basename(left.targetFile).localeCompare(
        path.basename(right.targetFile),
        'en',
        { numeric: true }
      )
    })[0]
    fallbackCoverOperation = {
      sourceFile: firstPage.targetFile,
      sourceChapter: firstChapter.chapter,
      sourceName: path.basename(firstPage.targetFile),
      targetDir: targetMetaDir,
      targetFile: path.join(targetMetaDir, 'cover.jpg'),
      targetName: 'cover.jpg',
      fallback: true,
    }
  }

  const targetChapterNames = new Set(groups.keys())
  if (extraOperations.length > 0) targetChapterNames.add('_extras')
  const existingByChapter = getExistingTargetNames(outputMangaDir, targetChapterNames)
  const seenDestinations = new Map()
  const conflicts = []
  for (const operation of operations) {
    const key = normalizeDestinationKey(operation.targetFile)
    const previous = seenDestinations.get(key)
    if (previous) {
      conflicts.push({ type: '计划目标重复', operation, previous })
    } else {
      seenDestinations.set(key, operation)
    }

    const existing = existingByChapter.get(operation.chapter)
    if (existing === null) {
      conflicts.push({ type: '目标章节路径已被文件占用', operation })
    } else if (existing) {
      const targetName = path.basename(operation.targetFile)
      const lookupName = process.platform === 'win32' ? targetName.toLowerCase() : targetName
      if (existing.has(lookupName) && normalizeDestinationKey(operation.sourceFile) !== key) {
        conflicts.push({ type: '目标文件已存在', operation })
      }
    }
  }

  const needsTargetMeta = shouldCopyMeta
    || coverOperations.length > 0
    || fallbackCoverOperation !== null
  if (needsTargetMeta && fs.existsSync(targetMetaDir)) {
    conflicts.push({
      type: '目标元数据目录已存在',
      operation: { targetFile: targetMetaDir },
    })
  }

  for (const group of groups.values()) {
    group.uniquePages = [...new Set(group.pages)].sort((left, right) => left - right)
    group.missingPages = getMissingPages(group.pages)
  }

  const zipOperations = options.zipChapters
    ? [...groups.values()].map((group) => ({
      chapter: group.chapter,
      sourceDir: path.join(outputMangaDir, group.chapter),
      targetFile: path.join(outputMangaDir, `${group.chapter}.zip`),
      operations: group.operations,
    }))
    : []
  for (const zipOperation of zipOperations) {
    if (fs.existsSync(zipOperation.targetFile)) {
      conflicts.push({
        type: '目标章节压缩包已存在',
        operation: { targetFile: zipOperation.targetFile },
      })
    }
  }

  const declaredRange = findDeclaredChapterRange(sources)
  const numericChapters = [...groups.keys()]
    .map(Number)
    .filter((chapter) => Number.isInteger(chapter) && chapter > 0)
    .sort((left, right) => left - right)
  const outsideDeclaredRange = declaredRange
    ? numericChapters.filter(
      (chapter) => chapter < declaredRange.start || chapter > declaredRange.end
    )
    : []

  return {
    mangaDir,
    outputMangaDir,
    sourceVersion: outputIdentity.sourceVersion,
    sourceMetaDir,
    targetMetaDir,
    shouldCopyMeta,
    needsTargetMeta,
    sources,
    excludedSources,
    prefixDigits: prefixFormat.prefixDigits,
    prefixChapterRanges: prefixChapterMap.ranges,
    operations,
    unmatched,
    extraOperations,
    coverOperations,
    fallbackCoverOperation,
    zipOperations,
    conflicts,
    groups: [...groups.values()].sort((left, right) =>
      left.chapter.localeCompare(right.chapter, 'en', { numeric: true })
    ),
    declaredRange,
    outsideDeclaredRange,
    expectedImageCount: readExpectedImageCount(mangaDir, sources),
  }
}

function formatNumberList(numbers, width, limit = 20) {
  const shown = numbers.slice(0, limit).map((number) => String(number).padStart(width, '0'))
  if (numbers.length > limit) shown.push(`…另 ${numbers.length - limit} 个`)
  return shown.join(', ')
}

function relativeDisplay(root, target) {
  const relative = path.relative(root, target)
  return relative || '.'
}

export function printPlan(plan, options, output = console) {
  const allMissing = plan.groups.flatMap((group) => group.missingPages)
  const mode = options.execute
    ? '执行'
    : options.reportWritten
      ? '预览（仅更新检查报告，不传输图片）'
      : '预览（未修改文件）'
  output.log(`漫画目录: ${plan.mangaDir}`)
  output.log(`输出目录: ${plan.outputMangaDir}`)
  if (plan.sourceVersion !== null) output.log(`来源版本: v${plan.sourceVersion}`)
  output.log(`模式:     ${mode}`)
  output.log(`文件处理: ${options.transferMode === 'move' ? '移动（move）' : '复制（copy）'}`)
  output.log(`章节压缩: ${options.zipChapters ? '启用（ZIP 校验后删除输出章节散图）' : '关闭'}`)
  output.log(`前置分卷位数: ${plan.prefixDigits}${options.prefixDigits === 'auto' ? '（自动推断）' : '（手动指定）'}`)
  output.log(`识别格式: ${options.chapterDigits} 位话号 + ${options.pageDigits} 位页码 + 可选后缀`)
  if (plan.prefixChapterRanges.length > 0) {
    output.log('分部话号展开:')
    for (const range of plan.prefixChapterRanges) {
      const sourceRange = `${String(range.minChapter).padStart(options.chapterDigits, '0')}-${String(range.maxChapter).padStart(options.chapterDigits, '0')}`
      const targetRange = `${String(range.targetStart).padStart(options.chapterDigits, '0')}-${String(range.targetEnd).padStart(options.chapterDigits, '0')}`
      output.log(`  - 前缀 ${range.prefix}: ${sourceRange} -> ${targetRange}`)
    }
  }
  output.log('图片源:')
  for (const source of plan.sources) {
    const recognition = Number.isInteger(source.recognizedCount)
      ? `（可识别 ${source.recognizedCount}/${source.imageFiles.length}）`
      : ''
    output.log(`  - ${relativeDisplay(plan.mangaDir, source.directory)}${recognition}`)
  }

  if (plan.excludedSources.length > 0) {
    output.log('自动排除目录:')
    for (const source of plan.excludedSources) {
      const count = source.imageFiles.length > 0
        ? `，图片 ${source.imageFiles.length}，编码命中 ${source.matchedCount}`
        : ''
      output.log(
        `  - ${relativeDisplay(plan.mangaDir, source.directory)}：${source.reason}${count}`
      )
    }
  }

  output.log('')
  const recognizedImageCount = plan.operations.length
    - plan.extraOperations.length
    + plan.coverOperations.length
  output.log(`识别图片: ${recognizedImageCount}`)
  output.log(`封面图片: ${plan.coverOperations.length}`)
  output.log(`首话封面兜底: ${plan.fallbackCoverOperation ? '需要' : '不需要'}`)
  output.log(`非章节附件: ${plan.unmatched.length}`)
  if (plan.unmatched.length > 0) {
    output.log(`附件处理: ${options.unmatchedMode}`)
  }
  output.log(`章节分组: ${plan.groups.length}`)
  output.log(`目标冲突: ${plan.conflicts.length}`)
  if (plan.expectedImageCount !== null) {
    const currentImageCount = recognizedImageCount + plan.unmatched.length
    const difference = currentImageCount - plan.expectedImageCount
    output.log(
      `元数据图片数: ${plan.expectedImageCount}（当前图片 ${currentImageCount}，差值 ${difference >= 0 ? '+' : ''}${difference}）`
    )
  }

  output.log('')
  output.log('分组详情:')
  for (const group of plan.groups) {
    const minPage = group.uniquePages[0]
    const maxPage = group.uniquePages[group.uniquePages.length - 1]
    const range = minPage === undefined
      ? '-'
      : `${String(minPage).padStart(options.pageDigits, '0')}-${String(maxPage).padStart(options.pageDigits, '0')}`
    const gap = group.missingPages.length
      ? `，缺页 ${formatNumberList(group.missingPages, options.pageDigits)}`
      : ''
    const auxiliary = group.auxiliaryCount > 0 ? `，附加页 ${group.auxiliaryCount}` : ''
    output.log(`  ${group.chapter}: ${group.operations.length} 张，页码 ${range}${gap}${auxiliary}`)
  }

  if (plan.coverOperations.length > 0) {
    output.log('')
    output.log('封面归档:')
    for (const cover of plan.coverOperations) {
      output.log(
        `  ${relativeDisplay(plan.mangaDir, cover.sourceFile)} -> .smanga\\${cover.targetName}`
      )
    }
  }

  if (plan.fallbackCoverOperation) {
    output.log('')
    output.log('首话封面兜底:')
    output.log(
      `  ${plan.fallbackCoverOperation.sourceChapter}\\${plan.fallbackCoverOperation.sourceName} -> .smanga\\cover.jpg`
    )
  }

  if (plan.declaredRange && plan.outsideDeclaredRange.length > 0) {
    output.log('')
    output.warn(
      `警告: 源目录名称声明 ${plan.declaredRange.start}-${plan.declaredRange.end} 话，` +
      `但还检测到话号 ${formatNumberList(plan.outsideDeclaredRange, options.chapterDigits)}；这些图片会保留并照常分组。`
    )
  }

  if (allMissing.length > 0) {
    output.log('')
    output.warn(`警告: 共检测到 ${allMissing.length} 个缺失页码。`)
  }

  if (plan.unmatched.length > 0) {
    output.log('')
    const action = options.unmatchedMode === 'extras'
      ? '将按原文件名归档到 _extras'
      : options.unmatchedMode === 'skip'
        ? '将留在源目录，不处理'
        : '严格模式下会阻塞执行'
    output.warn(`无法按章节识别的图片（${action}）:`)
    for (const file of plan.unmatched.slice(0, 20)) {
      output.warn(`  - ${relativeDisplay(plan.mangaDir, file)}`)
    }
    if (plan.unmatched.length > 20) output.warn(`  …另 ${plan.unmatched.length - 20} 张`)
  }

  if (plan.conflicts.length > 0) {
    output.log('')
    output.error('目标冲突:')
    for (const conflict of plan.conflicts.slice(0, 20)) {
      output.error(
        `  - [${conflict.type}] ${conflict.operation.targetFile}`
      )
    }
    if (plan.conflicts.length > 20) output.error(`  …另 ${plan.conflicts.length - 20} 项`)
  }
}

function validateExecution(plan, options) {
  if (plan.operations.length + plan.coverOperations.length === 0) fail('没有可整理的图片')
  if (plan.conflicts.length > 0) fail('存在目标冲突，为避免覆盖文件已停止执行')

  const missingCount = plan.groups.reduce(
    (total, group) => total + group.missingPages.length,
    0
  )
  if (missingCount > 0 && !options.allowGaps) {
    fail(`检测到 ${missingCount} 个缺失页码；核对后可加 --allow-gaps 执行`)
  }
  if (plan.unmatched.length > 0 && options.unmatchedMode === 'error') {
    fail(`有 ${plan.unmatched.length} 张图片无法识别；可改用 --unmatched-mode extras 或 skip`)
  }
}

function transferFile(sourceFile, targetFile, transferMode) {
  if (transferMode === 'copy') {
    fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL)
    return
  }

  try {
    fs.renameSync(sourceFile, targetFile)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL)
    try {
      fs.unlinkSync(sourceFile)
    } catch (unlinkError) {
      try {
        fs.unlinkSync(targetFile)
      } catch {
        // 目标副本无法清理时保留，后续错误信息会提示人工核对。
      }
      throw unlinkError
    }
  }
}

function copyDirectoryExclusive(sourceDir, targetDir) {
  fs.mkdirSync(targetDir)
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      copyDirectoryExclusive(sourcePath, targetPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
    } else {
      fail(`元数据目录包含不支持的特殊文件：${sourcePath}`)
    }
  }
}

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  CRC32_TABLE[index] = value >>> 0
}

function calculateCrc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) crc = CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function toDosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function writeAll(fd, buffer) {
  let written = 0
  while (written < buffer.length) {
    written += fs.writeSync(fd, buffer, written, buffer.length - written)
  }
}

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, position + read)
    if (count === 0) fail('ZIP 文件意外结束')
    read += count
  }
  return buffer
}

function calculateStoredEntryCrc(fd, length, position) {
  const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, length)))
  let remaining = length
  let offset = position
  let crc = 0xffffffff
  while (remaining > 0) {
    const requested = Math.min(chunk.length, remaining)
    const count = fs.readSync(fd, chunk, 0, requested, offset)
    if (count === 0) fail('ZIP 条目数据意外结束')
    for (let index = 0; index < count; index++) {
      crc = CRC32_TABLE[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8)
    }
    remaining -= count
    offset += count
  }
  return (crc ^ 0xffffffff) >>> 0
}

function verifyZipArchive(zipFile, expectedEntries) {
  const fd = fs.openSync(zipFile, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < 22) fail(`ZIP 校验失败，文件过小：${zipFile}`)
    const footer = readExactly(fd, 22, size - 22)
    if (footer.readUInt32LE(0) !== 0x06054b50) {
      fail(`ZIP 校验失败，缺少结束记录：${zipFile}`)
    }
    const entryCount = footer.readUInt16LE(10)
    const centralSize = footer.readUInt32LE(12)
    const centralOffset = footer.readUInt32LE(16)
    if (entryCount !== expectedEntries.length || centralOffset + centralSize + 22 !== size) {
      fail(`ZIP 校验失败，文件清单或长度不一致：${zipFile}`)
    }

    let position = centralOffset
    for (const expected of expectedEntries) {
      const header = readExactly(fd, 46, position)
      if (header.readUInt32LE(0) !== 0x02014b50) {
        fail(`ZIP 校验失败，中央目录损坏：${zipFile}`)
      }
      const nameLength = header.readUInt16LE(28)
      const extraLength = header.readUInt16LE(30)
      const commentLength = header.readUInt16LE(32)
      const name = readExactly(fd, nameLength, position + 46).toString('utf8')
      const crc = header.readUInt32LE(16)
      const compressedSize = header.readUInt32LE(20)
      const originalSize = header.readUInt32LE(24)
      if (
        name !== expected.name
        || crc !== expected.crc
        || compressedSize !== expected.size
        || originalSize !== expected.size
      ) {
        fail(`ZIP 校验失败，条目不一致：${zipFile} -> ${expected.name}`)
      }

      const localHeader = readExactly(fd, 30, expected.localOffset)
      const localNameLength = localHeader.readUInt16LE(26)
      const localExtraLength = localHeader.readUInt16LE(28)
      const localName = readExactly(
        fd,
        localNameLength,
        expected.localOffset + 30
      ).toString('utf8')
      const dataOffset = expected.localOffset + 30 + localNameLength + localExtraLength
      if (
        localHeader.readUInt32LE(0) !== 0x04034b50
        || localHeader.readUInt16LE(8) !== 0
        || localHeader.readUInt32LE(14) !== expected.crc
        || localHeader.readUInt32LE(18) !== expected.size
        || localHeader.readUInt32LE(22) !== expected.size
        || localName !== expected.name
        || calculateStoredEntryCrc(fd, expected.size, dataOffset) !== expected.crc
      ) {
        fail(`ZIP 校验失败，条目数据损坏：${zipFile} -> ${expected.name}`)
      }
      position += 46 + nameLength + extraLength + commentLength
    }
    if (position !== centralOffset + centralSize) {
      fail(`ZIP 校验失败，中央目录长度不一致：${zipFile}`)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function writeChapterZipExclusive(zipOperation) {
  if (fs.existsSync(zipOperation.targetFile)) {
    fail(`目标章节压缩包已存在：${zipOperation.targetFile}`)
  }
  if (zipOperation.operations.length > 0xffff) {
    fail(`章节图片超过 ZIP32 条目上限：${zipOperation.chapter}`)
  }

  const sortedOperations = [...zipOperation.operations].sort((left, right) =>
    path.basename(left.targetFile).localeCompare(
      path.basename(right.targetFile),
      'en',
      { numeric: true }
    )
  )
  const entries = []
  let fd = null
  let offset = 0
  try {
    fd = fs.openSync(zipOperation.targetFile, 'wx')
    for (const operation of sortedOperations) {
      const data = fs.readFileSync(operation.targetFile)
      if (data.length > 0xffffffff) fail(`单张图片超过 ZIP32 大小上限：${operation.targetFile}`)
      const name = path.basename(operation.targetFile)
      const encodedName = Buffer.from(name, 'utf8')
      if (encodedName.length > 0xffff) fail(`ZIP 内文件名过长：${operation.targetFile}`)
      const crc = calculateCrc32(data)
      const modified = toDosDateTime(fs.statSync(operation.targetFile).mtime)
      const localHeader = Buffer.alloc(30)
      localHeader.writeUInt32LE(0x04034b50, 0)
      localHeader.writeUInt16LE(20, 4)
      localHeader.writeUInt16LE(0x0800, 6)
      localHeader.writeUInt16LE(0, 8)
      localHeader.writeUInt16LE(modified.time, 10)
      localHeader.writeUInt16LE(modified.date, 12)
      localHeader.writeUInt32LE(crc, 14)
      localHeader.writeUInt32LE(data.length, 18)
      localHeader.writeUInt32LE(data.length, 22)
      localHeader.writeUInt16LE(encodedName.length, 26)
      writeAll(fd, localHeader)
      writeAll(fd, encodedName)
      writeAll(fd, data)
      entries.push({
        name,
        encodedName,
        crc,
        size: data.length,
        modified,
        localOffset: offset,
      })
      offset += localHeader.length + encodedName.length + data.length
      if (offset > 0xffffffff) fail(`章节压缩包超过 ZIP32 大小上限：${zipOperation.chapter}`)
    }

    const centralOffset = offset
    for (const entry of entries) {
      const centralHeader = Buffer.alloc(46)
      centralHeader.writeUInt32LE(0x02014b50, 0)
      centralHeader.writeUInt16LE(20, 4)
      centralHeader.writeUInt16LE(20, 6)
      centralHeader.writeUInt16LE(0x0800, 8)
      centralHeader.writeUInt16LE(0, 10)
      centralHeader.writeUInt16LE(entry.modified.time, 12)
      centralHeader.writeUInt16LE(entry.modified.date, 14)
      centralHeader.writeUInt32LE(entry.crc, 16)
      centralHeader.writeUInt32LE(entry.size, 20)
      centralHeader.writeUInt32LE(entry.size, 24)
      centralHeader.writeUInt16LE(entry.encodedName.length, 28)
      centralHeader.writeUInt32LE(entry.localOffset, 42)
      writeAll(fd, centralHeader)
      writeAll(fd, entry.encodedName)
      offset += centralHeader.length + entry.encodedName.length
    }
    const centralSize = offset - centralOffset
    if (offset + 22 > 0xffffffff) fail(`章节压缩包超过 ZIP32 大小上限：${zipOperation.chapter}`)

    const footer = Buffer.alloc(22)
    footer.writeUInt32LE(0x06054b50, 0)
    footer.writeUInt16LE(entries.length, 8)
    footer.writeUInt16LE(entries.length, 10)
    footer.writeUInt32LE(centralSize, 12)
    footer.writeUInt32LE(centralOffset, 16)
    writeAll(fd, footer)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    verifyZipArchive(zipOperation.targetFile, entries)
    return entries.length
  } catch (error) {
    if (fd !== null) fs.closeSync(fd)
    try {
      fs.unlinkSync(zipOperation.targetFile)
    } catch {
      // 目标不存在或无法清理时，由外层回滚信息提示人工核对。
    }
    throw error
  }
}

async function writeCoverJpegExclusive(coverOperation) {
  if (fs.existsSync(coverOperation.targetFile)) {
    fail(`目标封面已存在：${coverOperation.targetFile}`)
  }
  const extension = path.extname(coverOperation.sourceFile).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') {
    fs.copyFileSync(
      coverOperation.sourceFile,
      coverOperation.targetFile,
      fs.constants.COPYFILE_EXCL
    )
    return
  }

  const sourceBuffer = fs.readFileSync(coverOperation.sourceFile)
  await sharp(sourceBuffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92 })
    .toFile(coverOperation.targetFile)
}

export async function executePlan(plan, options) {
  validateExecution(plan, options)

  const createdDirectories = []
  const transferred = []
  const createdArchives = []
  let metadataStarted = false
  try {
    if (!fs.existsSync(plan.outputMangaDir)) {
      fs.mkdirSync(plan.outputMangaDir, { recursive: true })
      createdDirectories.push(plan.outputMangaDir)
    }

    const targetDirectories = new Set(plan.operations.map((operation) => operation.targetDir))
    for (const targetDir of targetDirectories) {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir)
        createdDirectories.push(targetDir)
      }
    }

    for (const [index, operation] of plan.operations.entries()) {
      transferFile(operation.sourceFile, operation.targetFile, options.transferMode)
      transferred.push(operation)
      if ((index + 1) % 500 === 0) {
        const action = options.transferMode === 'move' ? '移动' : '复制'
        console.log(`已${action} ${index + 1}/${plan.operations.length} 张…`)
      }
    }

    if (plan.needsTargetMeta) {
      metadataStarted = true
      if (plan.shouldCopyMeta) {
        copyDirectoryExclusive(plan.sourceMetaDir, plan.targetMetaDir)
      } else {
        fs.mkdirSync(plan.targetMetaDir)
      }
      for (const coverOperation of plan.coverOperations) {
        await writeCoverJpegExclusive(coverOperation)
      }
      if (plan.fallbackCoverOperation) {
        await writeCoverJpegExclusive(plan.fallbackCoverOperation)
      }
    }

    for (const [index, zipOperation] of plan.zipOperations.entries()) {
      writeChapterZipExclusive(zipOperation)
      createdArchives.push(zipOperation.targetFile)
      if ((index + 1) % 20 === 0 || index + 1 === plan.zipOperations.length) {
        console.log(`已打包并校验 ${index + 1}/${plan.zipOperations.length} 个章节 ZIP…`)
      }
    }
  } catch (error) {
    console.error(`执行中断，正在回滚已处理的 ${transferred.length} 张图片…`)
    const rollbackErrors = []
    for (const archive of createdArchives.reverse()) {
      try {
        fs.unlinkSync(archive)
      } catch (archiveRollbackError) {
        rollbackErrors.push(`${archive}: ${archiveRollbackError.message}`)
      }
    }
    if (metadataStarted && fs.existsSync(plan.targetMetaDir)) {
      try {
        fs.rmSync(plan.targetMetaDir, { recursive: true, force: true })
      } catch (metadataRollbackError) {
        rollbackErrors.push(`${plan.targetMetaDir}: ${metadataRollbackError.message}`)
      }
    }
    for (const operation of transferred.reverse()) {
      try {
        if (options.transferMode === 'move') {
          transferFile(operation.targetFile, operation.sourceFile, 'move')
        } else {
          fs.unlinkSync(operation.targetFile)
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${operation.targetFile}: ${rollbackError.message}`)
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        fs.rmdirSync(directory)
      } catch {
        // 目录非空时保留，避免删除任何未成功回滚的数据。
      }
    }
    if (rollbackErrors.length > 0) {
      console.error('以下文件未能自动回滚，请人工检查:')
      for (const message of rollbackErrors) console.error(`  - ${message}`)
    }
    throw error
  }

  let removedPackedImageCount = 0
  const packedImageCleanupFailures = []
  for (const zipOperation of plan.zipOperations) {
    for (const operation of zipOperation.operations) {
      try {
        fs.unlinkSync(operation.targetFile)
        removedPackedImageCount++
      } catch (error) {
        packedImageCleanupFailures.push(`${operation.targetFile}: ${error.message}`)
      }
    }
    try {
      if (fs.readdirSync(zipOperation.sourceDir).length === 0) {
        fs.rmdirSync(zipOperation.sourceDir)
      }
    } catch (error) {
      packedImageCleanupFailures.push(`${zipOperation.sourceDir}: ${error.message}`)
    }
  }
  if (packedImageCleanupFailures.length > 0) {
    console.warn(
      `章节 ZIP 已通过校验，但有 ${packedImageCleanupFailures.length} 个散图或目录未能清理：`
    )
    for (const message of packedImageCleanupFailures.slice(0, 20)) {
      console.warn(`  - ${message}`)
    }
    if (packedImageCleanupFailures.length > 20) {
      console.warn(`  …另 ${packedImageCleanupFailures.length - 20} 项`)
    }
  }

  if (options.transferMode === 'move') {
    for (const coverOperation of plan.coverOperations) {
      try {
        fs.unlinkSync(coverOperation.sourceFile)
      } catch (error) {
        console.warn(`封面已写入输出目录，但未能移除源封面 ${coverOperation.sourceFile}：${error.message}`)
      }
    }
  }

  const removedSources = []
  if (options.transferMode === 'move' && !options.keepEmptySource) {
    for (const source of plan.sources) {
      if (normalizeDestinationKey(source.directory) === normalizeDestinationKey(plan.mangaDir)) continue
      try {
        if (fs.readdirSync(source.directory).length === 0) {
          fs.rmdirSync(source.directory)
          removedSources.push(source.directory)
        }
      } catch (error) {
        console.warn(`未移除源目录 ${source.directory}：${error.message}`)
      }
    }
  }

  return {
    processedCount: transferred.length + plan.coverOperations.length,
    copiedCount: options.transferMode === 'copy'
      ? transferred.length + plan.coverOperations.length
      : 0,
    movedCount: options.transferMode === 'move'
      ? transferred.length + plan.coverOperations.length
      : 0,
    coverCount: plan.coverOperations.length,
    fallbackCoverCreated: plan.fallbackCoverOperation !== null,
    zipCount: plan.zipOperations.length,
    removedPackedImageCount,
    packedImageCleanupFailures,
    metadataCopied: plan.shouldCopyMeta,
    removedSources,
  }
}

function prepareMangaPlan(mangaDir, options) {
  const namePattern = createNamePattern(options.chapterDigits, options.pageDigits)
  const zeroSpecialPattern = createZeroSpecialPattern(options.pageDigits)
  let sources
  let excludedSources
  if (options.sources.length > 0) {
    sources = resolveExplicitSources(
      mangaDir,
      options.sources,
      namePattern,
      zeroSpecialPattern
    )
    excludedSources = []
  } else {
    const discovered = discoverSources(mangaDir, namePattern, zeroSpecialPattern)
    excludedSources = discovered.excludedSources
    sources = preferMetadataSources(mangaDir, discovered.sources, excludedSources)
  }

  if (sources.length === 0) {
    return { plan: null, excludedSources }
  }

  const plan = buildPlan(mangaDir, sources, options, excludedSources)
  return { plan, excludedSources }
}

function printSkippedManga(mangaDir, excludedSources, output = console) {
  output.log(`漫画目录: ${mangaDir}`)
  output.log('结果:     跳过（没有目录通过自动源目录筛选）')
  if (excludedSources.length > 0) {
    output.log('排除目录:')
    for (const source of excludedSources) {
      output.log(`  - ${relativeDisplay(mangaDir, source.directory)}：${source.reason}`)
    }
  }
}

function printPreviewFooter(plan, options, output = console, reportWritten = false) {
  output.log('')
  output.log(
    reportWritten
      ? '当前为预览模式，未复制或移动图片；本次仅写入检查报告。'
      : '当前为预览模式，未修改任何文件。确认报告后加 --execute 执行。'
  )
  if (
    !options.allowGaps
    && plan.groups.some((group) => group.missingPages.length > 0)
  ) {
    output.log('该目录存在缺页；确认仍要整理时还需加 --allow-gaps。')
  }
}

function createTextOutput() {
  const lines = []
  const append = (value = '') => lines.push(String(value))
  return {
    lines,
    output: {
      log: append,
      warn: append,
      error: append,
    },
  }
}

function writeBatchReport(mangaDir, status, renderDetails) {
  const { lines, output } = createTextOutput()
  output.log('漫画图片规整检查报告')
  output.log('='.repeat(72))
  output.log(`生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  output.log(`报告状态: ${status}`)
  output.log('')
  renderDetails(output)
  output.log('')
  output.log(`报告文件: ${path.join(mangaDir, BATCH_REPORT_FILE)}`)

  const reportPath = path.join(mangaDir, BATCH_REPORT_FILE)
  fs.writeFileSync(reportPath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8')
  return reportPath
}

function writePlanReport(plan, options, status, extraLines = []) {
  return writeBatchReport(plan.mangaDir, status, (output) => {
    printPlan(plan, { ...options, reportWritten: true }, output)
    for (const line of extraLines) output.log(line)
    if (!options.execute) printPreviewFooter(plan, options, output, true)
  })
}

function resolveMangaDirectories(options) {
  const targets = []
  for (const input of options.mangaDirs) {
    const inputDir = path.resolve(input)
    if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
      fail(`输入目录不存在或不是目录：${inputDir}`)
    }

    if (!options.batch) {
      targets.push(inputDir)
      continue
    }

    for (const entry of readDirectoryEntries(inputDir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      targets.push(path.join(inputDir, entry.name))
    }
  }

  const uniqueTargets = new Map()
  for (const target of targets) uniqueTargets.set(normalizeDestinationKey(target), target)
  return [...uniqueTargets.values()].sort((left, right) =>
    left.localeCompare(right, 'zh-CN', { numeric: true })
  )
}

async function runSingleManga(mangaDir, options) {
  const prepared = prepareMangaPlan(mangaDir, options)
  if (!prepared.plan) {
    printSkippedManga(mangaDir, prepared.excludedSources)
    fail('没有目录通过自动源目录筛选；可查看排除原因，或用 --source 明确指定')
  }

  const plan = prepared.plan
  printPlan(plan, options)

  if (!options.execute) {
    printPreviewFooter(plan, options)
    return
  }

  const result = await executePlan(plan, options)
  console.log('')
  const action = options.transferMode === 'move' ? '移动' : '复制'
  console.log(`整理完成：已${action} ${result.processedCount} 张图片。`)
  if (result.fallbackCoverCreated) console.log('封面兜底：已用首话第一张图生成 .smanga\\cover.jpg。')
  if (result.zipCount > 0) {
    console.log(
      `章节压缩：已生成并校验 ${result.zipCount} 个 ZIP，删除 ${result.removedPackedImageCount} 张输出散图。`
    )
  }
  for (const source of result.removedSources) {
    console.log(`已移除空源目录：${relativeDisplay(mangaDir, source)}`)
  }
}

async function runMangaBatch(mangaDirs, options) {
  console.log(`批量模式: ${options.execute ? '执行（先统一预检）' : '预览'}`)
  console.log(`输出根目录: ${options.outputDir}`)
  console.log(`文件处理: ${options.transferMode === 'move' ? '移动（move）' : '复制（copy）'}`)
  console.log(`章节压缩: ${options.zipChapters ? '启用' : '关闭'}`)
  console.log(`待检查漫画目录: ${mangaDirs.length}`)
  console.log(`每部漫画报告: ${BATCH_REPORT_FILE}`)

  const plans = []
  const skipped = []
  const failures = []
  const blockers = []

  for (const [index, mangaDir] of mangaDirs.entries()) {
    console.log(`[检查 ${index + 1}/${mangaDirs.length}] ${mangaDir}`)

    try {
      const prepared = prepareMangaPlan(mangaDir, options)
      if (!prepared.plan) {
        const reportPath = writeBatchReport(
          mangaDir,
          '跳过：没有目录通过自动源目录筛选',
          (output) => printSkippedManga(mangaDir, prepared.excludedSources, output)
        )
        skipped.push({ mangaDir, reportPath })
        console.log(`  跳过；报告已写入 ${reportPath}`)
        continue
      }

      plans.push(prepared.plan)
      console.log(`  已识别 ${prepared.plan.operations.length} 张图片，等待统一预检`)
    } catch (error) {
      let reportPath = ''
      try {
        reportPath = writeBatchReport(mangaDir, '检查失败', (output) => {
          output.log(`漫画目录: ${mangaDir}`)
          output.error(`错误: ${error.message}`)
        })
      } catch (reportError) {
        error.message += `；同时无法写入报告：${reportError.message}`
      }
      failures.push({ mangaDir, error, reportPath })
      console.error(`  检查失败: ${error.message}${reportPath ? `；报告 ${reportPath}` : ''}`)
    }
  }

  const plansByOutput = new Map()
  for (const plan of plans) {
    const key = normalizeDestinationKey(plan.outputMangaDir)
    const sameOutputPlans = plansByOutput.get(key) || []
    sameOutputPlans.push(plan)
    plansByOutput.set(key, sameOutputPlans)
  }
  for (const sameOutputPlans of plansByOutput.values()) {
    if (sameOutputPlans.length < 2) continue
    for (const plan of sameOutputPlans) {
      plan.conflicts.push({
        type: '批量输入中存在同名漫画，输出目录重复',
        operation: { targetFile: plan.outputMangaDir },
      })
    }
  }

  for (const plan of plans) {
    try {
      validateExecution(plan, options)
    } catch (error) {
      blockers.push({ mangaDir: plan.mangaDir, error })
    }
  }

  const blockerByManga = new Map(
    blockers.map((blocker) => [normalizeDestinationKey(blocker.mangaDir), blocker])
  )
  const batchCannotExecute = failures.length > 0 || blockers.length > 0
  for (const plan of plans) {
    const blocker = blockerByManga.get(normalizeDestinationKey(plan.mangaDir))
    let status
    if (blocker) {
      status = `预检阻塞：${blocker.error.message}`
    } else if (!options.execute) {
      status = '预检通过：当前为预览，未复制或移动图片'
    } else if (batchCannotExecute) {
      status = '自身预检通过，但批次中存在其他阻塞；整批未传输图片'
    } else {
      status = '批量预检通过，等待执行'
    }
    const extraLines = blocker ? ['', `阻塞原因: ${blocker.error.message}`] : []
    const reportPath = writePlanReport(plan, options, status, extraLines)
    console.log(
      `  ${blocker ? '阻塞' : '预检通过'}；报告已写入 ${reportPath}`
    )
  }

  console.log('')
  console.log(`${'='.repeat(72)}`)
  console.log('批量预检汇总')
  console.log(`${'='.repeat(72)}`)
  console.log(`  已识别: ${plans.length}`)
  console.log(`  预检通过: ${plans.length - blockers.length}`)
  console.log(`  跳过:   ${skipped.length}`)
  console.log(`  失败:   ${failures.length}`)
  console.log(`  阻塞:   ${blockers.length}`)

  if (!options.execute) {
    console.log('批量预览完成：未复制或移动图片，检查报告已写入各源漫画目录。')
    if (failures.length > 0) process.exitCode = 1
    return
  }

  if (failures.length > 0 || blockers.length > 0) {
    if (blockers.length > 0) {
      console.error('阻塞目录:')
      for (const blocker of blockers) {
        console.error(`  - ${blocker.mangaDir}: ${blocker.error.message}`)
      }
    }
    fail('批量预检未通过，整批未复制或移动任何图片')
  }

  let completed = 0
  let processedCount = 0
  for (const [index, plan] of plans.entries()) {
    console.log('')
    console.log(`[执行 ${index + 1}/${plans.length}] ${plan.mangaDir}`)
    try {
      const result = await executePlan(plan, options)
      completed++
      processedCount += result.processedCount
      const action = options.transferMode === 'move' ? '移动' : '复制'
      const extraLines = [
        '',
        `执行结果: 已${action} ${result.processedCount} 张图片`,
        `封面归档: ${result.coverCount} 张`,
        `首话封面兜底: ${result.fallbackCoverCreated ? '已生成 cover.jpg' : '不需要'}`,
        `章节压缩: ${result.zipCount > 0 ? `${result.zipCount} 个 ZIP` : '关闭'}`,
        `删除输出章节散图: ${result.removedPackedImageCount} 张`,
        `散图清理失败: ${result.packedImageCleanupFailures.length} 项`,
        ...result.packedImageCleanupFailures.map((message) => `  - ${message}`),
        `元数据复制: ${result.metadataCopied ? '是' : '否（源目录没有 .smanga）'}`,
        `移除空源目录: ${result.removedSources.length}`,
        ...result.removedSources.map((source) => `  - ${source}`),
      ]
      const reportPath = writePlanReport(plan, options, '执行完成', extraLines)
      console.log(`完成：${action} ${result.processedCount} 张图片；报告 ${reportPath}`)
    } catch (error) {
      try {
        writePlanReport(plan, options, `执行失败：${error.message}`, [
          '',
          `执行错误: ${error.message}`,
          '本漫画已尝试自动回滚；请结合上方检查信息核对目录。',
        ])
      } catch (reportError) {
        console.error(`写入失败报告时出错：${reportError.message}`)
      }
      for (const remainingPlan of plans.slice(index + 1)) {
        writePlanReport(
          remainingPlan,
          options,
          '未执行：前序漫画执行失败，已停止后续处理'
        )
      }
      console.error(`执行失败并已停止后续漫画：${error.message}`)
      break
    }
  }

  console.log('')
  const action = options.transferMode === 'move' ? '移动' : '复制'
  console.log(`批量执行完成：${completed}/${plans.length} 部，${action} ${processedCount} 张图片。`)
  if (completed !== plans.length) fail('批量执行未全部完成，请检查上方错误')
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    printHelp()
    return
  }
  if (options.mangaDirs.length === 0) {
    printHelp()
    fail('请提供至少一个漫画目录或漫画库根目录')
  }
  if (!options.outputDir) {
    printHelp()
    fail('请使用 --output 指定规整结果的输出根目录')
  }

  options.outputDir = path.resolve(options.outputDir)
  if (fs.existsSync(options.outputDir) && !fs.statSync(options.outputDir).isDirectory()) {
    fail(`输出根路径已存在且不是目录：${options.outputDir}`)
  }
  if (options.batch) {
    for (const input of options.mangaDirs) {
      const inputDir = path.resolve(input)
      if (isSameOrInside(options.outputDir, inputDir)) {
        fail(`批量输出根目录不能位于输入漫画库内部：${options.outputDir}`)
      }
    }
  }

  const mangaDirs = resolveMangaDirectories(options)
  if (mangaDirs.length === 0) fail('输入目录中没有可检查的漫画子目录')
  if (options.sources.length > 0 && (options.batch || mangaDirs.length !== 1)) {
    fail('--source 只能用于单部漫画，不能和多目录或 --batch 一起使用')
  }

  const isBatchRun = options.batch || mangaDirs.length > 1
  if (isBatchRun) {
    await runMangaBatch(mangaDirs, options)
  } else {
    await runSingleManga(mangaDirs[0], options)
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isDirectRun) {
  try {
    await main()
  } catch (error) {
    console.error(`错误: ${error.message}`)
    process.exitCode = 1
  }
}
