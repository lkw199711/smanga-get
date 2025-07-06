import type { HttpContext } from '@adonisjs/core/http'
import { bilibiliTask, omegascansTask, toomicsTask } from '#api/task'
import { write_log } from '#utils/index'

export default class TasksController {

    add({ request }: HttpContext) {
        const { website, id, name } = request.all()

        if (website === 'toomics') {
            toomicsTask.add({ website, id, name })
        } else if (website === 'bilibili') {
            bilibiliTask.add({ website, id, name })
        } else {
            return {
                code: 400,
                message: 'Invalid website',
            }
        }

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
        }
    }

    remove({ request }: HttpContext) {
        const { website, id } = request.all()

        if (website === 'toomics') {
            toomicsTask.remove(id)
        } else if (website === 'bilibili') {
            bilibiliTask.remove(id)
        } else {
            return {
                code: 400,
                message: 'Invalid website',
            }
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