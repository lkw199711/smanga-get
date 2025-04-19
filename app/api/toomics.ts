import Axios from 'axios'
import * as fs from 'fs'

const cookie = process.env.TOOMICS_COOKIE

export async function downloadImage(url: string, path: string, reTry: boolean = true) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer' // 设置响应类型为 ArrayBuffer
        });

        // 将图片数据写入文件
        fs.writeFileSync(path, response.data);
        console.log('图片下载成功:', path);
    } catch (error) {

        console.error('下载图片时出错:', error.message, url);

        if (reTry) {
            downloadImage(url, path, false)
        }
    }
}

const axios = Axios.create({
    //   baseURL: 'https://manga.bilibili.com',
    timeout: 5000,
    headers: {
        'Origin': 'https://toomics.com/',
        'Referer': 'https://toomics.com/',
    },
    params: {},
    withCredentials: true,
})

const axiosToomicsByPhone = Axios.create({
    baseURL: 'https://toomics.com',
    headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    },
})

const axiosToomics = Axios.create({
    baseURL: 'https://toomics.com',
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
    },
})

export async function get_html(url: string, useMoblie: boolean = false) {
    if (useMoblie) {
        const res = await axiosToomicsByPhone.get(url)
        return res.data
    } else {
        const res = await axiosToomics.get(url)
        return res.data
    }
}
