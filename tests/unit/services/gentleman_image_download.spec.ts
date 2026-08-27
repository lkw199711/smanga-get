import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import Gentleman from '#services/gentleman'
import { gentlemanBrowser } from '#api/browser'
import { getTestDataRoot } from '#tests/helpers/test_data_dir'
import { get_config, set_config } from '#utils/index'

test.group('Gentleman image download', (group) => {
  const root = path.join(getTestDataRoot(), 'unit', 'gentleman-image-download')
  const downloadPath = path.join(root, 'download')
  const organizePath = path.join(root, 'organize')
  let originalConfig: any

  group.each.setup(() => {
    originalConfig = get_config()?.gentleman
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(downloadPath, { recursive: true })
    fs.mkdirSync(organizePath, { recursive: true })
    set_config({
      gentleman: {
        ...(originalConfig || {}),
        downloadPath,
        organizePath,
        organize: false,
      },
    })
  })

  group.each.teardown(() => {
    set_config({ gentleman: originalConfig || {} })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('downloads one image through a fresh browser tab and closes every retry tab', async ({
    assert,
  }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Test Manga',
      url: 'https://www.wnacg.ru/photos-index-aid-1.html',
    })
    const originalNewPage = gentlemanBrowser.new_page
    const gotoCalls: Array<{ url: string; options: Record<string, unknown> }> = []
    const headerCalls: Array<Record<string, string>> = []
    let createdPages = 0
    let closedPages = 0

    gentlemanBrowser.new_page = async () => {
      const pageIndex = createdPages++

      return {
        setExtraHTTPHeaders: async (headers: Record<string, string>) => {
          headerCalls.push(headers)
        },
        goto: async (url: string, options: Record<string, unknown>) => {
          gotoCalls.push({ url, options })

          return {
            ok: () => pageIndex > 0,
            status: () => (pageIndex > 0 ? 200 : 503),
            buffer: async () => Buffer.from('image-data'),
          }
        },
        close: async () => {
          closedPages++
        },
      } as any
    }

    const imagePath = path.join(downloadPath, 'image.jpg')
    const referer = 'https://www.wnacg.ru/photos-index-aid-1.html'

    try {
      await (service as any).download_image(
        'https://img5.qy0.ru/data/1/image name.jpg',
        imagePath,
        referer,
        2
      )
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.equal(createdPages, 2)
    assert.equal(closedPages, 2)
    assert.equal(gotoCalls.length, 2)
    assert.equal(gotoCalls[0].url, 'https://img5.qy0.ru/data/1/image%20name.jpg')
    assert.deepEqual(gotoCalls[0].options, {
      waitUntil: 'networkidle2',
      timeout: 30_000,
      referer,
    })
    assert.equal(headerCalls[0]['Sec-Fetch-Dest'], 'image')
    assert.equal(headerCalls[0]['Sec-Fetch-Site'], 'cross-site')
    assert.equal(fs.readFileSync(imagePath, 'utf-8'), 'image-data')
  })
})
