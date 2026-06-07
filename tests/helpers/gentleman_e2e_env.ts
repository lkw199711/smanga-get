import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot, get_config, set_config } from '#utils/index'

export type GentlemanE2EContext = {
  root: string
  dataDir: string
  downloadPath: string
  organizePath: string
  task: subsribeType
  cleanup(): void
}

export function isGentlemanE2EEnabled() {
  return process.env.GENTLEMAN_E2E_ENABLED === 'true'
}

function getRequiredEnv(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少 Gentleman E2E 环境变量: ${name}`)
  }

  return value
}

function getTestRoot() {
  return dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
}

export function createGentlemanE2EContext(): GentlemanE2EContext {
  const root = getTestRoot()
  const dataDir = path.join(root, 'data')
  const keepArtifacts = process.env.GENTLEMAN_E2E_KEEP_ARTIFACTS === 'true'
  const mangaId = process.env.GENTLEMAN_E2E_MANGA_ID || 'gentleman-e2e'
  const mangaName = getRequiredEnv('GENTLEMAN_E2E_MANGA_NAME')
  const mangaUrl = getRequiredEnv('GENTLEMAN_E2E_MANGA_URL')

  const existingConfig = get_config() || {}

  const testDownloadRoot =
    process.env.TEST_DOWNLOAD_PATH ||
    existingConfig.testDownloadPath ||
    path.join(os.tmpdir(), 'smanga-get-tests')
  const e2eRoot = path.join(testDownloadRoot, 'e2e', 'gentleman')
  const downloadPath = path.join(e2eRoot, 'download')
  const organizePath = path.join(e2eRoot, 'organize')

  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(organizePath, { recursive: true })

  const originalGentlemanConfig = existingConfig.gentleman
    ? { ...existingConfig.gentleman }
    : {}
  const originalHeadless = existingConfig.headless

  set_config({
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    gentleman: {
      ...originalGentlemanConfig,
      downloadPath,
      organizePath,
      organize: false,
      downloadChapterLimit: 2,
      chapterIncludes: process.env.GENTLEMAN_E2E_CHAPTER_INCLUDES || '',
      chapterExcludes: process.env.GENTLEMAN_E2E_CHAPTER_EXCLUDES || '',
    },
  })

  return {
    root: e2eRoot,
    dataDir,
    downloadPath,
    organizePath,
    task: {
      website: 'gentleman',
      id: mangaId,
      name: mangaName,
      url: mangaUrl,
      nameMatch: false,
    },
    cleanup() {
      if (keepArtifacts) {
        console.log(`[gentleman e2e] 测试产物保留在: ${e2eRoot}`)
        return
      }

      const restoreConfig: Record<string, unknown> = {}
      if (originalHeadless !== undefined) restoreConfig.headless = originalHeadless
      if (Object.keys(originalGentlemanConfig).length)
        restoreConfig.gentleman = originalGentlemanConfig
      if (Object.keys(restoreConfig).length) {
        set_config(restoreConfig)
      }

      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
