import fs from 'node:fs'
import path from 'node:path'

type Assert = {
  equal(actual: unknown, expected: unknown, message?: string): void
  isAbove(value: number, min: number, message?: string): void
  isAtLeast(value: number, min: number, message?: string): void
  isArray(value: unknown, message?: string): void
  isNotEmpty(value: unknown, message?: string): void
  deepEqual(actual: unknown, expected: unknown, message?: string): void
}

type MangaDownloadAssertionOptions = {
  downloadPath: string
  minChapterCount?: number
  minImageSize?: number
  requireMeta?: boolean
  sequenceMode?: 'zero-based-file-name' | 'trailing-number' | 'none'
}

function getDirectories(dirPath: string) {
  if (!fs.existsSync(dirPath)) return []

  return fs
    .readdirSync(dirPath)
    .filter((item) => fs.statSync(path.join(dirPath, item)).isDirectory())
}

function getImageFiles(dirPath: string) {
  return fs
    .readdirSync(dirPath)
    .filter((item) => /\.(jpe?g|png|webp)$/i.test(item))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

function getTrailingNumber(fileName: string) {
  const match = path.parse(fileName).name.match(/(\d+)(?!.*\d)/)
  if (!match) return null

  return Number(match[1])
}

function assertZeroBasedImageSequence(assert: Assert, chapterDir: string, images: string[]) {
  const indexes = images.map((image) => Number(path.parse(image).name))
  const expected = Array.from({ length: indexes.length }, (_, index) => index)

  assert.deepEqual(indexes, expected, `章节图片命名不连续: ${chapterDir}`)
}

function assertTrailingNumberImageSequence(assert: Assert, chapterDir: string, images: string[]) {
  const numberedImages = images
    .map((image) => ({ image, index: getTrailingNumber(image) }))
    .filter((item): item is { image: string; index: number } => item.index !== null)
    .sort((a, b) => a.index - b.index)

  assert.equal(
    numberedImages.length,
    images.length,
    `章节图片文件名无法全部提取页码: ${chapterDir}`
  )

  const indexes = numberedImages.map((item) => item.index)
  const firstIndex = indexes[0] ?? 0
  const expected = Array.from({ length: indexes.length }, (_, index) => firstIndex + index)

  assert.deepEqual(indexes, expected, `章节图片命名不连续: ${chapterDir}`)
}

function assertImageSequence(
  assert: Assert,
  chapterDir: string,
  images: string[],
  mode: MangaDownloadAssertionOptions['sequenceMode']
) {
  if (mode === 'none') return
  if (mode === 'trailing-number') {
    assertTrailingNumberImageSequence(assert, chapterDir, images)
    return
  }

  assertZeroBasedImageSequence(assert, chapterDir, images)
}

export function assertMangaDownloadResult(assert: Assert, options: MangaDownloadAssertionOptions) {
  const minChapterCount = options.minChapterCount ?? 2
  const minImageSize = options.minImageSize ?? 250
  const requireMeta = options.requireMeta ?? true
  const sequenceMode = options.sequenceMode ?? 'zero-based-file-name'
  const mangaDirs = getDirectories(options.downloadPath)

  assert.isNotEmpty(mangaDirs, `下载目录下没有漫画目录: ${options.downloadPath}`)

  const mangaDir = path.join(options.downloadPath, mangaDirs[0])
  const metaFile = path.join(mangaDir, '.smanga', 'meta.json')

  if (requireMeta) {
    assert.equal(fs.existsSync(metaFile), true, `缺少 meta.json: ${metaFile}`)

    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
    assert.isNotEmpty(meta.title, `meta.title 为空: ${metaFile}`)
    assert.isArray(meta.chapters, `meta.chapters 不是数组: ${metaFile}`)
    assert.isNotEmpty(meta.chapters, `meta.chapters 为空: ${metaFile}`)
  } else {
    const metaDir = path.join(mangaDir, '.smanga')
    assert.equal(fs.existsSync(metaDir), true, `缺少 .smanga 目录: ${metaDir}`)
  }

  const chapterDirs = getDirectories(mangaDir)
    .filter((chapter) => chapter !== '.smanga')
    .map((chapter) => path.join(mangaDir, chapter))
    .filter((chapterDir) => getImageFiles(chapterDir).length > 0)

  assert.isAtLeast(
    chapterDirs.length,
    minChapterCount,
    `实际下载章节数不足，期望至少 ${minChapterCount} 个，实际 ${chapterDirs.length} 个`
  )

  for (const chapterDir of chapterDirs.slice(0, minChapterCount)) {
    const images = getImageFiles(chapterDir)
    assert.isNotEmpty(images, `章节目录没有图片: ${chapterDir}`)
    assertImageSequence(assert, chapterDir, images, sequenceMode)

    for (const image of images) {
      const imagePath = path.join(chapterDir, image)
      const stat = fs.statSync(imagePath)
      assert.isAbove(stat.size, minImageSize, `图片小于 ${minImageSize} bytes: ${imagePath}`)
    }
  }

  return {
    mangaDir,
    metaFile,
    chapterDirs,
  }
}

export const assertToomicsDownloadResult = assertMangaDownloadResult
export const assertOmegaScansDownloadResult = assertMangaDownloadResult
export function assertGentlemanDownloadResult(
  assert: Assert,
  options: MangaDownloadAssertionOptions
) {
  return assertMangaDownloadResult(assert, {
    ...options,
    requireMeta: false,
    sequenceMode: 'trailing-number',
  })
}
