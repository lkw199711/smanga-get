import fs from 'node:fs'
import path from 'node:path'
import type { subsribeType } from '#type/index.js'
import { dataRoot, write_log } from '#utils/index'

const subscribeFile = path.join(dataRoot || '', 'data', 'subscribe.json')

type SubscribeTarget = Partial<subsribeType> & {
  website: string
  id?: number | string
  name?: string
}

function safeLog(message: string) {
  try {
    write_log(message)
  } catch {
    console.warn(message)
  }
}

function isPresent(value: unknown) {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

function normalizeId(id: unknown) {
  return isPresent(id) ? String(id).trim() : ''
}

// 排序时需要稳定地区分重复订阅，所以尽量保留 website/id/name/url 的组合身份。
function getSubscribeIdentity(subscribe: Partial<subsribeType>) {
  return [
    subscribe.website ?? '',
    normalizeId(subscribe.id),
    subscribe.name ?? '',
    subscribe.url ?? '',
  ].join('\u0000')
}

function reorderSubscribe(current: subsribeType[], ordered: subsribeType[]) {
  const buckets = new Map<string, subsribeType[]>()

  current.forEach((item) => {
    const key = getSubscribeIdentity(item)
    buckets.set(key, [...(buckets.get(key) ?? []), item])
  })

  const next: subsribeType[] = []

  ordered.forEach((item) => {
    const key = getSubscribeIdentity(item)
    const bucket = buckets.get(key)
    const matched = bucket?.shift()

    if (matched) {
      next.push(matched)
    }
  })

  buckets.forEach((items) => {
    next.push(...items)
  })

  return next
}

// 删除订阅时优先使用 URL，其次使用 id；gentleman 多个订阅可能共用 id=0，
// 因此 gentleman 会优先按 name 匹配，避免误删同 id 的其他订阅。
function isSameSubscribe(item: subsribeType, target: SubscribeTarget) {
  if (item.website !== target.website) return false

  if (isPresent(target.url) && isPresent(item.url)) {
    return item.url === target.url
  }

  if (target.website === 'gentleman' && isPresent(target.name)) {
    return item.name === target.name
  }

  if (isPresent(target.id) && isPresent(item.id)) {
    return normalizeId(item.id) === normalizeId(target.id)
  }

  if (isPresent(target.name)) {
    return item.name === target.name
  }

  return false
}

function ensureSubscribeDir() {
  fs.mkdirSync(path.dirname(subscribeFile), { recursive: true })
}

function backupInvalidSubscribeFile() {
  if (!fs.existsSync(subscribeFile)) return

  const backupFile = `${subscribeFile}.invalid-${Date.now()}`
  fs.copyFileSync(subscribeFile, backupFile)
  safeLog(`[subscribe] 订阅文件解析失败，已备份到 ${backupFile}`)
}

function readSubscribeFile(): subsribeType[] {
  if (!fs.existsSync(subscribeFile)) {
    return []
  }

  try {
    const jsonStr = fs.readFileSync(subscribeFile, 'utf-8').trim()
    if (!jsonStr) return []

    const json = JSON.parse(jsonStr)
    if (!Array.isArray(json)) {
      safeLog('[subscribe] 订阅文件不是数组，已按空列表处理')
      return []
    }

    return json
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    backupInvalidSubscribeFile()
    safeLog(`[subscribe] 读取订阅文件失败: ${message}`)

    return []
  }
}

function writeSubscribeFile(subscribes: subsribeType[]) {
  ensureSubscribeDir()

  const tempFile = `${subscribeFile}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempFile, JSON.stringify(subscribes, null, 2), 'utf-8')
  fs.renameSync(tempFile, subscribeFile)
}

/**
 * 读取订阅列表。
 */
export function subscribe_read() {
  return readSubscribeFile()
}

/**
 * 写入完整订阅列表。
 */
export function subscribe_write(json: subsribeType[]) {
  writeSubscribeFile(json)
}

/**
 * 新增订阅。若订阅已存在，则保持原列表不变。
 */
export function subscribe_add(params: subsribeType) {
  const subscribes = subscribe_read()
  const isExist = subscribes.some((item) => isSameSubscribe(item, params))

  if (!isExist) {
    subscribes.push(params)
    subscribe_write(subscribes)
  }
}

/**
 * 按前端传入顺序重排订阅；未出现在 ordered 中的订阅会保留在末尾。
 */
export function subscribe_reorder(ordered: subsribeType[]) {
  const subscribes = subscribe_read()
  const nextSubscribe = reorderSubscribe(subscribes, ordered)

  subscribe_write(nextSubscribe)

  return nextSubscribe
}

/**
 * 移除订阅。
 */
export function subscribe_remove({ website, id, name, url }: SubscribeTarget) {
  const subscribes = subscribe_read()
  const index = subscribes.findIndex((item) => isSameSubscribe(item, { website, id, name, url }))

  if (index !== -1) {
    subscribes.splice(index, 1)
    subscribe_write(subscribes)
  }
}

/**
 * 清空订阅列表。
 */
export function subscribe_clear() {
  subscribe_write([])
}
