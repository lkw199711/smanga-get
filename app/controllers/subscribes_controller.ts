import type { HttpContext } from '@adonisjs/core/http'
import { bilibiliTask, toomicsTask, mangaTask } from '#api/task'
import { write_log } from '#utils/index'
import { subscribe_add, subscribe_remove, subscribe_clear, subscribe_read, subscribe_reorder } from '#api/subsribe'

export default class SubscribesController {
    get() {
        return subscribe_read()
    }

    add({ request }: HttpContext) {
        const { website, id, name, mangaUrl, moveEndSubscribe } = request.all()

        if (!website || !id || !name) {
            return {
                code: 400,
                message: 'Missing parameters',
            }
        }

        const subscribe = subscribe_read()
        const isExist = subscribe.some((item: any) => {
            if (website === 'gentleman') {
                return item.url === mangaUrl
            } else {
                return item.website === website && item.id === id
            }
        })
        if (isExist) {
            return {
                code: 400,
                message: 'Subscribe already exists',
            }
        }

        if (website === 'toomics') {
            mangaTask.add({ website, id, name })
        } else if (website === 'bilibili') {
            mangaTask.add({ website, id, name })
        } else if (website === 'gentleman') {
            mangaTask.add({ 
                website, 
                id, name, 
                url: mangaUrl, 
                moveEndSubscribe 
            })
        } else {
            return {
                code: 400,
                message: 'Invalid website',
            }
        }

        subscribe_add({ 
            website, id, name,
            url: mangaUrl, 
            moveEndSubscribe 
         })
        write_log(`[subscribe]${website} ${id} ${name} 订阅添加成功`)

        return {
            code: 200,
            message: 'Subscribe added successfully',
        }
    }

    reorder({ request }: HttpContext) {
        const { subscribes } = request.all()

        if (!Array.isArray(subscribes)) {
            return {
                code: 400,
                message: '订阅排序参数无效',
            }
        }

        const nextSubscribes = subscribe_reorder(subscribes)

        return {
            code: 200,
            message: '订阅顺序已更新',
            subscribes: nextSubscribes,
        }
    }

    remove({ request }: HttpContext) {
        const { website, id, name } = request.all()

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
        } else if (website === 'gentleman') {
            mangaTask.remove(id)
        } else{
            return {
                code: 400,
                message: 'Invalid website',
            }
        }

        subscribe_remove({ website, id, name })

        write_log(`[subscribe]${website} ${id} 订阅删除成功`)

        return {
            code: 200,
            message: 'Subscribe removed successfully',
        }
    }

    clear() {
        subscribe_clear();

        return {
            code: 200,
            message: 'Subscribe cleared successfully',
        }
    }
}
