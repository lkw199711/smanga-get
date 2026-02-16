import { log } from "node:console";
import { spawn } from "node:child_process";
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module'
import { s_delete, copy_folder, read_json, end_app, get_config } from "#utils/index";
const require = createRequire(import.meta.url)
const archiver = require('archiver');

class ToZip {
  mangaFloder: string = ''
  outFloder: string = ''
  deleteSource: boolean = false
  constructor(website: string, deleteSource: boolean = false) {
    const websiteConfig = get_config(website)
    if (!websiteConfig) {
      console.log('未配置网站', website)
      return
    }
    this.mangaFloder = websiteConfig.downloadPath
    this.outFloder = websiteConfig.compressPath
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
        const metaFile = `${filePath}-smanga-info\\meta.json`

        if (!fs.existsSync(outMangaPath)) {
          fs.mkdirSync(outMangaPath, { recursive: true })
        }

        // 复制元数据文件夹
        copy_folder(`${filePath}-smanga-info`, `${this.outFloder}\\${fileName}-smanga-info`)
        // await zip_jpg(filePath, `${this.outFloder}\\${fileName}-covers.zip`);
        // 漫画文件夹为空 跳过
        if (fs.readdirSync(filePath).length === 0) {
          console.log('漫画文件夹为空', fileName)
          continue
        }
        // 压缩漫画文件夹
        await zipAndRemoveFolders(filePath, `${this.outFloder}\\${fileName}`)
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


function zip_directory(sourceDir: string, outputPath: string) {
  return new Promise((resolve, reject) => {

    // 创建输出流
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    // 监听完成事件
    output.on('close', () => {
      console.log(`${outputPath} 已创建 (${archive.pointer()} bytes)`);
      resolve(true);
    });

    // 监听错误
    archive.on('error', (err: any) => {
      reject(err);
      throw err;
    });

    // 管道连接
    archive.pipe(output);

    // 添加文件夹内容
    archive.directory(sourceDir, false);

    // 完成归档
    archive.finalize();
  })

}

function zip_jpg(sourceDir: string, outputPath: string) {
  return new Promise((resolve, reject) => {

    // 创建输出流
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    // 监听完成事件
    output.on('close', () => {
      console.log(`${outputPath} 已创建 (${archive.pointer()} bytes)`);
      resolve(true);
    });

    // 监听错误
    archive.on('error', (err: any) => {
      reject(err);
      throw err;
    });

    // 管道连接
    archive.pipe(output);

    // 遍历目录并排除文件
    fs.readdirSync(sourceDir).forEach(file => {
      const fullPath = `${sourceDir}/${file}`;
      if (/(.jpg|.webp)/.test(file)) {
        archive.file(fullPath, { name: file });
      }
    });

    // 完成归档
    archive.finalize();
  })

}

async function zipAndRemoveFolders(sourceDir: string, outputPath: string) {
  try {
    // 读取目录内容
    const items = fs.readdirSync(sourceDir, { withFileTypes: true });

    // 筛选出子文件夹
    // const folders = items.filter(item => item.isDirectory());

    // if (folders.length === 0) {
    //     console.log('没有找到任何子文件夹', sourceDir);
    //     return;
    // }

    // 处理每个子文件夹
    for (const item of items) {
      // 文件直接复制
      if (!item.isDirectory()) {
        const sourceFile = path.join(sourceDir, item.name);
        const outputFile = path.join(outputPath, item.name);
        fs.copyFileSync(sourceFile, outputFile);
        continue;
      }

      if (item.name === '.smanga') {
        // 复制文件夹
        const sourceFile = path.join(sourceDir, item.name);
        const outputFile = path.join(outputPath, item.name);
        copy_folder(sourceFile, outputFile);
        continue;
      }

      // 目录打包zip
      const folderPath = path.join(sourceDir, item.name);
      const zipPath = path.join(outputPath, `${item.name}.zip`);

      // 检查是否存在 zip 文件 存在则跳过
      if (fs.existsSync(zipPath)) {
        // fs.rmSync(zipPath, { recursive: true, force: true });
        continue;
      }

      await zip_directory(folderPath, zipPath)
    }
  } catch (err) {
    console.error('处理过程中出错:', err);
  }
}



/*
// 使用示例 - 替换为你的目标目录路径
const targetDirectory = './test'; // 修改为你的目录路径
zipAndRemoveFolders(targetDirectory);
*/

export default ToZip;
