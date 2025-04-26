// import type { HttpContext } from '@adonisjs/core/http'
import { get_log, clear_log } from '#utils/index'
export default class LogsController {
    clear() {
        // 清空日志
        clear_log();
        return {
            code: 200,
            message: 'Log cleared successfully',
        }
    }

    get() {
        // 获取日志
        const content = get_log();
        const lines = content.split(/\r?\n/); // 处理不同系统的换行符

        // 移除最后的空行（如果有）
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        return lines.reverse();
    }
}