import fs from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const archiver = require('archiver');

export async function zip_directory(sourceDir: string, outputPath: string) {
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
