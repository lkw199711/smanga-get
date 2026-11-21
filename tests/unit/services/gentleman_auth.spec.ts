import { test } from '@japa/runner'
import { inspectGentlemanAccessPage } from '#services/gentleman-auth'

test.group('Gentleman auth probe', () => {
  test('匿名韩漫拦截页判定为需要登录', ({ assert }) => {
    const result = inspectGentlemanAccessPage(`
      <html><body>
        <div>您要訪問的漫畫不存在！</div>
        <a href="/users-login.html">點擊這裡登錄</a>
      </body></html>
    `, { status: 200 })

    assert.equal(result.state, 'login-required')
  })

  test('登录后的韩漫分类列表判定为可访问', ({ assert }) => {
    const result = inspectGentlemanAccessPage(`
      <div class="gallary_wrap">
        <li><a href="/photos-index-aid-1.html">作品</a></li>
      </div>
    `, { status: 200 })

    assert.equal(result.state, 'authenticated')
  })

  test('安全验证页不会误判为 Cookie 失效', ({ assert }) => {
    const result = inspectGentlemanAccessPage(
      '<html><title>Just a moment...</title><div id="challenge-platform"></div></html>',
      { status: 403, title: 'Just a moment...' }
    )

    assert.equal(result.state, 'unexpected')
    assert.include(result.reason, '安全验证')
  })

  test('未知页面不会被误判为已登录', ({ assert }) => {
    const result = inspectGentlemanAccessPage('<html><body>maintenance</body></html>', {
      status: 200,
    })

    assert.equal(result.state, 'unexpected')
  })
})
