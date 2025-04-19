/*
 * @Author: 梁楷文 lkw199711@163.com
 * @Date: 2024-09-30 10:48:36
 * @LastEditors: lkw199711 lkw199711@163.com
 * @LastEditTime: 2024-11-17 18:09:56
 * @FilePath: \manga-get\app\utils\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import sharp from 'sharp';
import Axios from 'axios'
import * as fs from 'fs'
export async function downloadImage(url: string, path: string): Promise<void> {
  const response = await Axios({
    method: 'get',
    url,
    responseType: 'stream',
  })

  const writer = fs.createWriteStream(path)
  response.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

export function read_json(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/**
 * 
 * @param ms 延迟的时间，单位为毫秒
 * @description: 延迟函数，使用Promise实现
 * @returns 
 */
export async function delay(ms: number) {
  return new Promise(resolve => {
    const now = new Date().getTime();
    const target = now + ms;

    while (new Date().getTime() < target) {
      continue;
    }

    resolve(true); // 延时结束，返回结果
  });
};

export function saveBase64Image(base64Data: any, filepath: string) {
  const base64Image = base64Data.split(';base64,').pop();
  fs.writeFileSync(filepath, base64Image, { encoding: 'base64' });
}

export function write_log(logContent: string) {
  console.log(logContent);
  fs.appendFileSync('log.txt', logContent + '\n', 'utf-8');
}