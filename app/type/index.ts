type subsribeType = {
  website: string
  id: number | string
  taskId?: string
  name: string
  adult?: boolean
  finished?: boolean
  langTag?: string
  url?: string
  series_slug?: string
  cover?: string
  status?: string
  chapterCount?: number
  nameMatch?: boolean
  moveEndSubscribe?: boolean
  manual?: boolean
}

type commandType = {
  command: string
}

type taskType = subsribeType

type taskProgressType = {
  percent: number
  stage: string
  message: string
  current?: number
  total?: number
  subCurrent?: number
  subTotal?: number
  updatedAt: string
}

type runningTaskType = {
  status: 'running' | 'success' | 'failed' | 'paused'
  task: taskType
  progress: taskProgressType
  startedAt: string
  updatedAt: string
  error?: string
}

export type { subsribeType, taskType, taskProgressType, runningTaskType }
