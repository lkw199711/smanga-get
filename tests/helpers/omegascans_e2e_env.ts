import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot, get_config, set_config } from '#utils/index'

export type OmegaScansE2EContext = {
  root: string
  dataDir: string
  downloadPath: string
  compressPath: string
  task: subsribeType
  cleanup(): void
}

export function isOmegaScansE2EEnabled() {
  return process.env.OMEGASCANS_E2E_ENABLED === 'true'
}

function getRequiredEnv(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少 OmegaScans E2E 环境变量: ${name}`)
  }

  return value
}

function getOptionalNumberEnv(name: string, defaultValue: number) {
  const value = process.env[name]
  if (!value) return defaultValue

  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${name} 必须是数字，当前值: ${value}`)
  }

  return numberValue
}

function getTestRoot() {
  return dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
}

export function createOmegaScansE2EContext(): OmegaScansE2EContext {
  const root = getTestRoot()
  const dataDir = path.join(root, 'data')
  const keepArtifacts = process.env.OMEGASCANS_E2E_KEEP_ARTIFACTS === 'true'
  const mangaId = Number(getRequiredEnv('OMEGASCANS_E2E_MANGA_ID'))
  const mangaName = getRequiredEnv('OMEGASCANS_E2E_MANGA_NAME')
  const seriesSlug = getRequiredEnv('OMEGASCANS_E2E_SERIES_SLUG')
  const chapterCount = getOptionalNumberEnv('OMEGASCANS_E2E_CHAPTER_COUNT', 999)

  if (!Number.isFinite(mangaId) || mangaId <= 0) {
    throw new Error(
      `OMEGASCANS_E2E_MANGA_ID 必须是正整数，当前值: ${process.env.OMEGASCANS_E2E_MANGA_ID}`
    )
  }

  const existingConfig = get_config() || {}

  const testDownloadRoot =
    process.env.TEST_DOWNLOAD_PATH ||
    existingConfig.testDownloadPath ||
    path.join(os.tmpdir(), 'smanga-get-tests')
  const e2eRoot = path.join(testDownloadRoot, 'e2e', 'omegascans')
  const downloadPath = path.join(e2eRoot, 'download')
  const compressPath = path.join(e2eRoot, 'compress')

  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(compressPath, { recursive: true })

  const originalOmegascansConfig = existingConfig.omegascans
    ? { ...existingConfig.omegascans }
    : {}
  const originalHeadless = existingConfig.headless

  set_config({
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    omegascans: {
      ...originalOmegascansConfig,
      downloadPath,
      compressPath,
      autoCompress: false,
      downloadChapterLimit: 2,
      e2eFastMode: true,
    },
  })

  // omegascans.json 漫画元数据：追加测试条目到已有数据，cleanup 时移除
  const omegascansFile = path.join(dataDir, 'omegascans.json')
  const existingMangaList: any[] = fs.existsSync(omegascansFile)
    ? JSON.parse(fs.readFileSync(omegascansFile, 'utf-8'))
    : []
  const testMangaEntry = {
    id: mangaId,
    title: mangaName,
    alternative_names: process.env.OMEGASCANS_E2E_ALT_NAMES || '',
    description: process.env.OMEGASCANS_E2E_DESCRIPTION || '',
    thumbnail: process.env.OMEGASCANS_E2E_THUMBNAIL || '',
    total_views: 0,
    status: process.env.OMEGASCANS_E2E_STATUS || 'Ongoing',
    rating: Number(process.env.OMEGASCANS_E2E_RATING || 0),
    series_slug: seriesSlug,
  }
  // 去重：移除同 id 的旧条目，追加新条目
  const updatedMangaList = existingMangaList
    .filter((item: any) => item.id !== mangaId)
    .concat(testMangaEntry)
  fs.writeFileSync(omegascansFile, JSON.stringify(updatedMangaList, null, 2), 'utf-8')

  return {
    root: e2eRoot,
    dataDir,
    downloadPath,
    compressPath,
    task: {
      website: 'omegascans',
      id: mangaId,
      name: mangaName,
      url: `https://omegascans.org/comics/${seriesSlug}`,
      series_slug: seriesSlug,
      chapterCount,
    },
    cleanup() {
      if (keepArtifacts) {
        console.log(`[omegascans e2e] 测试产物保留在: ${e2eRoot}`)
        return
      }

      // 恢复生产配置中的原始值
      const restoreConfig: Record<string, unknown> = {}
      if (originalHeadless !== undefined) restoreConfig.headless = originalHeadless
      if (Object.keys(originalOmegascansConfig).length)
        restoreConfig.omegascans = originalOmegascansConfig
      if (Object.keys(restoreConfig).length) {
        set_config(restoreConfig)
      }

      // 从 omegascans.json 中移除测试漫画条目
      if (fs.existsSync(omegascansFile)) {
        const currentList: any[] = JSON.parse(fs.readFileSync(omegascansFile, 'utf-8'))
        const restoredList = currentList.filter((item: any) => item.id !== mangaId)
        if (restoredList.length !== currentList.length) {
          fs.writeFileSync(omegascansFile, JSON.stringify(restoredList, null, 2), 'utf-8')
        }
      }

      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
