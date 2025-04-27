import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// @ts-ignore
const cron = require('node-cron');

import { subscribe_read } from '#api/subsribe';
import { bilibiliTask, toomicsTask } from '#api/task';
import { subsribeType } from '#type/index.js'
import { get_config, set_config, get_os } from '#utils/index';
import ToomicsAll from '#services/toomics-all'
import ToomicsDayUpdate from '#services/toomics-day-update'
import fs from 'fs'
let subsribeCron: any = { stop: () => { } }

const linuxStr = get_os() === 'Linux' ? '/' : ''
const dataPath = linuxStr + 'data/'

export function create_config() {
    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true })
    }
    
    if (get_config()) return;

    set_config({
        "headless": true,
        "cronInterval": "0 0 10,22 * * *",
        "endAfterSetCookie": false,
        "autoRemoveSubscribe": true,
        "toomics": {
            "userName": "lkw199711@163.com",
            "passWord": "123qwe",
            "downloadLockedMeta": false,
            "cookieFile": "data/toomics-cookies.json",
            "scrollStep": 800,
            "scrollDelay": 500,
            "downloadPath": "M:\\manga"
        },
        "bilibili": {
            "cookieFile": "data/bilibili-cookies.json",
            "downloadLockedMeta": false,
            "scrollStep": 1000,
            "scrollDelay": 500,
            "downloadPath": "M:\\manga"
        }
    })

}

export function create_scan_cron() {
    // 停止旧扫描任务
    subsribeCron.stop()
    // 获取配置
    const scanInterval = get_config().cronInterval || "0 0 0,12 * * *" // 每天0点和12点执行一次
    // 定时扫描任务
    subsribeCron = cron.schedule(scanInterval, async () => {
        await new ToomicsAll().start()
        await new ToomicsDayUpdate().start()
        const subsribe = subscribe_read()
        for (let i = 0; i < subsribe.length; i++) {
            const item: subsribeType = subsribe[i]
            if (item.website === 'toomics') {
                toomicsTask.add(item)
            } else if (item.website === 'bilibili') {
                bilibiliTask.add(item)
            } else {
                continue;
            }
        }
    });
}

export function task_allocation() {
    const subsribe = subscribe_read()
    for (let i = 0; i < subsribe.length; i++) {
        const item: subsribeType = subsribe[i]
        if (item.website === 'toomics') {
            toomicsTask.add(item)
        } else if (item.website === 'bilibili') {
            bilibiliTask.add(item)
        } else {
            continue;
        }
    }
}