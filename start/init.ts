import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// @ts-ignore
const cron = require('node-cron');

import { subscribe_read } from '#api/subsribe';
import { bilibiliTask, mangaTask, omegascansTask, toomicsTask } from '#api/task';
import { subsribeType } from '#type/index.js'
import { get_config, set_config, get_os } from '#utils/index';
import ToomicsAll from '#services/toomics-all'
import ToomicsDayUpdate from '#services/toomics-update'
import fs from 'fs'
import OmegaScansUpdate from '#services/omegascans-update'
let subsribeCron: any = { stop: () => { } }
let toomicsScAllCoversCron: any = { stop: () => { } }
let toomicsTcAllCoversCron: any = { stop: () => { } }
let toomicsScUpdateCron: any = { stop: () => { } }
let toomicsTcUpdateCron: any = { stop: () => { } }

const crons = [subsribeCron, toomicsScAllCoversCron, toomicsTcAllCoversCron, toomicsScUpdateCron, toomicsTcUpdateCron];

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
    crons.forEach(cron => {
        if (cron && cron.stop) { cron.stop() }
    })
    // 获取配置
    const scanInterval = config.interval || "0 0 2,14 * * *" // 每天0点和12点执行一次
    // 定时扫描任务
    subsribeCron = cron.schedule(scanInterval, async () => {
        await new OmegaScansUpdate({}).start();
        const subsribe = subscribe_read()
        for (let i = 0; i < subsribe.length; i++) {
            const item: subsribeType = subsribe[i]
            mangaTask.add(item)
        }
    });

    // Toomics 全部封面扫描任务
    toomicsScAllCoversCron = cron.schedule(config.toomicsScAllCoversInterval, async () => { 
        await new ToomicsAll('sc').start()
    })

    // Toomics 全部封面扫描任务
    toomicsTcAllCoversCron = cron.schedule(config.toomicsTcAllCoversInterval, async () => {
        await new ToomicsAll('tc').start()
    })

    // Toomics 更新扫描任务
    toomicsScUpdateCron = cron.schedule(config.toomicsScUpdateInterval, async () => {
        await new ToomicsDayUpdate('sc').start()
    })

    // Toomics 更新扫描任务
    toomicsTcUpdateCron = cron.schedule(config.toomicsTcUpdateInterval, async () => {
        await new ToomicsDayUpdate('tc').start()
    })
}

export function task_allocation() {
    const subsribe = subscribe_read()
    for (let i = 0; i < subsribe.length; i++) {
        const item: subsribeType = subsribe[i]
        mangaTask.add(item)
    }
}