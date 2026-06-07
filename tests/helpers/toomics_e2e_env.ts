import fs from 'node:fs'
import os from 'node:os'
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
  return dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
}

function getLang(): ToomicsLang {
  const lang = process.env.TOOMICS_E2E_LANG || 'tc'
  if (lang !== 'tc' && lang !== 'en') {
    throw new Error(`TOOMICS_E2E_LANG 仅支持 tc/en，当前值: ${lang}`)
  }

  return lang
}

function getConfigKey(lang: ToomicsLang) {
  return `toomics-${lang}`
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

  // 测试下载根目录：优先环境变量，其次 config 中的 testDownloadPath，否则临时目录
  const testDownloadRoot =
    process.env.TEST_DOWNLOAD_PATH ||
    existingConfig.testDownloadPath ||
    path.join(os.tmpdir(), 'smanga-get-tests')
  const e2eRoot = path.join(testDownloadRoot, 'e2e', 'toomics')
  const downloadPath = path.join(e2eRoot, 'download')
  const compressPath = path.join(e2eRoot, 'compress')
  const coverCachePath = path.join(e2eRoot, 'cover-cache')

  // 清理上次测试产物
  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(compressPath, { recursive: true })
  fs.mkdirSync(coverCachePath, { recursive: true })

  // 保存原始配置值，以便 cleanup 时恢复
  const configKey = getConfigKey(lang)
  const originalToomicsConfig = existingConfig.toomics ? { ...existingConfig.toomics } : {}
  const originalSiteConfig = existingConfig[configKey] ? { ...existingConfig[configKey] } : {}
  const originalHeadless = existingConfig.headless

  // 合并测试覆盖到生产配置（不影响 cookie、账号等生产字段）
  set_config({
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    toomics: {
      ...originalToomicsConfig,
      e2eFastMode: true,
      noiseEnabled: false,
      pretendNumStrategy: 'fixed',
      pretendNumWeights: [1, 0, 0],
      homePageScrollMin: 0,
      homePageScrollMax: 0,
      readerPersona: {
        type: 'moderate',
        pageReadMin: 0,
        pageReadMax: 0,
        keyPageRatio: 0,
        keyPageMin: 0,
        keyPageMax: 0,
        backFlipProb: 0,
        chapterEndExtraMin: 0,
        chapterEndExtraMax: 0,
      },
    },
    [configKey]: {
      userName: getRequiredEnv('TOOMICS_E2E_USER'),
      passWord: getRequiredEnv('TOOMICS_E2E_PASSWORD'),
      downloadPath,
      compressPath,
      coverCache: coverCachePath,
      downloadLockedMeta: false,
      autoCompress: false,
      jumpExist: false,
      scrollStep: 800,
      scrollDelay: 300,
      maxRetry: 2,
      downloadChapterLimit: 2,
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
      if (Object.keys(originalToomicsConfig).length) restoreConfig.toomics = originalToomicsConfig
      if (Object.keys(originalSiteConfig).length) restoreConfig[configKey] = originalSiteConfig
      if (Object.keys(restoreConfig).length) {
        set_config(restoreConfig)
      }

      // 删除测试下载产物
      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
