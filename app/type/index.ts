type subsribeType = {
  website: string
  id: number
  name: string
  adult?: boolean
  finished?: boolean
  langTag?: string
  url?: string
  series_slug?: string
  cover?: string
  status?: string
  chapterCount?: number
}

type commandType = {
  command: string
}

type taskType = subsribeType



export type { subsribeType, taskType }
