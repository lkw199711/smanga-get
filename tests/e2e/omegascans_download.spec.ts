import { test } from '@japa/runner'
import { close_all_browsers } from '#api/task'
import OmegaScans from '#services/omegascans'
import { assertOmegaScansDownloadResult } from '#tests/helpers/download_assertions'
import {
  createOmegaScansE2EContext,
  isOmegaScansE2EEnabled,
  type OmegaScansE2EContext,
} from '#tests/helpers/omegascans_e2e_env'

test('OmegaScans 可抓取元数据并下载两个章节', async ({ assert }) => {
  if (!isOmegaScansE2EEnabled()) {
    console.log('[omegascans e2e] OMEGASCANS_E2E_ENABLED 未开启，跳过真实网站测试')
    return
  }

  let context: OmegaScansE2EContext | null = null

  try {
    context = createOmegaScansE2EContext()

    const reporter = {
      setTotal() {},
      report(message: string) {
        console.log(`[omegascans e2e] ${message}`)
      },
      message(message: string) {
        console.log(`[omegascans e2e] ${message}`)
      },
      subProgress(current: number, total: number) {
        console.log(`[omegascans e2e] 图片进度 ${current}/${total}`)
      },
    }

    await new OmegaScans(context.task, reporter).start()

    assertOmegaScansDownloadResult(assert, {
      downloadPath: context.downloadPath,
      minChapterCount: 2,
      minImageSize: 250,
    })
  } finally {
    await close_all_browsers()
    context?.cleanup()
  }
})
