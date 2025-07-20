import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// @ts-ignore
const cron = require('node-cron');

import { subscribe_read } from '#api/subsribe';
import { bilibiliTask, omegascansTask, toomicsTask } from '#api/task';
import { subsribeType } from '#type/index.js'
import { get_config, set_config, get_os } from '#utils/index';
import ToomicsAll from '#services/toomics-all'
import ToomicsDayUpdate from '#services/toomics-update'
import fs from 'fs'
import OmegaScansUpdate from '#services/omegascans-update'
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
        "cron": {
            "enable": false,
            "interval": "0 0 11,23 * * *"
        },
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
    const config = get_config().cron;
    if (!config?.enable) return;
    // 停止旧扫描任务
    subsribeCron.stop()
    // 获取配置
    const scanInterval = config.interval || "0 0 2,14 * * *" // 每天0点和12点执行一次
    // 定时扫描任务
    subsribeCron = cron.schedule(scanInterval, async () => {
        await new ToomicsAll('sc').start()
        await new ToomicsAll('tc').start()
        await new ToomicsDayUpdate('sc').start()
        await new ToomicsDayUpdate('tc').start()
        await new OmegaScansUpdate({}).start();
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
        } else if (item.website === 'omegascans') { 
            omegascansTask.add(item)
        } else {
            continue;
        }
    }
}