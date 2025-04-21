import { subsribeType } from '#type/index.js';
import fs from 'fs'

const taskFile = process.cwd() + '/task.json'
/**
 * 读取订阅文件
 * @description: 读取订阅文件
 * @returns 
 */
export function task_read() {
    const jsonStr = fs.readFileSync(taskFile, 'utf-8')
    const json = JSON.parse(jsonStr)
    return json;
}

/**
 * 写入订阅文件
 * @description: 写入订阅文件
 * @param json 
 */
export function task_write(json: any) {
    fs.writeFileSync(taskFile, JSON.stringify(json, null, 2), 'utf-8')
}

/**
 * 新增订阅
 * @param param0 
 */
export function task_add({ tasks, website, id, name }: { tasks: subsribeType[], website: string, name: string, id: number }) {
    const task = task_read()
    if (tasks) {
        task.push(...tasks)
    } else {
        task.push({ website, id, name })
    }

    task_write(task)
}

/**
 * 移除订阅
 * @param param0 
 */
export function task_remove({ website, id }: { website: string, id: number }) {
    const task = task_read()
    const index = task.findIndex((item: any) => item.website === website && item.id === id)
    if (index !== -1) {
        task.splice(index, 1)
        task_write(task)
    }
}

class Task {
    tasks: subsribeType[] = []
    running: boolean = false

    constructor(tasks: subsribeType[]) {
        this.tasks = tasks
    }

    run() { }

    get() {
        return this.tasks
    }

    add(task: subsribeType) {
        this.tasks.push(task)
        this.run()
    }

    remove(mangaId: number) {
        const index = this.tasks.findIndex((item) => item.id === mangaId)
        if (index !== -1) {
            this.tasks.splice(index, 1)
            task_write(this.tasks)
        }
    }

    clear() {
        this.tasks = []
    }
}

import Toomics from '#services/toomics'
import Bilibili from '#services/bilibili'
import { write_log } from '#utils/index';
class BilibiliTask extends Task {
    constructor(tasks: subsribeType[]) {
        super(tasks)
    }

    async run() {
        if (this.tasks.length === 0) return;
        if (this.running) return;

        this.running = true
        const task = this.tasks.shift()

        if (!task) {
            this.running = false
            return
        }

        const bilibili = new Bilibili(task)

        await bilibili.start()
            .catch((err) => {
                bilibili.browser?.close()
                write_log(`[Bilibili] ${task.id} ${task.name} 任务执行失败: ${err.message}`)
            })

        this.running = false

        this.run()
    }
}

class ToomicsTask extends Task {
    constructor(tasks: subsribeType[]) {
        super(tasks)
    }

    async run() {
        if (this.tasks.length === 0) return;
        if (this.running) return;

        this.running = true
        const task = this.tasks.shift()

        if (!task) {
            this.running = false
            return
        }

        const toomics = new Toomics(task)
        await toomics.start()
            .catch((err) => {
                write_log(`[Toomics] ${task.id} ${task.name} 任务执行失败: ${err.message}`)
                // 任务放到末尾再次执行
                this.tasks.push(task)
            })

        this.running = false

        this.run()
    }
}

const bilibiliTask = new BilibiliTask([])
const toomicsTask = new ToomicsTask([])

export { bilibiliTask, toomicsTask }