import fs from 'node:fs'
import path from 'node:path'

/**
 * 读取漫画在下载目录和压缩目录中已经存在的章节名。
 *
 * 下载目录只把非空章节文件夹算作完成；压缩目录只识别 .zip 文件。
 * 两边使用同一个 Set 去重，避免章节同时保留源目录和压缩包时重复计数。
 */
export function getLocalChapterNames(
  mangaFolder: string,
  mangaCompressFolder: string
): Set<string> {
  const chapters = new Set<string>()

  if (fs.existsSync(mangaFolder)) {
    for (const entry of fs.readdirSync(mangaFolder)) {
      if (entry === '.smanga') continue

      const fullPath = path.join(mangaFolder, entry)
      if (!fs.statSync(fullPath).isDirectory()) continue
      if (fs.readdirSync(fullPath).length === 0) continue

      chapters.add(entry)
    }
  }

  if (fs.existsSync(mangaCompressFolder)) {
    for (const entry of fs.readdirSync(mangaCompressFolder)) {
      if (!entry.toLowerCase().endsWith('.zip')) continue

      const fullPath = path.join(mangaCompressFolder, entry)
      if (!fs.statSync(fullPath).isFile()) continue

      chapters.add(entry.slice(0, -4))
    }
  }

  return chapters
}

export function countLocalChapters(mangaFolder: string, mangaCompressFolder: string): number {
  return getLocalChapterNames(mangaFolder, mangaCompressFolder).size
}

export function localChapterExists(
  mangaFolder: string,
  mangaCompressFolder: string,
  chapterName: string
): boolean {
  const chapterFolder = path.join(mangaFolder, chapterName)
  if (
    fs.existsSync(chapterFolder) &&
    fs.statSync(chapterFolder).isDirectory() &&
    fs.readdirSync(chapterFolder).length > 0
  ) {
    return true
  }

  const chapterZip = path.join(mangaCompressFolder, `${chapterName}.zip`)
  return fs.existsSync(chapterZip) && fs.statSync(chapterZip).isFile()
}
