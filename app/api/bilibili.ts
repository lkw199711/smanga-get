
import Axios from 'axios'
import * as fs from 'fs'

const cookie = process.env.BILIBILI_COOKIE;
const axios = Axios.create({
    baseURL: 'https://manga.bilibili.com',
    timeout: 5000,
    headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'Origin': 'https://manga.bilibili.com',
    },
    params: {
        device: 'pc',
        platform: 'web',
    },
    withCredentials: true,
})

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

export async function image_index(ep_id: number) {
  const GetImageIndexURL = 'https://manga.bilibili.com/twirp/comic.v1.Comic/GetImageIndex'
  const res = await axios.post(GetImageIndexURL, { ep_id })
  const data = res.data.data
  const images = data.images
  return images
}