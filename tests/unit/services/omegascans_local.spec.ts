import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import OmegaScans from '#services/omegascans'
import { omegascansBrowser } from '#api/browser'
import {
  countLocalChapters,
  getLocalChapterNames,
  localChapterExists,
} from '#services/omegascans_local'
import { getTestDataRoot } from '#tests/helpers/test_data_dir'
import { get_config, set_config } from '#utils/index'

test.group('OmegaScans local chapters', (group) => {
  const root = path.join(getTestDataRoot(), 'unit', 'omegascans-local')
  const downloadPath = path.join(root, 'download')
  const compressPath = path.join(root, 'compress')
  const mangaName = 'Test Manga'
  const mangaFolder = path.join(downloadPath, mangaName)
  const mangaCompressFolder = path.join(compressPath, mangaName)
  let originalConfig: any

  group.each.setup(() => {
    originalConfig = get_config()?.omegascans
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(path.join(mangaFolder, '.smanga'), { recursive: true })
    fs.mkdirSync(mangaCompressFolder, { recursive: true })
  })

  group.each.teardown(() => {
    if (originalConfig) set_config({ omegascans: originalConfig })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('counts non-empty folders and zip files without duplicates or metadata', ({ assert }) => {
    const downloadedChapter = path.join(mangaFolder, 'Chapter 1')
    const emptyChapter = path.join(mangaFolder, 'Chapter 2')
    fs.mkdirSync(downloadedChapter)
    fs.writeFileSync(path.join(downloadedChapter, '00000.jpg'), 'image')
    fs.mkdirSync(emptyChapter)
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 1.zip'), 'zip')
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 2.zip'), 'zip')
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 2.jpg'), 'cover')

    const chapters = getLocalChapterNames(mangaFolder, mangaCompressFolder)

    assert.deepEqual([...chapters].sort(), ['Chapter 1', 'Chapter 2'])
    assert.equal(countLocalChapters(mangaFolder, mangaCompressFolder), 2)
    assert.isTrue(localChapterExists(mangaFolder, mangaCompressFolder, 'Chapter 2'))
  })

  test('check_update skips a manga whose chapters only exist as zip files', async ({ assert }) => {
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 1.zip'), 'zip')
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 2.zip'), 'zip')
    set_config({
      omegascans: {
        ...(originalConfig || {}),
        downloadPath,
        compressPath,
      },
    })

    const service = new OmegaScans({
      website: 'omegascans',
      id: 1,
      name: mangaName,
      chapterCount: 2,
    })

    assert.isFalse(await service.check_update())
  })

  test('start does not initialize the browser when every chapter already exists', async ({
    assert,
  }) => {
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 1.zip'), 'zip')
    fs.writeFileSync(path.join(mangaCompressFolder, 'Chapter 2.zip'), 'zip')
    set_config({
      omegascans: {
        ...(originalConfig || {}),
        downloadPath,
        compressPath,
      },
    })

    const service = new OmegaScans({
      website: 'omegascans',
      id: 1,
      name: mangaName,
      chapterCount: 2,
    })
    const originalBrowser = omegascansBrowser.browser
    const originalInit = omegascansBrowser.init
    let browserInitialized = false

    omegascansBrowser.browser = null
    omegascansBrowser.init = async () => {
      browserInitialized = true
    }

    try {
      await service.start()
    } finally {
      omegascansBrowser.init = originalInit
      omegascansBrowser.browser = originalBrowser
    }

    assert.isFalse(browserInitialized)
  })
})
