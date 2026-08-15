/*
|--------------------------------------------------------------------------
| Test runner entrypoint
|--------------------------------------------------------------------------
|
| The "test.ts" file is the entrypoint for running tests using Japa.
|
| Either you can run this file directly or use the "test"
| command to run this file and monitor file changes.
|
*/

process.env.NODE_ENV = 'test'

// 测试数据目录隔离（必须在任何应用 import 前同步执行）
// 使用 createRequire 保证在 ESM 模块体求值时立即运行，
// 早于后续静态 import 对 utils/index.ts 的加载
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
;(() => {
  const path = require('node:path')
  const fs = require('node:fs')
  // 先设 DATA_DIR，确保后续 ESM import utils 时 dataRoot 正确初始化。
  // 这里不能用 CJS require 加载 TypeScript 源文件；开发目录中不存在 index.js。
  process.env.DATA_DIR = path.resolve('data', 'test-tmp')
  const TEST_DATA_DIR = process.env.DATA_DIR
  const osSuffix =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : 'other'
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'data'), { recursive: true })
  // 复制生产配置到隔离目录（保留 cookie/账号等凭据）
  const prodConfigPath = path.resolve('data', `config.${osSuffix}.json`)
  const testConfigPath = path.join(TEST_DATA_DIR, 'data', `config.${osSuffix}.json`)
  if (fs.existsSync(prodConfigPath) && !fs.existsSync(testConfigPath)) {
    fs.copyFileSync(prodConfigPath, testConfigPath)
  }
})()

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core'
import { configure, processCLIArgs, run } from '@japa/runner'

/**
 * URL to the application root. AdonisJS need it to resolve
 * paths to file and directories for scaffolding commands
 */
const APP_ROOT = new URL('../', import.meta.url)

/**
 * The importer is used to import files in context of the
 * application.
 */
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .testRunner()
  .configure(async (app) => {
    const { runnerHooks, ...config } = await import('../tests/bootstrap.js')

    processCLIArgs(process.argv.splice(2))
    configure({
      ...app.rcFile.tests,
      ...config,
      ...{
        setup: runnerHooks.setup,
        teardown: runnerHooks.teardown.concat([() => app.terminate()]),
      },
    })
  })
  .run(() => run())
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })
