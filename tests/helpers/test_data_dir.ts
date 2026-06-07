import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataRoot } from '#utils/index'

export function getTestDataRoot() {
  return dataRoot || path.join(os.tmpdir(), 'smanga-get-tests')
}

export function getTestDataDir() {
  return path.join(getTestDataRoot(), 'data')
}

export function resetTestDataDir() {
  const root = getTestDataRoot()

  if (!root.includes('smanga-get-tests')) {
    throw new Error(`拒绝清理非测试目录: ${root}`)
  }

  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(getTestDataDir(), { recursive: true })
  fs.writeFileSync(getTestDataFile('config.json'), JSON.stringify({}, null, 2), 'utf-8')

  return getTestDataDir()
}

export function getTestDataFile(fileName: string) {
  return path.join(getTestDataDir(), fileName)
}
