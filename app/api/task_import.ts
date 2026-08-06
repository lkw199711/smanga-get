import type { subsribeType } from '#type/index.js'

const maxImportTasks = 5000

type TaskRecord = Record<string, unknown>

function isTaskRecord(value: unknown): value is TaskRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function copyOptionalString(source: TaskRecord, target: Partial<subsribeType>, key: keyof subsribeType) {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'string') throw new Error(`字段 ${String(key)} 必须是字符串`)
  ;(target as TaskRecord)[key] = value
}

function copyOptionalBoolean(source: TaskRecord, target: Partial<subsribeType>, key: keyof subsribeType) {
  const value = source[key]
  if (value === undefined) return
  if (typeof value !== 'boolean') throw new Error(`字段 ${String(key)} 必须是布尔值`)
  ;(target as TaskRecord)[key] = value
}

function normalizeTask(value: unknown, index: number): subsribeType {
  if (!isTaskRecord(value)) throw new Error(`第 ${index + 1} 项必须是对象`)

  const website = value.website
  const id = value.id
  const name = value.name

  if (typeof website !== 'string' || !website.trim()) {
    throw new Error(`第 ${index + 1} 项缺少有效的 website`)
  }
  if ((typeof id !== 'string' && typeof id !== 'number') || String(id).trim() === '') {
    throw new Error(`第 ${index + 1} 项缺少有效的 id`)
  }
  if (typeof id === 'number' && !Number.isFinite(id)) {
    throw new Error(`第 ${index + 1} 项的 id 必须是有限数字`)
  }
  if (typeof name !== 'string') {
    throw new Error(`第 ${index + 1} 项缺少有效的 name`)
  }

  const task: Partial<subsribeType> = {
    website: website.trim(),
    id,
    name,
  }

  copyOptionalString(value, task, 'langTag')
  copyOptionalString(value, task, 'url')
  copyOptionalString(value, task, 'series_slug')
  copyOptionalString(value, task, 'cover')
  copyOptionalString(value, task, 'status')
  copyOptionalBoolean(value, task, 'adult')
  copyOptionalBoolean(value, task, 'finished')
  copyOptionalBoolean(value, task, 'nameMatch')
  copyOptionalBoolean(value, task, 'moveEndSubscribe')
  copyOptionalBoolean(value, task, 'manual')

  if (value.chapterCount !== undefined) {
    if (typeof value.chapterCount !== 'number' || !Number.isFinite(value.chapterCount)) {
      throw new Error(`第 ${index + 1} 项的 chapterCount 必须是有限数字`)
    }
    task.chapterCount = value.chapterCount
  }

  // taskId 是当前进程内的队列身份，导入时必须重新生成，避免与现有任务冲突。
  return task as subsribeType
}

export function normalizeImportedTasks(input: unknown): subsribeType[] {
  if (!Array.isArray(input)) throw new Error('导入文件的根节点必须是任务数组')
  if (input.length === 0) throw new Error('导入文件中没有任务')
  if (input.length > maxImportTasks) throw new Error(`一次最多导入 ${maxImportTasks} 个任务`)

  return input.map(normalizeTask)
}
