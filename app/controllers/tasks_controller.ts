import type { HttpContext } from '@adonisjs/core/http'
import { bilibiliTask, toomicsTask } from '#api/task'

export default class TasksController {
    async index({ request }: HttpContext) {

    }

    async create({ request }: HttpContext) {

    }

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

        return {
            code: 200,
            message: 'Task added successfully',
        }
    }

    get({ request }: HttpContext) {
        return {
            bilibili: bilibiliTask.get(),
            toomics: toomicsTask.get(),
        }
    }
}