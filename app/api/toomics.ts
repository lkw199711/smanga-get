import Axios from 'axios'
import * as fs from 'fs'

const cookie = process.env.TOOMICS_COOKIE

export async function downloadImage(url: string, path: string) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer' // 设置响应类型为 ArrayBuffer
        });

        // 将图片数据写入文件
        fs.writeFileSync(path, response.data);
        console.log('图片下载成功:', path);
    } catch (error) {
        console.error('下载图片时出错:', error.message);
    }
}

const axios = Axios.create({
    //   baseURL: 'https://manga.bilibili.com',
    timeout: 5000,
    headers: {
        // 'Content-Type': 'application/json',
        'Cookie': cookie,
        // 'Origin': 'https://manga.bilibili.com',
        'Referer': 'https://toomics.com/',
    },
    params: {
        device: 'pc',
        platform: 'web',
    },
    withCredentials: true,
})

const axiosToomics = Axios.create({
    baseURL: 'https://toomics.com',
    headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    },
})

export async function get_meta(comic_id: number) {
    const ComicDetailUrl = 'https://manga.bilibili.com/twirp/comic.v1.Comic/ComicDetail'
    const res = await axios.post(ComicDetailUrl, { comic_id })
    const data = res.data.data

    const chapters = data.ep_list.map((item: any) => {
        return {
            targetId: item.id,
            title: item.title,
            ord: item.ord,
            payMode: item.pay_mode === 1,
            payGold: item.gold,
            isLocked: item.is_locked,
            isFree: item.is_in_free,
            cover: item.cover,
            publishDate: item.pub_time,
            size: item.size,
            count: item.image_count,
        }
    })

    const meta = {
        targetId: data.id,
        title: data.title,
        horizontalCover: data.horizontal_cover,
        squareCover: data.square_cover,
        verticalCover: data.vertical_cover,
        author: data.author_name.join(','),
        classify: data.styles.join(','),
        laster: data.last_ord,
        finished: data.is_finish === 1,
        describe: data.evaluate,
        count: data.total,
        tags: data.tags,
        publishDate: data.release_time,
        updateDate: data.renewal_time,
        payMode: data.pay_mode === 1,
        banners: data.horizontal_covers,
        chapters: chapters,
    }

    return meta
}

export async function image_index(ep_id: number) {
    const GetImageIndexURL = 'https://manga.bilibili.com/twirp/comic.v1.Comic/GetImageIndex'
    const res = await axios.post(GetImageIndexURL, { ep_id })
    const data = res.data.data
    const images = data.images
    return images
}

export async function image_token(paths: string[]) {
    const ImageTokenURL = 'https://manga.bilibili.com/twirp/comic.v1.Comic/ImageToken'
    const res = await axios.post(ImageTokenURL, {
        urls: JSON.stringify(paths),
    })
    const data = res.data.data
    return data
}

export async function get_html(url: string) {
    const res = await axiosToomics.get(url)
    return res.data
}
