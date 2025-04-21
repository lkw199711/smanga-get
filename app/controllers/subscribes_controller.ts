import type { HttpContext } from '@adonisjs/core/http'
import { bilibiliTask, toomicsTask } from '#api/task'
import { write_log } from '#utils/index'
import { subscribe_add, subscribe_clear, subscribe_read } from '#api/subsribe'

export default class SubscribesController {
    get() {
        return subscribe_read()
    }

    add({ request }: HttpContext) {
        const { website, id, name } = request.all()

        if (!website || !id || !name) {
            return {
                code: 400,
                message: 'Missing parameters',
            }
        }

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

        subscribe_add({ website, id, name })
        write_log(`[subscribe]${website} ${id} ${name} 订阅添加成功`)

        return {
            code: 200,
            message: 'Subscribe added successfully',
        }
    }

    remove({ request }: HttpContext) {
        const { website, id } = request.all()

        if (!website || !id) {
            return {
                code: 400,
                message: 'Missing parameters',
            }
        }

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

        write_log(`[subscribe]${website} ${id} 订阅删除成功`)

        return {
            code: 200,
            message: 'Subscribe removed successfully',
        }
    }

    clear({ request }: HttpContext) {
        subscribe_clear();

        return {
            code: 200,
            message: 'Subscribe cleared successfully',
        }
    }
}