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
        downloadImageWithBrowser: false,
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
    set_config({ gentleman: { downloadImageWithBrowser: true } })
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

  test('uses direct HTTP download by default without opening a browser tab', async ({ assert }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Direct Test Manga',
      url: 'https://www.wnacg.ru/photos-index-aid-2.html',
    })
    const originalFetch = globalThis.fetch
    const originalNewPage = gentlemanBrowser.new_page
    const fetchCalls: Array<{ url: string; options?: RequestInit }> = []
    let browserPageCreated = false

    globalThis.fetch = async (input, options) => {
      fetchCalls.push({ url: String(input), options })
      return new Response(Buffer.from('direct-image-data'), { status: 200 })
    }
    gentlemanBrowser.new_page = async () => {
      browserPageCreated = true
      return null
    }

    const imagePath = path.join(downloadPath, 'direct-image.jpg')
    const referer = 'https://www.wnacg.ru/photos-index-aid-2.html'

    try {
      await (service as any).download_image(
        'https://img5.qy0.ru/data/2/direct image.jpg',
        imagePath,
        referer,
        1
      )
    } finally {
      globalThis.fetch = originalFetch
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'https://img5.qy0.ru/data/2/direct%20image.jpg')
    assert.deepEqual(fetchCalls[0].options?.headers, {
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': referer,
    })
    assert.isFalse(browserPageCreated)
    assert.equal(fs.readFileSync(imagePath, 'utf-8'), 'direct-image-data')
  })
})
