/*
 * @Author: lkw199711 lkw199711@163.com
 * @Date: 2024-10-01 00:04:30
 * @LastEditors: lkw199711 lkw199711@163.com
 * @LastEditTime: 2024-10-01 00:08:28
 * @FilePath: \manga-get\app\api\index.ts
 */
import Axios from 'axios'
import * as fs from 'fs'

const cookie = `buvid3=1C68BCE1-EA26-6132-4BC3-4CB18AA6221B07705infoc; b_nut=1714325807; _uuid=F97F958F-110110-CFFF-10A107-DE4928AF3FFD08030infoc; rpdid=0zbfvRPG2A|cnMxLwKO|2gE|3w1S18Hg; iflogin_when_web_push=0; DedeUserID=331165645; DedeUserID__ckMd5=ffc0cdbb2bc9b2c3; buvid4=F0780AFB-2952-1BA1-CB32-3A984C3328DF59297-022100809-H07TdPlUhTJv6hHC%2F5gV0Q%3D%3D; buvid_fp_plain=undefined; LIVE_BUVID=AUTO2017145763743724; hit-dyn-v2=1; enable_web_push=DISABLE; header_theme_version=CLOSE; PVID=1; share_source_origin=COPY; CURRENT_QUALITY=120; bsource=search_baidu; CURRENT_BLACKGAP=0; dy_spec_agreed=1; CURRENT_FNVAL=4048; fingerprint=f54ea4c926a7bf3f7f561e09fa018462; bili_ticket=eyJhbGciOiJIUzI1NiIsImtpZCI6InMwMyIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3Mjc5NzM0NTksImlhdCI6MTcyNzcxNDE5OSwicGx0IjotMX0.mAKE9hGvUgty5uTRL09GoAGgOrVZ8OalNMF0YZg8B8k; bili_ticket_expires=1727973399; SESSDATA=a908c8d4%2C1743278922%2C10311%2Aa1CjAk-hhdRE2FVvyTym8c41HCVaBiWyTRSzRUzlgvSKZRY5lUh9uai5GzpupXEaRdMpQSVmhfZ1FBTlNXZ3F2UFhsc2RSVzB0dHpSMkstdEt3UFlFZlJhTmxGRzVnNXljSGtqY2xPeFI0VTFhMG1oOFJENWJQc0NtdGRNR0JlWFMxR3VLNDJzSUVRIIEC; bili_jct=022d5a7c09d31d09887b9c30795a4c95; sid=7o3yqt3o; buvid_fp=f54ea4c926a7bf3f7f561e09fa018462; bp_t_offset_331165645=983392032967884800; home_feed_column=4; browser_resolution=1340-777; b_lsid=8149A511_19249AE595A`

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

const axios = Axios.create({
  //   baseURL: 'https://manga.bilibili.com',
  timeout: 5000,
  headers: {
    // 'Content-Type': 'application/json',
    // 'Cookie': cookie,
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
