import Axios from 'axios'
import * as fs from 'fs'

const cookie = 'GTOOMICSlogin_chk_his=Y; GTOOMICSisPrivacyPopup=10; GTOOMICSrecent_login_method=email; GTOOMICSslave=sdb6; GTOOMICS_ab_tid=88728; GTOOMICS_br_sid=27340a7d-efed-43d7-aed7-8fffc5fed697; GTOOMICS_ext_id=t.1.1744794576.67ff73d07b629; GTOOMICSpidIntro=1; GTOOMICSpid_join=pid%3DdefaultPid%26subpid%3DdefaultSubPid%26subpid2%3DdefaultSubPid%26subpid3%3DdefaultSubPid%26channel%3DdefaultChannel; GTOOMICSpid_last=pid%3DdefaultPid%26subpid%3DdefaultSubPid%26subpid2%3DdefaultSubPid%26subpid3%3DdefaultSubPid%26channel%3DdefaultChannel; GTOOMICSstatLnbView=none; GTOOMICSutc_24=2025-04-16++09%3A09%3A40; first_open_episode=loading_bg; GTOOMICSgen=M; GTOOMICSsearch_cookie_zh_tw=%7B%22result%22%3A%5B%225197%22%5D%7D; GTOOMICSsearch_log=%5B%5D; content_lang=zh_cn; GTOOMICSsearch_cookie_zh_cn=%7B%22result%22%3A%5B%225197%22%5D%7D; showCoinDiscountModal=none; GTOOMICSnonlogin_view_list=5197%7C105898%7C2025-04-16+18%3A12%3A29%7C1%7Czh_tw%7C26%2C7616%7C216467%7C2025-04-16+18%3A56%3A16%7C1%7Czh_tw%7C35%2C7230%7C207467%7C2025-04-16+19%3A01%3A07%7C1%7Czh_tw%7C59%2C8080%7C234310%7C2025-04-16+21%3A31%3A47%7C1%7Czh_tw%7C5%2C5197%7C105898%7C2025-04-17+01%3A19%3A16%7C1%7Czh_cn%7C26%2C5197%7C105898%7C2025-04-17+01%3A20%3A30%7C1%7Czh_cn%7C26%2C5197%7C105898%7C2025-04-17+01%3A35%3A17%7C1%7Czh_cn%7C26%2C7616%7C216467%7C2025-04-17+01%3A53%3A00%7C1%7Czh_cn%7C36%2C5197%7C105898%7C2025-04-17+11%3A05%3A25%7C1%7Czh_cn%7C26%2C7616%7C223074%7C2025-04-17+11%3A45%3A11%7C0%7Czh_cn%7C36%2C; backurl=https%3A//toomics.com/sc/webtoon/episode/toon/7616; ecc=NzYxNg%3D%3D%7CMjE2NDY3%7CMQ%3D%3D; GTOOMICScisession=a%3A9%3A%7Bs%3A10%3A%22session_id%22%3Bs%3A32%3A%227b6cbcd9d67301fdde5932107607b239%22%3Bs%3A10%3A%22ip_address%22%3Bs%3A14%3A%22205.198.64.105%22%3Bs%3A10%3A%22user_agent%22%3Bs%3A111%3A%22Mozilla%2F5.0+%28Windows+NT+10.0%3B+Win64%3B+x64%29+AppleWebKit%2F537.36+%28KHTML%2C+like+Gecko%29+Chrome%2F135.0.0.0+Safari%2F537.36%22%3Bs%3A13%3A%22last_activity%22%3Bi%3A1744857840%3Bs%3A7%3A%22display%22%3Bs%3A1%3A%22A%22%3Bs%3A11%3A%22family_mode%22%3Bs%3A1%3A%22N%22%3Bs%3A4%3A%22lang%22%3Bs%3A7%3A%22chinese%22%3Bs%3A8%3A%22lang_seg%22%3Bs%3A2%3A%22sc%22%3Bs%3A10%3A%22tw_adultYN%22%3Bs%3A19%3A%222025-04-17+11%3A46%3A54%22%3B%7Df34cfc54fff658eeff24cf3c7100b8bd8bfc82d7'


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
