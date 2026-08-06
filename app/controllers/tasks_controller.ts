import type { HttpContext } from '@adonisjs/core/http'
import { mangaTask } from '#api/task'
import { subscribe_read } from '#api/subsribe'
import type { subsribeType } from '#type/index.js'
import { write_log } from '#utils/index'
import { repair_meta_queue, scan_broken_meta, clean_legacy_meta_dirs } from '../../start/init.js'
import { normalizeImportedTasks } from '#api/task_import'

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
            moveEndSubscribe,
            manual: true })

        write_log(`[task]${website} ${id} ${name} 任务添加成功`)

        return {
            code: 200,
            message: 'Task added successfully',
        }
    }

    importTasks({ request }: HttpContext) {
        try {
            const tasks = normalizeImportedTasks(request.input('tasks'))

            tasks.forEach((task) => mangaTask.add(task))
            write_log(`[task]从 JSON 文件导入 ${tasks.length} 个任务`)

            return {
                code: 200,
                message: `成功导入 ${tasks.length} 个任务`,
                imported: tasks.length,
            }
        } catch (error) {
            return {
                code: 400,
                message: error instanceof Error ? error.message : '任务导入失败',
                imported: 0,
            }
        }
    }

    get() {
        const running = mangaTask.getRunning()
        return {
            manga: mangaTask.get(),
            bilibili: [],
            toomics: [],
            omegascans: [],
            running: {
                manga: running,
                bilibili: null,
                toomics: null,
                omegascans: null,
            },
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

    /**
     * POST /api/tasks/repair
     * 读取 data/repair-manga-list.json，按 updatedAtSite 排序后入队
     */
    async repair() {
        await repair_meta_queue()

        return {
            code: 200,
            message: '修复任务已入队',
        }
    }

    /**
     * POST /api/tasks/scan
     * 扫描 manga_results + meta.json，自动生成 repair-manga-list.json
     */
    async scan() {
        const count = await scan_broken_meta()

        return {
            code: 200,
            message: `扫描完成，发现 ${count} 部 meta.json 异常，已写入 data/repair-manga-list.json`,
            count,
        }
    }

    /**
     * POST /api/tasks/clean
     * 清理遗留的 -smanga-info 旧格式元数据目录，删除后将对应漫画加入修复列表
     */
    async clean() {
        const result = await clean_legacy_meta_dirs()

        return {
            code: 200,
            message: `清理完成：删除 ${result.deleted} 个旧目录，新增 ${result.added} 条修复记录`,
            ...result,
        }
    }
}
