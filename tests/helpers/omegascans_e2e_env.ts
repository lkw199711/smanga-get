import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot } from '#utils/index'

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
  const root = dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
  if (!root.includes('smanga-get-tests')) {
    throw new Error(`拒绝使用非测试 DATA_DIR 执行 OmegaScans E2E: ${root}`)
  }

  return root
}

function writeJson(filePath: string, json: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8')
}

export function createOmegaScansE2EContext(): OmegaScansE2EContext {
  const root = getTestRoot()
  const e2eRoot = path.join(root, 'e2e', 'omegascans')
  const dataDir = path.join(root, 'data')
  const downloadPath = path.join(e2eRoot, 'download')
  const compressPath = path.join(e2eRoot, 'compress')
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

  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(compressPath, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  writeJson(path.join(dataDir, 'config.json'), {
    headless: true,
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    omegascans: {
      cookieFile: 'data/omegascans-cookies.json',
      downloadPath,
      compressPath,
      autoCompress: false,
      downloadChapterLimit: 2,
      e2eFastMode: true,
    },
  })
  writeJson(path.join(dataDir, 'subscribe.json'), [])
  writeJson(path.join(dataDir, 'failed-chapters.json'), [])
  writeJson(path.join(dataDir, 'omegascans.json'), [
    {
      id: mangaId,
      title: mangaName,
      alternative_names: process.env.OMEGASCANS_E2E_ALT_NAMES || '',
      description: process.env.OMEGASCANS_E2E_DESCRIPTION || '',
      thumbnail: process.env.OMEGASCANS_E2E_THUMBNAIL || '',
      total_views: 0,
      status: process.env.OMEGASCANS_E2E_STATUS || 'Ongoing',
      rating: Number(process.env.OMEGASCANS_E2E_RATING || 0),
      series_slug: seriesSlug,
    },
  ])

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

      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
