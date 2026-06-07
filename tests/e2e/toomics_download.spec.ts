import { test } from '@japa/runner'
import { close_all_browsers } from '#api/task'
import Toomics from '#services/toomics'
import { assertToomicsDownloadResult } from '#tests/helpers/download_assertions'
import {
  createToomicsE2EContext,
  isToomicsE2EEnabled,
  type ToomicsE2EContext,
} from '#tests/helpers/toomics_e2e_env'

test('Toomics 可抓取元数据并下载两个章节', async ({ assert }) => {
  if (!isToomicsE2EEnabled()) {
    console.log('[toomics e2e] TOOMICS_E2E_ENABLED 未开启，跳过真实网站测试')
    return
  }

  let context: ToomicsE2EContext | null = null

  try {
    context = createToomicsE2EContext()

    const reporter = {
      setTotal() {},
      report(message: string) {
        console.log(`[toomics e2e] ${message}`)
      },
      message(message: string) {
        console.log(`[toomics e2e] ${message}`)
      },
    }

    await new Toomics(context.task, reporter).start()

    assertToomicsDownloadResult(assert, {
      downloadPath: context.downloadPath,
      minChapterCount: 2,
      minImageSize: 250,
    })
  } finally {
    await close_all_browsers()
    context?.cleanup()
  }
})
