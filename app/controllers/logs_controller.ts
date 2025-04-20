// import type { HttpContext } from '@adonisjs/core/http'
import fs from 'fs'
const logFile = 'log.txt';

export default class LogsController {
    clear() {
        // 清空日志
        fs.writeFileSync(logFile, '', 'utf-8')
        return {
            code: 200,
            message: 'Log cleared successfully',
        }
    }

    get() {
        // 获取日志
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.split(/\r?\n/); // 处理不同系统的换行符

        // 移除最后的空行（如果有）
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }

        return lines.reverse();
    }
}