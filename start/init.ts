import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// @ts-ignore
const cron = require('node-cron');

import { subscribe_read } from '#api/subsribe';
import { bilibiliTask, toomicsTask } from '#api/task';
import { subsribeType } from '#type/index.js'
let subsribeCron: any = { stop: () => { } }

export function create_scan_cron() {
    // 停止旧扫描任务
    subsribeCron.stop()
    // 获取配置
    const scanInterval = process.env.CRON || "0 0 0,12 * * *" // 每天0点和12点执行一次
    // 定时扫描任务
    subsribeCron = cron.schedule(scanInterval, async () => {
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