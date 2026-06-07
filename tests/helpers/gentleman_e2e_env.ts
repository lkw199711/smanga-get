import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot } from '#utils/index'

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
  const root = dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
  if (!root.includes('smanga-get-tests')) {
    throw new Error(`拒绝使用非测试 DATA_DIR 执行 Gentleman E2E: ${root}`)
  }

  return root
}

function writeJson(filePath: string, json: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8')
}

export function createGentlemanE2EContext(): GentlemanE2EContext {
  const root = getTestRoot()
  const e2eRoot = path.join(root, 'e2e', 'gentleman')
  const dataDir = path.join(root, 'data')
  const downloadPath = path.join(e2eRoot, 'download')
  const organizePath = path.join(e2eRoot, 'organize')
  const keepArtifacts = process.env.GENTLEMAN_E2E_KEEP_ARTIFACTS === 'true'
  const mangaId = process.env.GENTLEMAN_E2E_MANGA_ID || 'gentleman-e2e'
  const mangaName = getRequiredEnv('GENTLEMAN_E2E_MANGA_NAME')
  const mangaUrl = getRequiredEnv('GENTLEMAN_E2E_MANGA_URL')

  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(organizePath, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  writeJson(path.join(dataDir, 'config.json'), {
    headless: true,
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    gentleman: {
      cookieFile: 'data/gentleman-cookies.json',
      downloadPath,
      organizePath,
      organize: false,
      downloadChapterLimit: 2,
      chapterIncludes: process.env.GENTLEMAN_E2E_CHAPTER_INCLUDES || '',
      chapterExcludes: process.env.GENTLEMAN_E2E_CHAPTER_EXCLUDES || '',
    },
  })
  writeJson(path.join(dataDir, 'subscribe.json'), [])

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

      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
