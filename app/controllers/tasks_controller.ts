import type { HttpContext } from '@adonisjs/core/http'
import { bilibiliTask, mangaTask, omegascansTask, toomicsTask } from '#api/task'
import { subscribe_read } from '#api/subsribe'
import type { subsribeType } from '#type/index.js'
import { write_log } from '#utils/index'

const taskQueues = {
    bilibili: bilibiliTask,
    toomics: toomicsTask,
    omegascans: omegascansTask,
    manga: mangaTask,
}

type TaskTriggerType = 'toomics' | 'toptoon' | 'omegascans' | 'gentleman'

function addSubscribeTasks(website: string) {
    const subscribes = subscribe_read()
    const tasks = subscribes.filter((item: subsribeType) => item.website === website)

    tasks.forEach((task: subsribeType) => {
        mangaTask.add(task)
    })

    return tasks.length
}

export default class TasksController {

    add({ request }: HttpContext) {
        const { website, id, name, mangaUrl, moveEndSubscribe } = request.all()

        mangaTask.add({ website, id, name, 
            url: mangaUrl, 
            moveEndSubscribe })

        write_log(`[task]${website} ${id} ${name} 任务添加成功`)

        return {
            code: 200,
            message: 'Task added successfully',
        }
    }

    get() {
        return {
            bilibili: bilibiliTask.get(),
            toomics: toomicsTask.get(),
            omegascans: omegascansTask.get(),
            manga: mangaTask.get(),
            running: {
                bilibili: bilibiliTask.getRunning(),
                toomics: toomicsTask.getRunning(),
                omegascans: omegascansTask.getRunning(),
                manga: mangaTask.getRunning(),
            },
        }
    }

    reorder({ request }: HttpContext) {
        const { queue, tasks } = request.all()
        const taskQueue = taskQueues[queue as keyof typeof taskQueues]

        if (!taskQueue || !Array.isArray(tasks)) {
            return {
                code: 400,
                message: '任务排序参数无效',
            }
        }

        const nextTasks = taskQueue.reorder(tasks)

        return {
            code: 200,
            message: '任务顺序已更新',
            tasks: nextTasks,
        }
    }

    trigger({ request }: HttpContext) {
        const { type } = request.all() as { type?: TaskTriggerType }

        if (type === 'toomics') {
            mangaTask.add({ website: 'toomics-covers-sc', id: 0, name: 'Toomics 简体订阅扫描' })
            mangaTask.add({ website: 'toomics-covers-tc', id: 0, name: 'Toomics 繁体订阅扫描' })

            write_log('[task]Toomics 订阅任务已添加')

            return {
                code: 200,
                message: 'Toomics 订阅任务已添加',
                count: 2,
            }
        }

        if (type === 'omegascans') {
            mangaTask.add({ website: 'omegascans-update', id: 0, name: 'OmegaScans 订阅扫描' })

            write_log('[task]OmegaScans 订阅任务已添加')

            return {
                code: 200,
                message: 'OmegaScans 订阅任务已添加',
                count: 1,
            }
        }

        if (type === 'gentleman') {
            const count = addSubscribeTasks('gentleman')

            write_log(`[task]Gentleman 订阅任务已添加 ${count} 个`)

            return {
                code: 200,
                message: `Gentleman 订阅任务已添加 ${count} 个`,
                count,
            }
        }

        if (type === 'toptoon') {
            return {
                code: 400,
                message: 'Toptoon 订阅任务暂未实现',
            }
        }

        return {
            code: 400,
            message: '任务触发类型无效',
        }
    }

    remove({ request }: HttpContext) {
        const { website, id } = request.all()

        if (website === 'toomics') {
            toomicsTask.remove(id)
        } else if (website === 'bilibili') {
            bilibiliTask.remove(id)
        } else if (website === 'omegascans') {
            omegascansTask.remove(id)
        } else {
            // 主任务队列 mangaTask 处理所有类型
            mangaTask.remove(id)
        }

        return {
            code: 200,
            message: 'Task removed successfully',
        }
    }

    clear({ request }: HttpContext) {
        const { website } = request.all()

        if (website === 'toomics') {
            toomicsTask.clear()
        } else if (website === 'bilibili') {
            bilibiliTask.clear()
        } else if (website === 'omegascans') {
            omegascansTask.clear()
        } else if (website === 'manga') {
            mangaTask.clear()
        } else if (!website) {
            bilibiliTask.clear()
            toomicsTask.clear()
            omegascansTask.clear()
            mangaTask.clear()
        } else {
            return {
                code: 400,
                message: '任务队列无效',
            }
        }

        return {
            code: 200,
            message: '任务队列已清空',
        }
    }
}
