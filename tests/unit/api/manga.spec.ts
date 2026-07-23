import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import {
  ensureMangaIndexSchema,
  getMangaChapters,
  getMangaResults,
  indexMangaMetaFile,
  resolveAllowedMangaAsset,
} from '#api/manga'
import { getTestDataDir, getTestDataFile, resetTestDataDir } from '#tests/helpers/test_data_dir'
import { get_os_suffix } from '#utils/index'

function writeConfig(config: any) {
  fs.writeFileSync(getTestDataFile(`config.${get_os_suffix()}.json`), JSON.stringify(config, null, 2), 'utf-8')
}

function writeMangaMeta(
  root: string,
  name: string,
  meta: any,
  mtime: Date,
  options: { legacy?: boolean } = {}
) {
  const metaFolder = options.legacy
    ? path.join(root, `${name}-smanga-info`)
    : path.join(root, name, '.smanga')
  const metaFile = path.join(metaFolder, 'meta.json')
  const coverFile = path.join(metaFolder, 'cover.jpg')

  if (options.legacy) {
    fs.mkdirSync(path.join(root, name), { recursive: true })
  }
  fs.mkdirSync(metaFolder, { recursive: true })
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8')
  fs.writeFileSync(coverFile, 'cover', 'utf-8')
  fs.utimesSync(metaFile, mtime, mtime)

  return { metaFile, coverFile }
}

test.group('manga metadata api', (group) => {
  group.each.setup(async () => {
    resetTestDataDir()
    await ensureMangaIndexSchema()
    await db.from('manga_chapters').delete()
    await db.from('manga_results').delete()
  })

  test('indexes .smanga metadata ordered by crawl time', async ({ assert }) => {
    const root = path.join(getTestDataDir(), 'downloads')
    writeConfig({
      toomics: {
        downloadPath: root,
      },
    })

    const oldMeta = writeMangaMeta(
      root,
      'Old Manga',
      {
        id: 1,
        title: 'Old Manga',
        author: 'Old Author',
        finished: false,
        publishDate: '2025-12-01',
        chapters: [{ name: 'Chapter 1', date: '2025-12-01' }],
      },
      new Date('2026-01-01T00:00:00.000Z')
    )
    const newMeta = writeMangaMeta(
      root,
      'New Manga',
      {
        id: 2,
        title: 'New Manga',
        status: 'Completed',
        chapters: [
          { name: 'Chapter 1', date: '2026-01-02' },
          { name: 'Chapter 2', date: '2026-01-03' },
        ],
      },
      new Date('2026-02-01T00:00:00.000Z')
    )

    await indexMangaMetaFile(oldMeta.metaFile, { website: 'toomics', source: 'download' })
    await indexMangaMetaFile(newMeta.metaFile, { website: 'toomics', source: 'download' })
    const results = await getMangaResults({ pageSize: 10 })

    assert.equal(results.meta.total, 2)
    assert.equal(results.data[0].name, 'New Manga')
    assert.equal(results.data[0].chapterCount, 2)
    assert.equal(results.data[0].finished, true)
    assert.equal(results.data[1].name, 'Old Manga')

    const chapters = await getMangaChapters(results.data[0].indexId)
    assert.equal(chapters.length, 2)
  })

  test('supports legacy -smanga-info metadata and cover tokens', async ({ assert }) => {
    const root = path.join(getTestDataDir(), 'bilibili')
    writeConfig({
      bilibili: {
        downloadPath: getTestDataDir(),
      },
    })

    const { coverFile } = writeMangaMeta(
      root,
      'Legacy Manga',
      {
        targetId: 100,
        title: 'Legacy Manga',
        verticalCover: 'https://example.com/cover.jpg',
        chapters: [{ title: 'Episode 1', publishDate: 1780842200000 }],
      },
      new Date('2026-03-01T00:00:00.000Z'),
      { legacy: true }
    )

    await indexMangaMetaFile(path.join(root, 'Legacy Manga-smanga-info', 'meta.json'), {
      website: 'bilibili',
      source: 'download',
    })
    const results = await getMangaResults({ pageSize: 10 })
    const [manga] = results.data

    assert.equal(manga.name, 'Legacy Manga')
    assert.equal(manga.website, 'bilibili')
    assert.equal(manga.sourcePath, path.resolve(root, 'Legacy Manga'))
    assert.equal(resolveAllowedMangaAsset(manga.coverToken!), fs.realpathSync(coverFile))
  })
})
