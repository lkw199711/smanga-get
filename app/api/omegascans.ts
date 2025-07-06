import Axios from 'axios'
import * as fs from 'fs'
import https from 'https'

const axios = Axios.create({
    timeout: 30 * 1000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Referer': 'https://omegascans.org/',
        'Origin': 'https://omegascans.org',
        'Cookie': 'ts-session=s%3AeyJtZXNzYWdlIjoieWw2ZDA2OGg3YnQ4bzI1NmF0eWpnczk5IiwicHVycG9zZSI6InRzLXNlc3Npb24ifQ.PznD4_NgOyxnFEvYcDhOOo7kJcMph49HjBe4t_8FFwA'
    },
    withCredentials: true,
    transformRequest: [(data: any, headers: any) => {
        return data;
    }],
    transformResponse: (data: string) => {
        return data;
    }
})

async function download_image(url: string, path: string): Promise<void> {
    const response = await axios({
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

function downloadImage(url: string, savePath: string): Promise<void> {
    const file = fs.createWriteStream(savePath);
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlinkSync(savePath); // 删除无效文件
            reject(err);
        });
    });
}

export { axios, download_image, downloadImage }