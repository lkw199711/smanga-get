import { test } from '@japa/runner'
import { UseBrowser } from '#api/browser'

function makePage() {
  const listeners = new Map<string, Function[]>()

  return {
    async setExtraHTTPHeaders() {},
    async evaluateOnNewDocument() {},
    async setRequestInterception() {},
    on(event: string, listener: Function) {
      listeners.set(event, [...(listeners.get(event) || []), listener])
      return this
    },
  }
}

test.group('browser lifecycle', () => {
  test('close 会在等待 Chromium 退出前清空浏览器引用', async ({ assert }) => {
    const manager = new UseBrowser({ website: 'unit-test' })
    let releaseClose!: () => void
    let closeCalled = false
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve
    })

    manager.browser = {
      connected: true,
      async close() {
        closeCalled = true
        await closing
      },
    } as any

    const closePromise = manager.close()

    assert.isNull(manager.browser)
    assert.isTrue(closeCalled)

    releaseClose()
    await closePromise
  })

  test('new_page 遇到已断开的 Browser 引用时会重新启动并恢复 cookie', async ({ assert }) => {
    const manager = new UseBrowser({ website: 'unit-test' })
    const page = makePage()
    let initCount = 0
    let cookieCount = 0
    let newPageCount = 0

    manager.browser = {
      connected: false,
      async close() {},
    } as any
    manager.init = async () => {
      initCount++
      manager.browser = {
        connected: true,
        async newPage() {
          newPageCount++
          return page
        },
        async close() {},
      } as any
    }
    manager.get_cookie = async () => {
      cookieCount++
    }

    const result = await manager.new_page()

    assert.equal(result, page)
    assert.equal(initCount, 1)
    assert.equal(cookieCount, 1)
    assert.equal(newPageCount, 1)
  })
})
