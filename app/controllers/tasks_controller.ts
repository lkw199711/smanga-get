import type { HttpContext } from '@adonisjs/core/http'
import { mangaTask } from '#api/task'
import { subscribe_read } from '#api/subsribe'
import type { subsribeType } from '#type/index.js'
import { write_log } from '#utils/index'

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
            manga: mangaTask.get(),
            running: mangaTask.getRunning(),
        }
    }

    reorder({ request }: HttpContext) {
        const { tasks } = request.all()

        if (!Array.isArray(tasks)) {
            return {
                code: 400,
                message: '任务排序参数无效',
            }
        }

        const nextTasks = mangaTask.reorder(tasks)

        return {
            code: 200,
            message: '任务顺序已更新',
            tasks: nextTasks,
        }
    }

    trigger({ request }: HttpContext) {
        const { type } = request.all() as { type?: TaskTriggerType }

        if (type === 'toomics') {
            // 由于简体中文 大陆地区漫画停更 暂不执行sc任务
            // mangaTask.add({ website: 'toomics-covers-sc', id: 0, name: 'Toomics 简体订阅扫描' })
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
        const { website, id, name, taskId } = request.all()
        mangaTask.remove({ website, id, name, taskId })

        return {
            code: 200,
            message: 'Task removed successfully',
        }
    }

    clear() {
        mangaTask.clear()

        return {
            code: 200,
            message: '任务队列已清空',
        }
    }
}
