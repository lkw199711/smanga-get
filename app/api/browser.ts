import puppeteer from "puppeteer";

// 监听异常退出事件
process.on('SIGINT', cleanup);   // Ctrl+C 退出
process.on('SIGTERM', cleanup);  // 进程终止信号
process.on('uncaughtException', cleanup); // 未捕获异常

const browser = await puppeteer.launch({
    headless: true,
    timeout: 60 * 1000,
    args: ['--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',// 容器环境必备参数‌:ml-citation{ref="5,6" data="citationList"}
        '--disable-blink-features=AutomationControlled', // 隐藏自动化特征‌:ml-citation{ref="3" data="citationList"}
        '--disable-web-security',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--lang=zh-CN,zh', // 设置浏览器语言
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
    ],
    defaultViewport: {
        width: 1920,
        height: 1440,
    },
})

const browserPhone = await puppeteer.launch({
    headless: true,
    timeout: 60 * 1000,
    args: ['--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',// 容器环境必备参数‌:ml-citation{ref="5,6" data="citationList"}
        '--disable-blink-features=AutomationControlled', // 隐藏自动化特征‌:ml-citation{ref="3" data="citationList"}
        '--disable-web-security',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--lang=zh-CN,zh', // 设置浏览器语言
        '--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' // 最新版UA‌:ml-citation{ref="4" data="citationList"}
    ],
    defaultViewport: {
        width: 1920,
        height: 1440,
    },
})

async function cleanup() {
    await browser.close();
    await browserPhone.close();
}

export { browser, browserPhone }