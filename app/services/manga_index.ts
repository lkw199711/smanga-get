import fs from 'node:fs'
import path from 'node:path'
import db from '@adonisjs/lucid/services/db'
import MangaResult from '#models/manga_result'
import MangaChapter from '#models/manga_chapter'
import { get_config, make_can_be_floder } from '#utils/index'

type JsonRecord = Record<string, any>

export type MangaChapterSummary = {
  name: string
  title?: string
  date?: string
  url?: string
  cover?: string
  isFree?: boolean
  price?: number
  imageCount?: number
  raw?: JsonRecord
}

export type MangaResultItem = {
  indexId: number
  key: string
  id?: number | string
  name: string
  website: string
  source?: string
  sourcePath?: string
  metaPath?: string
  coverToken?: string
  remoteCover?: string
  crawledAt: string
  updatedAt?: string
  finished: boolean
  status?: string
  chapterCount: number
  latestChapterName?: string
  latestChapterDate?: string
  author?: string
  description?: string
  tags: string[]
  chapters: MangaChapterSummary[]
}

export type MangaListOptions = {
  page?: number
  pageSize?: number
  keyword?: string
  website?: string
  status?: 'all' | 'serial' | 'finished'
}

export type MangaIndexSource = {
  website?: string
  source?: string
  sourcePath?: string
}

const mangaResultsTable = 'manga_results'
const mangaChaptersTable = 'manga_chapters'
const pathFields = ['downloadPath', 'compressPath', 'organizePath', 'cloudPath'] as const
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'])
const maxRecentChapters = 5

let schemaReady: Promise<void> | null = null

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPresentString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (isPresentString(value)) return value.trim()
  }

  return undefined
}

function pickNumber(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }

  return undefined
}

function pickId(meta: JsonRecord) {
  return meta.id ?? meta.targetId ?? meta.mangaId ?? meta.comicId ?? meta.series_id
}

function safeStat(filePath: string) {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function safeReadDir(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function normalizeAbsolutePath(filePath: string) {
  return path.resolve(filePath)
}

function isImageFile(filePath: string) {
  return imageExtensions.has(path.extname(filePath).toLocaleLowerCase())
}

function readJsonFile(filePath: string): JsonRecord | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) return null

    const json = JSON.parse(raw)
    return isRecord(json) ? json : null
  } catch {
    return null
  }
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return []

  try {
    const json = JSON.parse(value)
    return Array.isArray(json) ? json : []
  } catch {
    return []
  }
}

function normalizeDateValue(value: unknown) {
  if (value === null || value === undefined || value === '') return undefined

  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value < 10_000_000_000 ? value * 1000 : value
    return new Date(timestamp).toISOString()
  }

  if (!isPresentString(value)) return undefined

  const trimmed = value.trim()
  if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000).toISOString()
  if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed)).toISOString()

  const normalized = trimmed.replace(/[./]/g, '-')
  const parsed = Date.parse(normalized)

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed
}

function dateMs(value: unknown) {
  const normalized = normalizeDateValue(value)
  if (!normalized) return Number.NEGATIVE_INFINITY

  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function getRemoteCover(meta: JsonRecord) {
  return pickString(
    meta.cover,
    meta.verticalCover,
    meta.vertical_cover,
    meta.horizontalCover,
    meta.squareCover,
    meta.thumbnail,
    meta.banner
  )
}

function getMetaFolder(metaFile: string) {
  return path.dirname(metaFile)
}

function getMangaFolderFromMetaFolder(metaFolder: string) {
  if (path.basename(metaFolder) === '.smanga') return path.dirname(metaFolder)

  const basename = path.basename(metaFolder)
  if (basename.endsWith('-smanga-info')) {
    const sibling = path.join(path.dirname(metaFolder), basename.replace(/-smanga-info$/, ''))
    return safeStat(sibling)?.isDirectory() ? sibling : metaFolder
  }

  return metaFolder
}

function getFolderMangaName(metaFolder: string) {
  const folder = getMangaFolderFromMetaFolder(metaFolder)
  const name = path.basename(folder)

  return name.endsWith('-smanga-info') ? name.replace(/-smanga-info$/, '') : name
}

function findLocalCover(metaFolder: string) {
  const preferredNames = [
    'cover.jpg',
    'cover.jpeg',
    'cover.png',
    'cover.webp',
    'verticalCover.jpg',
    'verticalCover.png',
    'horizontalCover.jpg',
    'squareCover.jpg',
    'banner.jpg',
    'banner00.jpg',
  ]

  for (const fileName of preferredNames) {
    const filePath = path.join(metaFolder, fileName)
    if (safeStat(filePath)?.isFile()) return filePath
  }

  const imageFiles = safeReadDir(metaFolder)
    .filter((entry) => entry.isFile() && isImageFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const score = (fileName: string) => {
        const lower = fileName.toLocaleLowerCase()
        if (lower.includes('cover')) return 0
        if (lower.includes('banner')) return 1
        return 2
      }

      return score(a) - score(b) || a.localeCompare(b)
    })

  return imageFiles[0] ? path.join(metaFolder, imageFiles[0]) : undefined
}

function normalizeTags(meta: JsonRecord) {
  const tags = Array.isArray(meta.tags)
    ? meta.tags
    : Array.isArray(meta.genres)
      ? meta.genres
      : pickString(meta.classify, meta.genre, meta.category)?.split(/[,，/]/)

  if (!Array.isArray(tags)) return []

  return tags
    .map((tag) => (typeof tag === 'string' ? tag.trim() : String(tag ?? '').trim()))
    .filter(Boolean)
}

function normalizeFinished(meta: JsonRecord, status?: string) {
  if (typeof meta.finished === 'boolean') return meta.finished
  if (typeof meta.is_finish === 'number') return meta.is_finish === 1
  if (typeof meta.complete === 'boolean') return meta.complete

  const normalized = (status || '').toLocaleLowerCase()
  return ['completed', 'complete', 'finished', 'end', '完结', '完結', '已完结', '已完結'].some((value) =>
    normalized.includes(value)
  )
}

function normalizeChapter(chapter: unknown, index: number): MangaChapterSummary | null {
  if (!isRecord(chapter)) return null

  const name = pickString(
    chapter.name,
    chapter.title,
    chapter.chapter_title,
    chapter.chapter_name,
    chapter.chapterName
  )
  if (!name) return null

  const date = normalizeDateValue(
    chapter.date ?? chapter.createdAt ?? chapter.created_at ?? chapter.publishDate ?? chapter.pub_time
  )

  return {
    name,
    title: pickString(chapter.title, chapter.chapter_title),
    date,
    url: pickString(chapter.url, chapter.href),
    cover: pickString(chapter.cover, chapter.thumbnail, chapter.chapter_thumbnail),
    isFree: typeof chapter.isFree === 'boolean' ? chapter.isFree : undefined,
    price: pickNumber(chapter.price, chapter.payGold),
    imageCount: pickNumber(chapter.imageCount, chapter.imageNum, chapter.count, chapter.size),
    raw: { ...chapter, __index: index },
  }
}

function normalizeChapters(meta: JsonRecord) {
  const chapters = Array.isArray(meta.chapters)
    ? meta.chapters
    : Array.isArray(meta.ep_list)
      ? meta.ep_list
      : []

  return chapters
    .map((chapter, index) => normalizeChapter(chapter, index))
    .filter((chapter): chapter is MangaChapterSummary => Boolean(chapter))
}

function sortChaptersForLatest(chapters: MangaChapterSummary[]) {
  const hasDates = chapters.some((chapter) => Number.isFinite(dateMs(chapter.date)))

  if (hasDates) {
    return [...chapters].sort((a, b) => dateMs(b.date) - dateMs(a.date))
  }

  return [...chapters].reverse()
}

function findLatestChapter(chapters: MangaChapterSummary[]) {
  return sortChaptersForLatest(chapters)[0]
}

function countDownloadedChapters(sourcePath: string) {
  const stat = safeStat(sourcePath)
  if (!stat?.isDirectory()) return 0

  return safeReadDir(sourcePath).filter((entry) => {
    if (entry.name.startsWith('.')) return false
    if (entry.isDirectory()) return true
    return entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.zip')
  }).length
}

/**
 * 从章节列表中筛选出磁盘上实际存在的章节，仅写入已下载内容到库表
 */
function filterDownloadedChapters(
  chapters: MangaChapterSummary[],
  sourcePath: string
): MangaChapterSummary[] {
  if (!sourcePath || !fs.existsSync(sourcePath)) return chapters

  const entries = safeReadDir(sourcePath)
  const onDisk = new Set(
    entries
      .filter((e) => {
        if (e.name.startsWith('.')) return false
        if (e.isDirectory()) return true
        return e.isFile() && e.name.toLowerCase().endsWith('.zip')
      })
      .map((e) => e.name.replace(/\.zip$/i, ''))
  )
  if (onDisk.size === 0) return chapters

  return chapters.filter((ch) => onDisk.has(make_can_be_floder(ch.name)))
}

function getChapterOrder(chapter: MangaChapterSummary, fallback: number) {
  const rawOrder = pickNumber(chapter.raw?.ord, chapter.raw?.order, chapter.raw?.chapter_order)
  if (rawOrder !== undefined) return rawOrder

  const matched = chapter.name.match(/\d+(?:\.\d+)?/)
  if (matched) return Number.parseFloat(matched[0])

  return fallback
}

function buildIdentityKey(website: string, meta: JsonRecord, metaFile: string, name: string) {
  const id = pickId(meta)
  if (id !== null && id !== undefined && String(id).trim() !== '') {
    return `${website}:${String(id).trim()}`
  }

  return `${website}:path:${normalizeAbsolutePath(metaFile).toLocaleLowerCase()}:${name.toLocaleLowerCase()}`
}

function addAllowedRoot(roots: string[], root: unknown) {
  if (!isPresentString(root)) return
  roots.push(normalizeAbsolutePath(root))
}

function getAllowedRoots() {
  const config = get_config() || {}
  const roots: string[] = []

  for (const siteConfig of Object.values(config)) {
    if (!isRecord(siteConfig)) continue

    for (const field of pathFields) {
      addAllowedRoot(roots, siteConfig[field])
    }

    if (isPresentString(siteConfig.downloadPath)) {
      addAllowedRoot(roots, path.join(siteConfig.downloadPath, 'bilibili'))
    }
  }

  addAllowedRoot(roots, config.downloadPath)
  addAllowedRoot(roots, config.compressPath)

  const seen = new Set<string>()
  return roots.filter((root) => {
    const stat = safeStat(root)
    if (!stat?.isDirectory()) return false

    const realRoot = fs.realpathSync(root)
    const key = realRoot.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)

    return true
  })
}

function isInsideRoot(filePath: string, root: string) {
  const relative = path.relative(root, filePath)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function serializeRecentChapters(chapters: MangaChapterSummary[]) {
  return JSON.stringify(
    sortChaptersForLatest(chapters)
      .slice(0, maxRecentChapters)
      .map(({ raw, ...chapter }) => chapter)
  )
}

function rowToItem(row: MangaResult): MangaResultItem {
  const tags = parseJsonArray<string>(row.tagsJson)
  const chapters = parseJsonArray<MangaChapterSummary>(row.recentChaptersJson)

  return {
    indexId: row.id,
    key: row.identityKey,
    id: row.mangaId ?? undefined,
    name: row.name,
    website: row.website,
    source: row.source ?? undefined,
    sourcePath: row.sourcePath ?? undefined,
    metaPath: row.metaPath ?? undefined,
    coverToken: row.coverPath ? encodeMangaFileToken(row.coverPath) : undefined,
    remoteCover: row.remoteCover ?? undefined,
    crawledAt: row.crawledAt,
    updatedAt: row.updatedAtSite ?? row.latestChapterDate ?? undefined,
    finished: Boolean(row.finished),
    status: row.status ?? undefined,
    chapterCount: row.chapterCount,
    latestChapterName: row.latestChapterName ?? undefined,
    latestChapterDate: row.latestChapterDate ?? undefined,
    author: row.author ?? undefined,
    description: row.description ?? undefined,
    tags,
    chapters,
  }
}

async function createSchema() {
  const schema = db.connection().schema

  // ── manga_results 表 ──
  const hasMangaResults = await schema.hasTable(mangaResultsTable)
  if (!hasMangaResults) {
    console.log(`[manga-index] creating table: ${mangaResultsTable}`)
    await schema.createTable(mangaResultsTable, (table) => {
      table.increments('id')
      table.string('identity_key').notNullable().unique()
      table.string('website').notNullable().index()
      table.string('manga_id').nullable().index()
      table.string('name').notNullable().index()
      table.string('author').nullable()
      table.string('status').nullable()
      table.boolean('finished').notNullable().defaultTo(false).index()
      table.integer('chapter_count').notNullable().defaultTo(0)
      table.string('latest_chapter_name').nullable()
      table.string('latest_chapter_date').nullable().index()
      table.string('updated_at_site').nullable().index()
      table.string('crawled_at').notNullable().index()
      table.string('source').nullable()
      table.text('source_path').nullable()
      table.text('meta_path').nullable()
      table.text('cover_path').nullable()
      table.text('remote_cover').nullable()
      table.text('description').nullable()
      table.text('tags_json').nullable()
      table.text('recent_chapters_json').nullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  // ── manga_chapters 表 ──
  const hasMangaChapters = await schema.hasTable(mangaChaptersTable)
  if (!hasMangaChapters) {
    console.log(`[manga-index] creating table: ${mangaChaptersTable}`)
    await schema.createTable(mangaChaptersTable, (table) => {
      table.increments('id')
      table
        .integer('manga_result_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable(mangaResultsTable)
        .onDelete('CASCADE')
      table.string('name').notNullable()
      table.string('title').nullable()
      table.integer('chapter_order').nullable().index()
      table.string('date').nullable().index()
      table.text('url').nullable()
      table.text('cover').nullable()
      table.boolean('is_free').nullable()
      table.float('price').nullable()
      table.integer('image_count').nullable()
      table.text('raw_json').nullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
      table.index(['manga_result_id', 'date'])
      table.unique(['manga_result_id', 'name'])
    })
  }

  if (!hasMangaResults || !hasMangaChapters) {
    console.log(`[manga-index] schema ready (results=${hasMangaResults ? 'exists' : 'created'}, chapters=${hasMangaChapters ? 'exists' : 'created'})`)
  }
}

export async function ensureMangaIndexSchema() {
  schemaReady ??= createSchema().catch((error) => {
    schemaReady = null
    throw error
  })
  await schemaReady
}

export function encodeMangaFileToken(filePath: string) {
  return Buffer.from(filePath, 'utf-8').toString('base64url')
}

export function decodeMangaFileToken(token: string) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8')
    return decoded ? normalizeAbsolutePath(decoded) : null
  } catch {
    return null
  }
}

export function resolveAllowedMangaAsset(token: string) {
  const filePath = decodeMangaFileToken(token)
  if (!filePath || !isImageFile(filePath)) return null

  const stat = safeStat(filePath)
  if (!stat?.isFile()) return null

  const realFile = fs.realpathSync(filePath)
  const allowed = getAllowedRoots().some((root) => isInsideRoot(realFile, root))

  return allowed ? realFile : null
}

export async function indexMangaMetaFile(metaFile: string, source: MangaIndexSource = {}) {
  await ensureMangaIndexSchema()

  const normalizedMetaFile = normalizeAbsolutePath(metaFile)
  const meta = readJsonFile(normalizedMetaFile)
  const stat = safeStat(normalizedMetaFile)
  if (!meta || !stat?.isFile()) return null

  const metaFolder = getMetaFolder(normalizedMetaFile)
  const fallbackSourcePath = getMangaFolderFromMetaFolder(metaFolder)
  const sourcePath = source.sourcePath ? normalizeAbsolutePath(source.sourcePath) : fallbackSourcePath
  const folderName = getFolderMangaName(metaFolder)
  const website = source.website || pickString(meta.website) || 'local'
  const status = pickString(meta.status, meta.mangaStatus)
  const chapters = normalizeChapters(meta)
  // 只保留磁盘上实际存在的章节（目录或 zip），避免元数据全量污染库表
  const downloadedChapters = filterDownloadedChapters(chapters, sourcePath)
  const latestChapter = findLatestChapter(downloadedChapters)
  const name = pickString(meta.title, meta.name, meta.comicTitle, meta.bookName, folderName) || folderName
  const mangaId = pickId(meta)
  const crawledAt = stat.mtime.toISOString()
  const updatedAtSite = normalizeDateValue(
    meta.updateDate ?? meta.updatedAt ?? meta.renewal_time ?? meta.publishDate ?? latestChapter?.date
  )
  const coverPath = findLocalCover(metaFolder)
  const chapterCount =
    downloadedChapters.length || pickNumber(meta.chapterCount, meta.count, meta.total, meta.totalChapter) || countDownloadedChapters(sourcePath)

  const manga = await MangaResult.updateOrCreate(
    { identityKey: buildIdentityKey(website, meta, normalizedMetaFile, name) },
    {
      website,
      mangaId: mangaId === null || mangaId === undefined ? null : String(mangaId),
      name,
      author: pickString(meta.author, meta.authors, meta.authorName) ?? null,
      status: status ?? null,
      finished: normalizeFinished(meta, status),
      chapterCount,
      latestChapterName: latestChapter?.name ?? null,
      latestChapterDate: latestChapter?.date ?? null,
      updatedAtSite: updatedAtSite ?? null,
      crawledAt,
      source: source.source ?? null,
      sourcePath,
      metaPath: normalizedMetaFile,
      coverPath: coverPath ? normalizeAbsolutePath(coverPath) : null,
      remoteCover: getRemoteCover(meta) ?? null,
      description: pickString(meta.describe, meta.description, meta.evaluate, meta.subTitle) ?? null,
      tagsJson: JSON.stringify(normalizeTags(meta)),
      recentChaptersJson: serializeRecentChapters(chapters),
    }
  )

  await MangaChapter.query().where('mangaResultId', manga.id).delete()
  if (downloadedChapters.length > 0) {
    await MangaChapter.createMany(
      downloadedChapters.map((chapter, index) => ({
        mangaResultId: manga.id,
        name: chapter.name,
        title: chapter.title ?? null,
        chapterOrder: getChapterOrder(chapter, index),
        date: chapter.date ?? null,
        url: chapter.url ?? null,
        cover: chapter.cover ?? null,
        isFree: chapter.isFree ?? null,
        price: chapter.price ?? null,
        imageCount: chapter.imageCount ?? null,
        rawJson: chapter.raw ? JSON.stringify(chapter.raw) : null,
      }))
    )
  }

  return rowToItem(manga)
}

export async function tryIndexMangaMetaFile(metaFile: string, source: MangaIndexSource = {}) {
  try {
    return await indexMangaMetaFile(metaFile, source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[manga-index] index failed: ${metaFile} ${message}`)
    return null
  }
}

export async function getMangaResults(options: MangaListOptions = {}) {
  await ensureMangaIndexSchema()

  const page = Math.max(1, Number(options.page || 1))
  const pageSize = Math.min(200, Math.max(1, Number(options.pageSize || 80)))
  const query = MangaResult.query()

  if (options.website) {
    query.where('website', options.website)
  }

  if (options.status === 'finished') {
    query.where('finished', true)
  } else if (options.status === 'serial') {
    query.where('finished', false)
  }

  const keyword = options.keyword?.trim().toLocaleLowerCase()
  if (keyword) {
    const likeKeyword = `%${keyword}%`
    query.where((builder) => {
      builder
        .whereRaw('lower(name) like ?', [likeKeyword])
        .orWhereRaw('lower(coalesce(author, "")) like ?', [likeKeyword])
        .orWhereRaw('lower(coalesce(tags_json, "")) like ?', [likeKeyword])
        .orWhereRaw('lower(website) like ?', [likeKeyword])
    })
  }

  const countRows = await query.clone().count('* as total')
  const total = Number(countRows[0].$extras.total || 0)
  const rows = await query
    .orderBy('crawledAt', 'desc')
    .offset((page - 1) * pageSize)
    .limit(pageSize)

  return {
    data: rows.map((row) => rowToItem(row)),
    meta: {
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    },
  }
}

export async function getMangaChapters(mangaResultId: number) {
  await ensureMangaIndexSchema()

  const rows = await MangaChapter.query()
    .where('mangaResultId', mangaResultId)
    .orderBy('date', 'desc')
    .orderBy('chapterOrder', 'desc')

  return rows.map((row) => ({
    name: row.name,
    title: row.title ?? undefined,
    date: row.date ?? undefined,
    url: row.url ?? undefined,
    cover: row.cover ?? undefined,
    isFree: row.isFree ?? undefined,
    price: row.price ?? undefined,
    imageCount: row.imageCount ?? undefined,
  }))
}
