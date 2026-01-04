import fs from 'fs'
import path from 'path'
import { copy_folder, end_app } from '#utils/index'

class ToZip {
  mangaFloder: string = ''
  outFloder: string = ''
  deleteSource: boolean = false
  constructor(mangaFloder: string, outFloder: string) {
    this.mangaFloder = mangaFloder
    this.outFloder = outFloder
  }

  async start() {
    const items = fs.readdirSync(this.mangaFloder)
    for (let i = 0; i < items.length; i++) {
      const fileName = items[i]
      const filePath = path.join(this.mangaFloder, fileName)
      const outMangaPath = path.join(this.outFloder, fileName)

      if (/zip/.test(fileName)) {
        console.log('跳过压缩包', fileName)
        continue
      } else if (/smanga-info/.test(fileName)) {
      } else {
        if (!fs.existsSync(outMangaPath)) {
          fs.mkdirSync(outMangaPath, { recursive: true })
        }

        // 复制元数据文件夹
        copy_folder(`${filePath}-smanga-info`, `${this.outFloder}\\${fileName}-smanga-info`)

        // 漫画文件夹为空 跳过
        if (fs.readdirSync(filePath).length === 0) {
          console.log('漫画文件夹为空', fileName)
          continue
        }

        // 压缩漫画文件夹
        await zipAndRemoveFolders(filePath, `${this.outFloder}\\${fileName}`)
        console.log('压缩完成', fileName)
        end_app()
      }
    }
    console.log('全部处理完成')
  }

  getMangaList(directoryPath: string) {
    const items = fs.readdirSync(directoryPath, { withFileTypes: false })
    const folders = items.filter((item) => {
      if (/smanga-info/.test(item)) {
        return false
      }

      return true
    })

    return folders.map((folder) => path.join(directoryPath, folder))
  }
}

async function zipAndRemoveFolders(sourceDir: string, outputPath: string) {
  try {
    // 读取目录内容
    const items = fs.readdirSync(sourceDir, { withFileTypes: true })

    // 处理每个子文件夹
    for (const item of items) {
      // 文件直接复制
      if (!item.isDirectory() && !/(.cbz|.cbr|.zip)$/.test(item.name)) {
        const sourceFile = path.join(sourceDir, item.name)
        const outputFile = path.join(outputPath, item.name)
        if (sourceFile === outputFile) continue
        fs.copyFileSync(sourceFile, outputFile)
      }
    }
  } catch (err) {
    console.error('处理过程中出错:', err)
  }
}

/*
// 使用示例 - 替换为你的目标目录路径
const targetDirectory = './test'; // 修改为你的目录路径
zipAndRemoveFolders(targetDirectory);
*/

export default ToZip
