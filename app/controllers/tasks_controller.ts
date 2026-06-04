import type { HttpContext } from '@adonisjs/core/http'
import { bilibiliTask, mangaTask, omegascansTask, toomicsTask } from '#api/task'
import { write_log } from '#utils/index'

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

    get({ request }: HttpContext) {
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
        } else if (!website) {
            bilibiliTask.clear()
            toomicsTask.clear()
        } else {
            return {
                code: 400,
                message: 'Invalid website',
            }
        }

        return {
            code: 200,
            message: 'All tasks cleared successfully',
        }
    }
}
