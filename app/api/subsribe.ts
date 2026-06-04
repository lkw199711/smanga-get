import fs from 'fs'
import type { subsribeType } from '#type/index.js'
import { dataRoot } from '#utils/index'

const subscribeFile = dataRoot + 'data/subscribe.json'

function getSubscribeIdentity(subscribe: Partial<subsribeType>) {
    return [
        subscribe.website ?? '',
        subscribe.id ?? '',
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

/**
 * 读取订阅文件
 * @description: 读取订阅文件
 * @returns 
 */
export function subscribe_read() {
    if (!fs.existsSync(subscribeFile)) {
        return []
    }

    const jsonStr = fs.readFileSync(subscribeFile, 'utf-8')
    const json = JSON.parse(jsonStr)
    return json;
}

/**
 * 写入订阅文件
 * @description: 写入订阅文件
 * @param json 
 */
export function subscribe_write(json: any) {
    fs.writeFileSync(subscribeFile, JSON.stringify(json, null, 2), 'utf-8')
}

/**
 * 新增订阅
 * @param param0 
 */
export function subscribe_add(params: any) {
    const subscribe = subscribe_read()
    subscribe.push( params )
    subscribe_write(subscribe)
}

export function subscribe_reorder(ordered: subsribeType[]) {
    const subscribe = subscribe_read()
    const nextSubscribe = reorderSubscribe(subscribe, ordered)

    subscribe_write(nextSubscribe)

    return nextSubscribe
}

/**
 * 移除订阅
 * @param param0 
 */
export function subscribe_remove({ website, id, name }: { website: string, id: number | string, name?: string }) {
    const subscribe = subscribe_read()
    let index = -1
    if (website === 'gentleman') {
        index = subscribe.findIndex((item: any) => item.website === website && item.name === name)
    } else {
        index = subscribe.findIndex((item: any) => item.website === website && Number(item.id) === Number(id))
    }

    if (index !== -1) {
        subscribe.splice(index, 1)
        subscribe_write(subscribe)
    }
}

/**
 * 清空订阅
 * @description: 清空订阅
 * @returns
 */
export function subscribe_clear() {
    subscribe_write([])
}
