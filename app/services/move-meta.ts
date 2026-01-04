import fs from 'fs'
import path from 'path'
import { end_app, copy_folder } from '#utils/index'

class ToZip {
  mangaFloder: string = ''
  outFloder: string = ''
  outPutMetaFloderType: string = ''
  deleteSource: boolean = false
  constructor({
    mangaFloder,
    outFloder,
    outPutMetaFloderType,
    deleteSource = false,
  }: {
    mangaFloder: string
    outFloder: string
    outPutMetaFloderType: string
    deleteSource?: boolean
  }) {
    this.mangaFloder = mangaFloder
    this.outFloder = outFloder
    this.outPutMetaFloderType = outPutMetaFloderType
    this.deleteSource = deleteSource
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
        let oldMetaFolder = `${filePath}-smanga-info`
        if (fs.existsSync(`${filePath}\\.smanga`)) {
          oldMetaFolder = `${filePath}\\.smanga`
        }

        let newMetaFolder = `${this.outFloder}\\${fileName}-smanga-info`
        if (this.outPutMetaFloderType === '.') {
          newMetaFolder = `${this.outFloder}\\${fileName}\\.smanga`
          // 复制为章节封面
          // fs.copyFileSync(newMetaFolder + '\\cover.jpg', newMetaFolder + '\\chapter-cover.jpg')
        }

        if (fs.existsSync(oldMetaFolder)) {
          if (this.deleteSource) {
            fs.renameSync(oldMetaFolder, newMetaFolder)
          } else {
            copy_folder(oldMetaFolder, newMetaFolder)
          }
        }

        // 漫画文件夹为空 跳过
        if (fs.readdirSync(filePath).length === 0) {
          console.log('漫画文件夹为空', fileName)
          continue
        }

        // 压缩漫画文件夹
        await this.zipAndRemoveFolders(filePath, `${this.outFloder}\\${fileName}`)
        console.log('压缩完成', fileName)
        end_app()
      }
    }
    console.log('全部处理完成')
  }

  async zipAndRemoveFolders(sourceDir: string, outputPath: string) {
    try {
      // 读取目录内容
      const items = fs.readdirSync(sourceDir, { withFileTypes: true })

      // 处理每个子文件夹
      for (const item of items) {
        // 文件直接复制
        if (!item.isDirectory() && !/(.cbr|.cbz|.zip)$/.test(item.name)) {
          const sourceFile = path.join(sourceDir, item.name)
          const outputFile = path.join(outputPath, item.name)

          if (sourceFile === outputFile) continue
          if (this.deleteSource) {
            fs.renameSync(sourceFile, outputFile)
          } else {
            fs.copyFileSync(sourceFile, outputFile)
          }
        }
      }
    } catch (err) {
      console.error('处理过程中出错:', err)
    }
  }
}

/*
// 使用示例 - 替换为你的目标目录路径
const targetDirectory = './test'; // 修改为你的目录路径
zipAndRemoveFolders(targetDirectory);
*/

export default ToZip
