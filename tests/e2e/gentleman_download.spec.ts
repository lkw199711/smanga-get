import { test } from '@japa/runner'
import { close_all_browsers } from '#api/task'
import Gentleman from '#services/gentleman'
import { assertGentlemanDownloadResult } from '#tests/helpers/download_assertions'
import {
  createGentlemanE2EContext,
  isGentlemanE2EEnabled,
  type GentlemanE2EContext,
} from '#tests/helpers/gentleman_e2e_env'

test('Gentleman 可打开网站并下载两个章节', async ({ assert }) => {
  if (!isGentlemanE2EEnabled()) {
    console.log('[gentleman e2e] GENTLEMAN_E2E_ENABLED 未开启，跳过真实网站测试')
    return
  }

  let context: GentlemanE2EContext | null = null

  try {
    context = createGentlemanE2EContext()

    const reporter = {
      setTotal() {},
      report(message: string) {
        console.log(`[gentleman e2e] ${message}`)
      },
      message(message: string) {
        console.log(`[gentleman e2e] ${message}`)
      },
      subProgress(current: number, total: number) {
        console.log(`[gentleman e2e] 图片进度 ${current}/${total}`)
      },
    }

    await new Gentleman(context.task, reporter).start()

    assertGentlemanDownloadResult(assert, {
      downloadPath: context.downloadPath,
      minChapterCount: 2,
      minImageSize: 250,
    })
  } finally {
    await close_all_browsers()
    context?.cleanup()
  }
})
