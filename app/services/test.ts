import puppeteer from "puppeteer";
import fs from 'fs';
import path from "path";
import { fileURLToPath } from 'url';
import { delay } from "#utils/index";
// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 保存 Base64 图片的函数
const saveBase64Image = (base64Data: any, filepath: string) => {
    const base64Image = base64Data.split(';base64,').pop();
    fs.writeFileSync(filepath, base64Image, { encoding: 'base64' });
};

function demo() {
    const endFile = fs.readFileSync('toomicsEnd.json', 'utf-8')
    const endJson = JSON.parse(endFile)
    const end = endJson.map((item: any) => {
        return {
            website: "toomics",
            ...item
        }
    })

    fs.writeFileSync('toomicsEnd.json', JSON.stringify(end, null, 2), 'utf-8')
}

async function demo1() {
    // 启动无头浏览器
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    page.on('request', request => {
        // if (/ComicDetail/.test(request.url())) { 
        //     console.log(request);
        // }
    });

    page.on('response', async response => {
        if (/ComicDetail/.test(response.url())) {
            console.log(await response.json());
        }
        //console.log(response.url());
    });

    // 打开百度首页
    await page.goto('https://manga.bilibili.com/detail/mc31006', { waitUntil: 'networkidle2' });

    await page.setViewport({ width: 1080, height: 1920 });
    //await delay(1000); // 等待2秒，确保页面加载完成
    //await page.waitForSelector('.list-item.app-button'); // 等待按钮加载完成

    // 获取 img 元素的 Base64 数据
    const base64Image = await page.evaluate(() => {
        const img = document.querySelector('img');
        return img ? img.src : null;
    });

    // 截取屏幕截图并保存到指定路径
    const screenshotPath = path.join(__dirname, 'baidu_homepage.png'); // 保存到当前目录
    await page.screenshot({ path: screenshotPath });

    console.log(`Screenshot saved to ${screenshotPath}`);

    // 关闭浏览器
    await browser.close();
}


export default demo