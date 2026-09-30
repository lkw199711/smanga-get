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
    gentlemanBrowser.set_image_capture_mode('all')
  })

  group.each.teardown(() => {
    gentlemanBrowser.clear_buffs()
    gentlemanBrowser.set_image_capture_mode('all')
    set_config({ gentleman: originalConfig || {} })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('blocks list thumbnails and captures only signed original images', async ({ assert }) => {
    const thumbnailUrl = 'https://t5.qy0.ru/data/t/1/1/thumb.jpg'
    const unsignedImageUrl = 'https://img5.qy0.ru/data/1/1/001.jpg'
    const originalImageUrl = 'https://img5.qy0.ru/data/1/1/001.jpg?verify=signed'

    const makeRequest = (url: string) => {
      let aborted = 0
      let continued = 0
      return {
        request: {
          resourceType: () => 'image',
          url: () => url,
          abort: async () => {
            aborted++
          },
          continue: async () => {
            continued++
          },
        },
        counts: () => ({ aborted, continued }),
      }
    }

    gentlemanBrowser.set_image_capture_mode('none')
    const listThumbnail = makeRequest(thumbnailUrl)
    await (gentlemanBrowser as any).handleRequest({}, listThumbnail.request)
    assert.deepEqual(listThumbnail.counts(), { aborted: 1, continued: 0 })

    gentlemanBrowser.set_image_capture_mode('original-only')
    const detailThumbnail = makeRequest(thumbnailUrl)
    const unsignedImage = makeRequest(unsignedImageUrl)
    const signedOriginal = makeRequest(originalImageUrl)
    await (gentlemanBrowser as any).handleRequest({}, detailThumbnail.request)
    await (gentlemanBrowser as any).handleRequest({}, unsignedImage.request)
    await (gentlemanBrowser as any).handleRequest({}, signedOriginal.request)

    assert.deepEqual(detailThumbnail.counts(), { aborted: 1, continued: 0 })
    assert.deepEqual(unsignedImage.counts(), { aborted: 1, continued: 0 })
    assert.deepEqual(signedOriginal.counts(), { aborted: 0, continued: 1 })

    let bufferReads = 0
    const makeResponse = (url: string) => ({
      url: () => url,
      headers: () => ({ 'content-type': 'image/jpeg' }),
      request: () => ({ resourceType: () => 'image' }),
      buffer: async () => {
        bufferReads++
        return Buffer.from('signed-original')
      },
    })

    await (gentlemanBrowser as any).handleImageResponse({}, makeResponse(thumbnailUrl))
    await (gentlemanBrowser as any).handleImageResponse({}, makeResponse(unsignedImageUrl))
    await (gentlemanBrowser as any).handleImageResponse({}, makeResponse(originalImageUrl))

    assert.equal(bufferReads, 1)
    assert.equal(
      gentlemanBrowser.take_image_buffer(originalImageUrl)?.toString(),
      'signed-original'
    )
    assert.isNull(gentlemanBrowser.take_image_buffer(thumbnailUrl))
    assert.isNull(gentlemanBrowser.take_image_buffer(unsignedImageUrl))
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

  test('reuses pagination/detail pages and streams every image buffer to disk', async ({
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
    let createdPages = 0
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

    gentlemanBrowser.new_page = async () => {
      const pageKind = createdPages++ === 0 ? 'list' : 'detail'
      let currentUrl = ''

      return {
        goto: async (url: string) => {
          currentUrl = url
          if (pageKind === 'list') listPageUrls.push(url)
          else detailPageUrls.push(url)
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
      } as any
    }

    const chapter = { name: 'Detail Page Test 1話', url: chapterUrl, imageNum: 2, images: [] }
    try {
      await (service as any).download_chapter_images(chapter)
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.deepEqual(listPageUrls, [chapterUrl, nextChapterPageUrl])
    assert.deepEqual(detailPageUrls, [firstViewUrl, secondViewUrl])
    assert.equal(createdPages, 2)
    assert.equal(closedPages, 2)
    assert.deepEqual(chapter.images, [
      'https://img5.qy0.ru/data/1/1/001.jpg?verify=111--first',
      'https://img5.qy0.ru/data/1/1/002.jpg?verify=222--second',
    ])
    const chapterPath = path.join(downloadPath, 'Detail Page Test', chapter.name)
    assert.equal(fs.readFileSync(path.join(chapterPath, '001.jpg'), 'utf-8'), 'first')
    assert.equal(fs.readFileSync(path.join(chapterPath, '002.jpg'), 'utf-8'), 'second')
    assert.isFalse(fs.existsSync(`${chapterPath}.downloading`))
    assert.isNull(
      gentlemanBrowser.take_image_buffer('https://img5.qy0.ru/data/1/1/002.jpg?verify=222--second')
    )
  })

  test('restarts a frozen browser and resumes pagination from its checkpoint', async ({
    assert,
  }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Pagination Recovery',
      url: 'https://www.wnacg.ru/photos-index-aid-62.html',
    })
    const firstPageUrl = 'https://www.wnacg.ru/photos-index-aid-62.html'
    const secondPageUrl = 'https://www.wnacg.ru/photos-index-page-2-aid-62.html'
    const firstViewUrl = 'https://www.wnacg.ru/photos-view-id-621.html'
    const secondViewUrl = 'https://www.wnacg.ru/photos-view-id-622.html'
    const pageProgressPath = path.join(root, 'pagination-recovery', '.gentleman-pages.jsonl')
    fs.mkdirSync(path.dirname(pageProgressPath), { recursive: true })

    const pages = new Map<string, string>([
      [
        firstPageUrl,
        `<div class="gallary_wrap"><a href="/photos-view-id-621.html">first</a></div>
         <div class="comment_wrap"></div>
         <div class="paginator"><span class="next"><a href="/photos-index-page-2-aid-62.html">後頁</a></span><div class="f_right"></div>`,
      ],
      [
        secondPageUrl,
        `<div class="gallary_wrap"><a href="/photos-view-id-622.html">second</a></div>
         <div class="comment_wrap"></div>`,
      ],
    ])
    const originalNewPage = gentlemanBrowser.new_page
    let newPageCalls = 0
    let secondPageAttempts = 0
    let restartCalls = 0

    gentlemanBrowser.new_page = async () => {
      newPageCalls++
      return { close: async () => {} } as any
    }
    ;(service as any).get_page_html = async (
      _page: unknown,
      url: string,
      options: { retry?: number }
    ) => {
      assert.equal(options.retry, 1)
      if (url === secondPageUrl) {
        secondPageAttempts++
        if (secondPageAttempts === 1) {
          throw new Error(
            `Gentleman 页面重试耗尽: ${url}, 原因: Navigation timeout of 60000 ms exceeded`
          )
        }
      }
      return pages.get(url) || ''
    }
    ;(service as any).restart_gentleman_browser = async (
      _chapterName: string,
      pageUrl: string,
      attempt: number
    ) => {
      restartCalls++
      assert.equal(pageUrl, secondPageUrl)
      assert.equal(attempt, 1)
      return { close: async () => {} } as any
    }

    const chapter = {
      name: 'Pagination Recovery 1話',
      url: firstPageUrl,
      imageNum: 2,
      images: [],
    }
    let viewUrls: string[]
    try {
      viewUrls = await (service as any).get_chapter_view_urls(chapter, pageProgressPath)
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.deepEqual(viewUrls, [firstViewUrl, secondViewUrl])
    assert.equal(newPageCalls, 1)
    assert.equal(secondPageAttempts, 2)
    assert.equal(restartCalls, 1)

    const checkpoints = fs
      .readFileSync(pageProgressPath, 'utf-8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      checkpoints.map((item) => item.pageNumber),
      [1, 2]
    )

    const resumedService = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Pagination Recovery',
      url: firstPageUrl,
    })
    let unexpectedPageCreations = 0
    gentlemanBrowser.new_page = async () => {
      unexpectedPageCreations++
      return { close: async () => {} } as any
    }
    let resumedViewUrls: string[]
    try {
      resumedViewUrls = await (resumedService as any).get_chapter_view_urls(
        chapter,
        pageProgressPath
      )
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.deepEqual(resumedViewUrls, [firstViewUrl, secondViewUrl])
    assert.equal(unexpectedPageCreations, 0)
  })

  test('resumes a merged chapter from its per-image progress log', async ({ assert }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Resume Test',
      url: 'https://www.wnacg.ru/photos-index-aid-9.html',
    })
    const chapterUrl = 'https://www.wnacg.ru/photos-index-aid-9.html'
    const firstViewUrl = 'https://www.wnacg.ru/photos-view-id-91.html'
    const secondViewUrl = 'https://www.wnacg.ru/photos-view-id-92.html'
    const firstImageUrl = 'https://img5.qy0.ru/data/9/1/091.jpg?verify=old'
    const secondImageUrl = 'https://img5.qy0.ru/data/9/1/092.jpg?verify=new'
    const chapterName = 'Resume Test 1話'
    const chapterPath = path.join(downloadPath, 'Resume Test', chapterName)
    const downloadingPath = `${chapterPath}.downloading`
    fs.mkdirSync(downloadingPath, { recursive: true })
    fs.writeFileSync(path.join(downloadingPath, '091.jpg'), 'already-downloaded')
    fs.writeFileSync(
      path.join(downloadingPath, '.gentleman-progress.jsonl'),
      `${JSON.stringify({ viewUrl: firstViewUrl, imageUrl: firstImageUrl, fileName: '091.jpg' })}\n`
    )

    const pages = new Map<string, string>([
      [
        chapterUrl,
        `<div class="gallary_wrap">
          <a href="/photos-view-id-91.html">first</a>
          <a href="/photos-view-id-92.html">second</a>
        </div><div class="comment_wrap"></div>`,
      ],
      [secondViewUrl, `<img id="picarea" src="${secondImageUrl}">`],
    ])
    const detailPageUrls: string[] = []
    const originalNewPage = gentlemanBrowser.new_page
    let createdPages = 0

    gentlemanBrowser.new_page = async () => {
      const pageKind = createdPages++ === 0 ? 'list' : 'detail'
      let currentUrl = ''
      return {
        goto: async (url: string) => {
          currentUrl = url
          if (pageKind === 'detail') detailPageUrls.push(url)
          return { status: () => 200 }
        },
        content: async () => {
          if (currentUrl === secondViewUrl) {
            ;(gentlemanBrowser as any).rememberImageBuffer(
              secondImageUrl,
              Buffer.from('newly-downloaded')
            )
          }
          return pages.get(currentUrl) || ''
        },
        title: async () => 'resume test',
        close: async () => {},
      } as any
    }

    const chapter = { name: chapterName, url: chapterUrl, imageNum: 2, images: [] }
    try {
      await (service as any).download_chapter_images(chapter)
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.deepEqual(detailPageUrls, [secondViewUrl])
    assert.equal(fs.readFileSync(path.join(chapterPath, '091.jpg'), 'utf-8'), 'already-downloaded')
    assert.equal(fs.readFileSync(path.join(chapterPath, '092.jpg'), 'utf-8'), 'newly-downloaded')
    assert.isFalse(fs.existsSync(downloadingPath))
    assert.deepEqual(chapter.images, [firstImageUrl, secondImageUrl])
  })

  test('restarts a frozen browser and retries the current image detail page', async ({
    assert,
  }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Frozen Detail',
      url: 'https://www.wnacg.ru/photos-index-aid-33733485.html',
    })
    const viewUrl = 'https://www.wnacg.ru/photos-view-id-33733485.html'
    const imageUrl = 'https://img5.qy0.ru/data/3373/34/85.jpg?verify=restarted'
    const chapter = {
      name: 'Frozen Detail 1話',
      url: 'https://www.wnacg.ru/photos-index-aid-33733485.html',
      imageNum: 1,
      images: [],
    }
    const originalNewPage = gentlemanBrowser.new_page
    let frozenPageAttempts = 0
    let restartedPageAttempts = 0
    let restartCalls = 0

    ;(service as any).get_chapter_view_urls = async () => [viewUrl]
    gentlemanBrowser.new_page = async () =>
      ({
        goto: async () => {
          frozenPageAttempts++
          throw new Error('Navigation timeout of 60000 ms exceeded')
        },
        close: async () => {},
      }) as any
    ;(service as any).restart_gentleman_browser = async (
      chapterName: string,
      pageUrl: string,
      attempt: number,
      imageCaptureMode: string,
      pageType: string
    ) => {
      restartCalls++
      assert.equal(chapterName, chapter.name)
      assert.equal(pageUrl, viewUrl)
      assert.equal(attempt, 1)
      assert.equal(imageCaptureMode, 'original-only')
      assert.equal(pageType, '图片详情页')

      return {
        goto: async () => {
          restartedPageAttempts++
          return { status: () => 200 }
        },
        content: async () => {
          ;(gentlemanBrowser as any).rememberImageBuffer(imageUrl, Buffer.from('recovered-image'))
          return `<img id="picarea" src="${imageUrl}">`
        },
        title: async () => 'recovered',
        close: async () => {},
      } as any
    }

    try {
      await (service as any).download_chapter_images(chapter)
    } finally {
      gentlemanBrowser.new_page = originalNewPage
    }

    assert.equal(frozenPageAttempts, 1)
    assert.equal(restartCalls, 1)
    assert.equal(restartedPageAttempts, 1)
    assert.deepEqual(chapter.images, [imageUrl])
    assert.equal(
      fs.readFileSync(path.join(downloadPath, 'Frozen Detail', chapter.name, '85.jpg'), 'utf-8'),
      'recovered-image'
    )
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

  test('removes verify parameters from filenames', ({ assert }) => {
    const service = new Gentleman({
      website: 'gentleman',
      id: 1,
      name: 'Verified Download',
      url: 'https://www.wnacg.ru/photos-index-aid-1.html',
    })
    const imageUrl = 'https://img5.qy0.ru/data/3840/66/76_02.jpg?verify=123--signature'

    assert.equal((service as any).get_image_file_name(imageUrl, 0), '76_02.jpg')
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
