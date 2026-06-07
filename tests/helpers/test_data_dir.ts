import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataRoot } from '#utils/index'

/** 生产数据目录（dataRoot + 'data/'），与 get_config 读写的 config.json 同路径 */
export function getTestDataRoot() {
  return dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
}

export function getTestDataDir() {
  return path.join(getTestDataRoot(), 'data')
}

/** 为 unit 测试重置隔离数据目录（清空后初始化空 config.json） */
export function resetTestDataDir() {
  const dir = getTestDataDir()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getTestDataFile('config.json'), JSON.stringify({}, null, 2), 'utf-8')
  return dir
}

export function getTestDataFile(fileName: string) {
  return path.join(getTestDataDir(), fileName)
}
