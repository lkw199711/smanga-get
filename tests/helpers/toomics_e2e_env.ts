import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot } from '#utils/index'

type ToomicsLang = 'sc' | 'tc' | 'en'

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
  const root = dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
  if (!root.includes('smanga-get-tests')) {
    throw new Error(`拒绝使用非测试 DATA_DIR 执行 Toomics E2E: ${root}`)
  }

  return root
}

function getLang(): ToomicsLang {
  const lang = process.env.TOOMICS_E2E_LANG || 'sc'
  if (lang !== 'sc' && lang !== 'tc' && lang !== 'en') {
    throw new Error(`TOOMICS_E2E_LANG 仅支持 sc/tc/en，当前值: ${lang}`)
  }

  return lang
}

function getConfigKey(lang: ToomicsLang) {
  return `toomics-${lang}`
}

function writeJson(filePath: string, json: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8')
}

export function createToomicsE2EContext(): ToomicsE2EContext {
  const root = getTestRoot()
  const e2eRoot = path.join(root, 'e2e', 'toomics')
  const dataDir = path.join(root, 'data')
  const downloadPath = path.join(e2eRoot, 'download')
  const compressPath = path.join(e2eRoot, 'compress')
  const coverCachePath = path.join(e2eRoot, 'cover-cache')
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

  fs.rmSync(e2eRoot, { recursive: true, force: true })
  fs.mkdirSync(downloadPath, { recursive: true })
  fs.mkdirSync(compressPath, { recursive: true })
  fs.mkdirSync(coverCachePath, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  const configKey = getConfigKey(lang)
  const config = {
    headless: true,
    endAfterSetCookie: false,
    shutdownAfterSetCookie: false,
    toomics: {
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
      cookieFile: 'data/toomics-cookies.json',
      downloadLockedMeta: false,
      autoCompress: false,
      jumpExist: false,
      scrollStep: 800,
      scrollDelay: 300,
      maxRetry: 2,
      downloadChapterLimit: 2,
      e2eFastMode: true,
    },
  }

  writeJson(path.join(dataDir, 'config.json'), config)
  writeJson(path.join(dataDir, 'subscribe.json'), [])
  writeJson(path.join(dataDir, 'failed-chapters.json'), [])
  writeJson(path.join(dataDir, 'scheduler-state.json'), {})

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

      fs.rmSync(e2eRoot, { recursive: true, force: true })
    },
  }
}
