import { get_all_file } from './test.js'
import { s_delete } from '#utils/index'
import fs from 'fs'
import path from 'path'

class RemoveDuplicates {
  mangaFloder: string = ''
  constructor(mangaFloder: string, outFloder: string) {
    this.mangaFloder = mangaFloder
  }

  /**
   * 移除重复文件
   */
  async start() {
    remove_duplicates(this.mangaFloder)
  }
}

function remove_duplicates(mangaFloder: string) {
  const files = fs.readdirSync(mangaFloder)
  for (const file of files) {
    // 是路径则递归
    if (fs.statSync(path.join(mangaFloder, file)).isDirectory()) {
      remove_duplicates(path.join(mangaFloder, file))
      continue
    }

    if (!file.endsWith('.zip')) {
      continue
    }

    const baseName = path.basename(file, '.zip')
    const duplicateFile = path.join(mangaFloder, baseName + ' 1.zip')
    if (fs.existsSync(duplicateFile)) {
      s_delete(duplicateFile)
      console.log(`删除重复文件: ${duplicateFile}`)
    }
  }
}

export default RemoveDuplicates
