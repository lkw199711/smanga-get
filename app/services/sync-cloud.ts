import fs from 'fs'
import path from 'path'
import { copy_folder, end_app, get_config, update_sync_cloud_time } from '#utils/index'

class SyncCloud {
  mangaFloder: string = ''
  outFloder: string = ''
  outPutMetaFloderType: string = ''
  deleteSource: boolean = false
  latestSyncCloud: number = 0
  website: string = ''
  constructor(website = '', outPutMetaFloderType = '.', deleteSource = false) {
    const config = get_config(website)
    if (!config) {
      console.log('未配置网站', website)
      return
    }
    this.mangaFloder = config.compressPath
    this.outFloder = config.cloudPath
    this.outPutMetaFloderType = outPutMetaFloderType
    this.deleteSource = deleteSource
    this.latestSyncCloud = config.latestSyncCloud
    this.website = website
    console.log(this.mangaFloder, this.outFloder, '最新同步时间', this.latestSyncCloud)
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
        }

        if (fs.existsSync(oldMetaFolder)) {
          // skip if meta folder is not modified
          const stat = fs.statSync(oldMetaFolder)
          if (stat.mtimeMs <= this.latestSyncCloud) continue

          copy_folder(oldMetaFolder, newMetaFolder)
        }

        // 漫画文件夹为空 跳过
        if (fs.readdirSync(filePath).length === 0) {
          console.log('漫画文件夹为空', fileName)
          continue
        }

        // 压缩漫画文件夹
        await this.zipAndRemoveFolders(
          filePath,
          `${this.outFloder}\\${fileName}`,
          this.latestSyncCloud
        )

        // 更新最新同步时间
        update_sync_cloud_time(this.website)

        console.log('压缩完成', fileName)
        end_app()
      }
    }
    console.log('全部处理完成')
  }

  async zipAndRemoveFolders(sourceDir: string, outputPath: string, latestSyncCloud: number) {
    try {
      // 读取目录内容
      const items = fs.readdirSync(sourceDir, { withFileTypes: true })

      // 处理每个子文件夹
      for (const item of items) {
        // 不复制文件夹
        if (item.isDirectory()) continue

        const sourceFile = path.join(sourceDir, item.name)
        const outputFile = path.join(outputPath, item.name)

        if (sourceFile === outputFile) continue

        // skip if file is not modified
        const stat = fs.statSync(sourceFile)
        if (stat.mtimeMs <= latestSyncCloud) continue

        fs.copyFileSync(sourceFile, outputFile)

        console.log('复制完成', item.name)
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

export default SyncCloud
