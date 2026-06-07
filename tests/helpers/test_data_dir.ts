import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from '#utils/index'

/** 测试数据根目录（由 bin/test.ts 通过 DATA_DIR 隔离） */
export function getTestDataRoot() {
  return dataRoot.replace(/\/$/, '')
}

export function getTestDataDir() {
  return path.join(getTestDataRoot(), 'data')
}

/** 确保测试数据目录存在 */
export function resetTestDataDir() {
  const dir = getTestDataDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getTestDataFile(fileName: string) {
  return path.join(getTestDataDir(), fileName)
}
