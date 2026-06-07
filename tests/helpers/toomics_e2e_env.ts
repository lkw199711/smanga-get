import fs from 'node:fs'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot, get_config, set_config } from '#utils/index'

type ToomicsLang = 'tc' | 'en'

export type ToomicsE2EContext = {
  root: string
  dataDir: string
  downloadPath: string
  compressPath: string
  coverCachePath: string
  task: subsribeType
  cleanup(): void
}

export function isToomicsE2EEnabled() {
  return process.env.TOOMICS_E2E_ENABLED === 'true'
}

function getRequiredEnv(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少 Toomics E2E 环境变量: ${name}`)
  }

  return value
}

function getTestRoot() {
  return dataRoot.replace(/\/$/, '')
}

function getLang(): ToomicsLang {
  const lang = process.env.TOOMICS_E2E_LANG || 'tc'
  if (lang !== 'tc' && lang !== 'en') {
    throw new Error(`TOOMICS_E2E_LANG 仅支持 tc/en，当前值: ${lang}`)
  }

  return lang
}

export function createToomicsE2EContext(): ToomicsE2EContext {
  const root = getTestRoot()
  const dataDir = path.join(root, 'data')
  const keepArtifacts = process.env.TOOMICS_E2E_KEEP_ARTIFACTS === 'true'
  const lang = getLang()
  const mangaId = Number(getRequiredEnv('TOOMICS_E2E_MANGA_ID'))
  const mangaName = getRequiredEnv('TOOMICS_E2E_MANGA_NAME')
  const mangaUrl =
    process.env.TOOMICS_E2E_MANGA_URL ||
    `https://toomics.com/${lang}/webtoon/episode/toon/${mangaId}`

  if (!Number.isFinite(mangaId) || mangaId <= 0) {
    throw new Error(
      `TOOMICS_E2E_MANGA_ID 必须是正整数，当前值: ${process.env.TOOMICS_E2E_MANGA_ID}`
    )
  }

  // 读取现有配置（共享生产配置，保持 cookie 一致性）
  const existingConfig = get_config() || {}

  // 确定语言对应的 config key（与 Toomics 构造函数逻辑一致）
  const websiteKey = lang === 'en' ? 'toomics-en' : 'toomics-tc'
  const originalSiteConfig = existingConfig[websiteKey]
    ? { ...existingConfig[websiteKey] }
    : {}
  const originalToomicsConfig = existingConfig.toomics
    ? { ...existingConfig.toomics }
    : {}
  const originalHeadless = existingConfig.headless

  // 测试下载根目录：始终使用隔离的测试数据目录（DATA_DIR 已隔离，无需额外配置）
  const testDownloadRoot = getTestRoot()
  const e2eRoot = path.join(testDownloadRoot, 'e2e', 'toomics')
  const downloadPath = path.join(e2eRoot, 'download')
  const compressPath = path.join(e2eRoot, 'compress')
  const coverCachePath = path.join(e2eRoot, 'cover-cache')

  // 清理上次测试产物
  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(compressPath, { recursive: true })
  fs.mkdirSync(coverCachePath, { recursive: true })

  // 注入测试配置到 config.json（与 gentleman/omegascans e2e 保持一致）
  set_config({
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    [websiteKey]: {
      ...originalSiteConfig,
      downloadPath,
      compressPath,
      coverCache: coverCachePath,
      chapterCache: path.join(e2eRoot, 'chapter-cache'),
      downloadChapterLimit: 2,
      e2eFastMode: true,
    },
    toomics: {
      ...originalToomicsConfig,
      e2eFastMode: true,
    },
  })

  return {
    root: e2eRoot,
    dataDir,
    downloadPath,
    compressPath,
    coverCachePath,
    task: {
      website: 'toomics',
      id: mangaId,
      name: mangaName,
      url: mangaUrl,
      langTag: lang,
      chapterCount: Number(process.env.TOOMICS_E2E_CHAPTER_COUNT || 999),
    },
    cleanup() {
      if (keepArtifacts) {
        console.log(`[toomics e2e] 测试产物保留在: ${e2eRoot}`)
        return
      }

      // 恢复生产配置中的原始值
      const restoreConfig: Record<string, unknown> = {}
      if (originalHeadless !== undefined) restoreConfig.headless = originalHeadless
      if (Object.keys(originalSiteConfig).length)
        restoreConfig[websiteKey] = originalSiteConfig
      if (Object.keys(originalToomicsConfig).length)
        restoreConfig.toomics = originalToomicsConfig
      if (Object.keys(restoreConfig).length) {
        set_config(restoreConfig)
      }

      // 删除测试下载产物
      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
