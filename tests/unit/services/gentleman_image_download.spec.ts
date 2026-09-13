import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import Gentleman from '#services/gentleman'
import { gentlemanBrowser } from '#api/browser'
import { getTestDataRoot } from '#tests/helpers/test_data_dir'
import { assertGentlemanDownloadResult } from '#tests/helpers/download_assertions'
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
        detailPageDelayMinMs: 0,
        detailPageDelayMaxMs: 0,
        challengeRetryDelayMs: 0,
        detailPageRetry: 3,
        detailImageBufferTimeoutMs: 0,
      },
    })
    gentlemanBrowser.clear_buffs()
  })

  group.each.teardown(() => {
    gentlemanBrowser.clear_buffs()
    set_config({ gentleman: originalConfig || {} })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('writes captured detail-page buffers without a second image request', async ({ assert }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Buffered Test Manga',
      url: 'https://www.wnacg.ru/photos-index-aid-2.html',
    })
    const imageUrl = 'https://img5.qy0.ru/data/2/buffered.jpg?verify=from-detail-page'

    ;(gentlemanBrowser as any).rememberImageBuffer(imageUrl, Buffer.from('browser-buffer-data'))

    await (service as any).download_chapter_images({
      name: 'Buffered Test Manga 1話',
      url: 'https://www.wnacg.ru/photos-index-aid-2.html',
      images: [imageUrl],
    })

    const imagePath = path.join(
      downloadPath,
      'Buffered Test Manga',
      'Buffered Test Manga 1話',
      'buffered.jpg'
    )
    assert.equal(fs.readFileSync(imagePath, 'utf-8'), 'browser-buffer-data')
    assert.isNull(gentlemanBrowser.take_image_buffer(imageUrl))
  })

  test('extracts the signed original image URL from the saved detail page', ({ assert }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Signed Image Test',
      url: 'https://www.wnacg.ru/photos-index-aid-384066.html',
    })
    const html = fs.readFileSync(
      path.join(process.cwd(), 'tests', 'html', 'photos-view-id-32938947.html'),
      'utf-8'
    )

    const imageUrl = (service as any).get_view_image_url(
      html,
      'https://www.wnacg.ru/photos-view-id-32938947.html'
    )

    assert.equal(
      imageUrl,
      'https://img5.qy0.ru/data/3840/66/76_02.jpg?verify=1789257600--s-Usr0hIDYJOmmcq46qZZz7bymzVIISAxaxg7usPl4'
    )
    assert.equal(
      (service as any).get_view_image_url(
        '<html><body>image unavailable</body></html>',
        'https://www.wnacg.ru/photos-view-id-32938947.html'
      ),
      ''
    )
  })

  test('opens every image detail page instead of constructing URLs from thumbnails', async ({
    assert,
  }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Detail Page Test',
      url: 'https://www.wnacg.ru/photos-index-aid-1.html',
    })
    const chapterUrl = 'https://www.wnacg.ru/photos-index-aid-1.html'
    const nextChapterPageUrl = 'https://www.wnacg.ru/photos-index-page-2-aid-1.html'
    const firstViewUrl = 'https://www.wnacg.ru/photos-view-id-11.html'
    const secondViewUrl = 'https://www.wnacg.ru/photos-view-id-12.html'
    const listPageUrls: string[] = []
    const detailPageUrls: string[] = []
    const originalNewPage = gentlemanBrowser.new_page
    let currentUrl = ''
    let closedPages = 0
    const pages = new Map<string, string>([
      [
        chapterUrl,
        `<div class="gallary_wrap">
          <div class="gallary_item"><a href="/photos-view-id-11.html"><img src="//t5.qy0.ru/data/t/1/1/thumb.jpg"></a></div>
        </div><div class="comment_wrap"></div>
        <div class="paginator"><span class="next"><a href="/photos-index-page-2-aid-1.html">後頁</a></span><div class="f_right"></div>`,
      ],
      [
        nextChapterPageUrl,
        `<div class="gallary_wrap">
          <div class="gallary_item"><a href="/photos-view-id-12.html"><img src="//t5.qy0.ru/data/t/1/2/thumb.jpg"></a></div>
        </div><div class="comment_wrap"></div>`,
      ],
      [firstViewUrl, '<img src="//img5.qy0.ru/data/1/1/001.jpg?verify=111--first" id="picarea">'],
      [secondViewUrl, '<img id="picarea" src="//img5.qy0.ru/data/1/1/002.jpg?verify=222--second">'],
    ])

    ;(service as any).get_browser_html = async (url: string) => {
      listPageUrls.push(url)
      return pages.get(url) || ''
    }
    gentlemanBrowser.new_page = async () =>
      ({
        goto: async (url: string) => {
          currentUrl = url
          detailPageUrls.push(url)
          return { status: () => 200 }
        },
        content: async () => {
          const html = pages.get(currentUrl) || ''
          if (currentUrl === firstViewUrl) {
            ;(gentlemanBrowser as any).rememberImageBuffer(
              'https://img5.qy0.ru/data/1/1/001.jpg?verify=111--first',
              Buffer.from('first')
            )
          }
          if (currentUrl === secondViewUrl) {
            ;(gentlemanBrowser as any).rememberImageBuffer(
              'https://img5.qy0.ru/data/1/1/002.jpg?verify=222--second',
              Buffer.from('second')
            )
          }
          return html
        },
        title: async () => 'image detail',
        close: async () => {
          closedPages++
        },
      }) as any

    const chapter = { name: 'Detail Page Test 1話', url: chapterUrl, imageNum: 2, images: [] }
    let images: string[]
    try {
      images = await (service as any).get_chapter_images(chapter)
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.deepEqual(listPageUrls, [chapterUrl, nextChapterPageUrl])
    assert.deepEqual(detailPageUrls, [firstViewUrl, secondViewUrl])
    assert.equal(closedPages, 1)
    assert.deepEqual(images, [
      'https://img5.qy0.ru/data/1/1/001.jpg?verify=111--first',
      'https://img5.qy0.ru/data/1/1/002.jpg?verify=222--second',
    ])
  })

  test('backs off and retries when a detail request reaches the security challenge', async ({
    assert,
  }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Challenge Test',
      url: 'https://www.wnacg.ru/photos-index-aid-1.html',
    })
    const waitCalls: number[] = []
    let attempt = 0
    const page = {
      goto: async () => {
        attempt++
        return { status: () => 200 }
      },
      content: async () => {
        if (attempt === 1) return '<html><body>正在进行安全验证 Ray ID: test</body></html>'

        const imageUrl = 'https://img5.qy0.ru/data/1/1/001.jpg?verify=retry-ok'
        ;(gentlemanBrowser as any).rememberImageBuffer(imageUrl, Buffer.from('retry-buffer'))
        return `<img id="picarea" src="${imageUrl}">`
      },
      title: async () => (attempt === 1 ? '请稍候…' : '001'),
    }

    ;(service as any).wait = async (milliseconds: number) => waitCalls.push(milliseconds)
    const imageUrl = await (service as any).get_detail_image_url(
      page,
      { name: 'Challenge Test 1話' },
      'https://www.wnacg.ru/photos-view-id-1.html'
    )

    assert.equal(attempt, 2)
    assert.deepEqual(waitCalls, [0])
    assert.equal(imageUrl, 'https://img5.qy0.ru/data/1/1/001.jpg?verify=retry-ok')
  })

  test('removes verify parameters from filenames saved from browser buffers', async ({
    assert,
  }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Verified Download',
      url: 'https://www.wnacg.ru/photos-index-aid-1.html',
    })
    const imageUrl = 'https://img5.qy0.ru/data/3840/66/76_02.jpg?verify=123--signature'

    ;(gentlemanBrowser as any).rememberImageBuffer(imageUrl, Buffer.from('signed-image-data'))

    await (service as any).download_chapter_images({
      name: 'Verified Download 1話',
      url: 'https://www.wnacg.ru/photos-index-aid-1.html',
      images: [imageUrl],
    })

    const savedImage = path.join(
      downloadPath,
      'Verified Download',
      'Verified Download 1話',
      '76_02.jpg'
    )
    assert.isTrue(fs.existsSync(savedImage))
    assert.equal(fs.readFileSync(savedImage, 'utf-8'), 'signed-image-data')
    assert.isNull(gentlemanBrowser.take_image_buffer(imageUrl))
  })

  test('accepts continuous image sequences in a merged chapter and ignores its cover', ({
    assert,
  }) => {
    const mangaPath = path.join(downloadPath, 'Merged Chapter')
    const chapterPath = path.join(mangaPath, 'Merged Chapter 76-77話')
    fs.mkdirSync(path.join(mangaPath, '.smanga'), { recursive: true })
    fs.mkdirSync(chapterPath, { recursive: true })

    for (const fileName of ['76_01.jpg', '76_02.jpg', '77_01.jpg', '77_02.jpg', 'cover.jpg']) {
      fs.writeFileSync(path.join(chapterPath, fileName), Buffer.alloc(300))
    }

    assertGentlemanDownloadResult(assert, {
      downloadPath,
      minChapterCount: 1,
      minImageSize: 250,
    })
  })
})
