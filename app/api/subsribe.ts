import fs from 'fs'

const subscribeFile = 'data/subscribe.json'
/**
 * 读取订阅文件
 * @description: 读取订阅文件
 * @returns 
 */
export function subscribe_read() {
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
export function subscribe_add({ website, id, name }: { website: string, name: string, id: number }) {
    const subscribe = subscribe_read()
    subscribe.push({ website, id, name })
    subscribe_write(subscribe)
}

/**
 * 移除订阅
 * @param param0 
 */
export function subscribe_remove({ website, id }: { website: string, id: number }) {
    const subscribe = subscribe_read()
    const index = subscribe.findIndex((item: any) => item.website === website && Number(item.id) === Number(id))
    
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