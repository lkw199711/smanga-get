import type { HttpContext } from '@adonisjs/core/http'
import { get_log, get_log_by_date, clear_log, list_log_dates } from '#utils/index'

function parseLogContent(content: string) {
    const lines = content.split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    return lines.reverse()
}

export default class LogsController {
    clear() {
        clear_log()
        return {
            code: 200,
            message: 'Log cleared successfully',
        }
    }

    get({ request }: HttpContext) {
        const date = request.qs().date as string | undefined
        const content = date ? get_log_by_date(date) : get_log()
        return parseLogContent(content)
    }

    dates() {
        return list_log_dates()
    }
}