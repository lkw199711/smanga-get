import puppeteer from "puppeteer";
import fs from 'fs';
import path from "path";
import { fileURLToPath } from 'url';
import { delay, s_delete } from "#utils/index";
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


function get_all_img(dir: string) {
    const files = fs.readdirSync(dir);
    const imgFiles: string[] = [];

    files.forEach((file, index) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            imgFiles.push(...get_all_img(filePath)); // 递归获取子目录中的图片
        } else if (stat.size < 512 && /\.(jpg|jpeg|png|gif)$/i.test(file)) {
            imgFiles.push(filePath); // 添加图片文件路径
        }
    });

    // if (imgFiles.length > 0) {
    //     console.log(imgFiles);
    // }

    return imgFiles;
}

function check_img_num(dir: string) {
    const files = fs.readdirSync(dir);
    let imgs: any = [];

    files.forEach((file, index) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            check_img_num(filePath); // 递归获取子目录中的图片数量
        } else if (/\.(jpg|jpeg|png|gif)$/i.test(file)) {
            imgs.push(filePath); // 添加图片文件路径
        }
    });

    if (imgs.length === 0) {
        console.log(`目录 ${dir} 没有图片文件`);
        return;
    }

    imgs = imgs.sort((a, b) => a - b);
    const maxImg = imgs[imgs.length - 1];
    const maxImgName = path.basename(maxImg);
    const maxImgNum = parseInt(maxImgName);
    // console.log(`${imgs[imgs.length - 1]} 目录 ${dir} 最大图片序号: ${maxImgNum}, 实际图片数量: ${imgs.length}`);

    maxImgNum + 1 > imgs.length ? console.log(`目录 ${dir} 图片数量异常, 最大图片序号: ${maxImgNum}, 实际图片数量: ${imgs.length}`) : null;
}

function get_all_file(dir: string) {
    const files = fs.readdirSync(dir);
    const imgFiles: string[] = [];

    files.forEach((file, index) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            imgFiles.push(...get_all_file(filePath)); // 递归获取子目录中的图片
        } else if (stat.size < 1048576 && /\.(zip|rar|7z|cbz|cbr)$/i.test(file)) {
            imgFiles.push(filePath); // 添加图片文件路径
        }
    });

    // if (imgFiles.length > 0) {
    //     console.log(imgFiles);
    // }

    return imgFiles;
}

function move_end_file(sourceDir: string, outputDir: string) {
    const files = fs.readdirSync(sourceDir);
    const endFiles: string[] = [];

    files.forEach((file, index) => {
        const filePath = path.join(sourceDir, file);
        if (/smanga-info/.test(file)) return; // 跳过 smanga-info 目录
        const metaFile = `${filePath}-smanga-info\\meta.json`;
        if (!fs.existsSync(metaFile)) return; // 如果没有元数据文件则跳过
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        if (meta.status !== 'Completed') return; // 只处理已完成的漫画
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

    });

    if (endFiles.length > 0) {
        console.log(endFiles);
    }

    return endFiles;
}

function delete_err_cover(dir: string) {
    const files = fs.readdirSync(dir);

    files.forEach((file, index) => {
        const filePath = path.join(dir, file);
        if (/smanga-info/.test(filePath)) {
            info_covers(filePath)
        }
    });

    console.log('处理完毕!');

}

function info_covers(dir: string) {
    const files = fs.readdirSync(dir);
    let coverFile: string[] = []
    files.forEach((file, index) => {
        if (!/cover/.test(file)) return;

        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.size < 512) {
            s_delete(filePath);
            return;
        } // 删除小于512字节的文件
        else {
            coverFile.push(filePath);
        }
    });

    coverFile.forEach((file: string, index) => {
        fs.renameSync(file, `${path.dirname(file)}/cover${index == 0 ? '' : index}.jpg`); // 将所有的 .jpg 文件改为 .png
    })
}
export { demo, get_all_img, get_all_file, check_img_num, delete_err_cover }