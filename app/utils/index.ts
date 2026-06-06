import Axios from 'axios'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const dataDir = process.env.DATA_DIR
export const dataRoot = dataDir
  ? (dataDir.endsWith('/') ? dataDir : dataDir + '/')
  : (get_os() === 'Linux' ? '/' : '')

const configFile = dataRoot + 'data/config.json'
const failedChaptersFile = dataRoot + 'data/failed-chapters.json'
const logFile = dataRoot + 'data/log.txt'

export class TaskPauseError extends Error {
  pauseTask = true

  constructor(message: string) {
    super(message)
    this.name = 'TaskPauseError'
  }
}

export function isTaskPauseError(error: unknown): error is TaskPauseError {
  return error instanceof TaskPauseError
    || (typeof error === 'object' && error !== null && (error as { pauseTask?: unknown }).pauseTask === true)
}

/**
 * 任务中断错误：连续检测到异常状态（如空章节、cookie 失效、封控触发），
 * 抛出此错误将清空整个任务队列，停止所有后续任务。
 */
export class TaskAbortError extends Error {
  abortTask = true

  constructor(message: string) {
    super(message)
    this.name = 'TaskAbortError'
  }
}

export function isTaskAbortError(error: unknown): error is TaskAbortError {
  return error instanceof TaskAbortError
    || (typeof error === 'object' && error !== null && (error as { abortTask?: unknown }).abortTask === true)
}

export function get_os() {
  const platform = os.platform()
  if (platform === 'win32') {
    return 'Windows'
  } else if (platform === 'linux') {
    return 'Linux'
  } else {
    return 'Other'
  }
}

export async function downloadImage(url: string, path: string): Promise<void> {
  const response = await Axios({
    method: 'get',
    url,
    responseType: 'stream',
  })

  const writer = fs.createWriteStream(path)
  response.data.pipe(writer)

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

export function read_json(file: string) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

export function write_json(file: string, json: any) {
  fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf-8')
}

/**
 *
 * @param ms 延迟的时间，单位为毫秒
 * @description: 延迟函数，使用Promise实现
 * @returns
 */
export async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function saveBase64Image(base64Data: any, filepath: string) {
  const base64Image = base64Data.split(';base64,').pop()
  fs.writeFileSync(filepath, base64Image, { encoding: 'base64' })
}

/**
 *
 * @param logContent 日志内容
 */
export function write_log(logContent: string) {
  console.log(logContent)
  fs.appendFileSync(logFile, `${new Date().toLocaleString()} ${logContent} \n`, 'utf-8')
}

export function get_log() {
  return fs.readFileSync(logFile, 'utf-8')
}

export function clear_log() {
  fs.writeFileSync(logFile, '', 'utf-8')
}

/**
 * 获取配置文件
 * @description: 获取配置文件
 * @returns
 */
export function get_config(website: string = '') {
  if (!fs.existsSync(configFile)) {
    return null
  }
  const configStr = fs.readFileSync(configFile, 'utf-8')
  const config = JSON.parse(configStr)

  if (website) {
    return config[website]
  }

  return config
}

/**
 * 深合并对象，用于局部更新配置时保持嵌套结构
 */
export function deep_merge(target: any, source: any): any {
  if (source === null || source === undefined) return target
  if (target === null || target === undefined) return source

  if (Array.isArray(source)) {
    return source
  }

  if (typeof source !== 'object' || typeof target !== 'object') {
    return source
  }

  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deep_merge(target[key] || {}, source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}

/**
 * 获取配置文件路径，用于返回元信息
 */
export function get_config_path(): string {
  return configFile
}

/**
 *
 * @param config 配置文件内容
 */
export function set_config(config: any) {
  ensure_data_dir()
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8')
  } else {
    const configStr = fs.readFileSync(configFile, 'utf-8')
    const oldConfig = JSON.parse(configStr)
    const newConfig = { ...oldConfig, ...config }
    fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf-8')
  }
}

/**
 * 深合并更新配置，用于 PATCH 局部保存，不会破坏嵌套结构
 */
export function patch_config(partial: any) {
  ensure_data_dir()
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify(partial, null, 2), 'utf-8')
    return
  }
  const configStr = fs.readFileSync(configFile, 'utf-8')
  const oldConfig = JSON.parse(configStr)
  const newConfig = deep_merge(oldConfig, partial)
  fs.writeFileSync(configFile, JSON.stringify(newConfig, null, 2), 'utf-8')
}

/**
 * 完整替换配置文件
 */
export function replace_config(config: any) {
  ensure_data_dir()
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * 确保 data 目录存在
 */
function ensure_data_dir() {
  const dir = path.dirname(configFile)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function end_app() {
  const config = get_config()
  if (config.endAfterSetCookie) {
    set_config({ endAfterSetCookie: false })
    console.log('程序结束')
    process.exit(0)
  }
}

export function shut_down() {
  const config = get_config()
  if (config.shutdownAfterSetCookie) {
    set_config({ shutdownAfterSetCookie: false })
    console.log('关闭计算机')
    // 关机命令
    if (get_os() === 'Windows') {
      exec('shutdown -s -t 0')
    } else if (get_os() === 'Linux') {
      exec('shutdown -h now')
    }
    process.exit(0)
  }
}

export function s_delete(file: string) {
  try {
    fs.rmSync(file, { force: true, recursive: true })
  } catch (err) {
    console.error(err.message)
  }
}

export function copy_folder(source: string, target: string) {
  let files = []

  // 确保目标文件夹存在
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true })
  }

  // 读取源文件夹中的所有文件和子文件夹
  if (fs.existsSync(source)) {
    files = fs.readdirSync(source)
    files.forEach(function (file) {
      let srcPath = path.join(source, file)
      let destPath = path.join(target, file)
      let stat = fs.statSync(srcPath)

      if (stat.isDirectory()) {
        // 如果是目录，则递归复制
        copy_folder(srcPath, destPath)
      } else {
        // 如果是文件，则直接复制
        fs.copyFileSync(srcPath, destPath)
      }
    })
  }
}

export function make_can_be_floder(name: string): string {
  return name
    .replace(/&lt;/g, '<') // 解码HTML实体
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '') // 去除HTML标签
    .replace(/[\/\\:*?"<>|\.]/g, '')
    .replace(/[&<>'"]/g, '')
    .trimStart()
    .trimEnd()
}

export function update_sync_cloud_time(website: string) {
  const config = get_config()
  if (config) {
    config[website].latestSyncCloud = new Date().getTime()
    set_config(config)
  }
}

export function get_failed_chapters() {
  if (!fs.existsSync(failedChaptersFile)) {
    return null
  }
  const configStr = fs.readFileSync(failedChaptersFile, 'utf-8')
  const config = JSON.parse(configStr)

  return config
}

export function set_failed_chapters(chapters: any[]) {
  const failedChapters = get_failed_chapters() || []
  write_json(failedChaptersFile, [...failedChapters, ...chapters])
}
