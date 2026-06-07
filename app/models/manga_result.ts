import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class MangaResult extends BaseModel {
  static table = 'manga_results'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare identityKey: string

  @column()
  declare website: string

  @column()
  declare mangaId: string | null

  @column()
  declare name: string

  @column()
  declare author: string | null

  @column()
  declare status: string | null

  @column()
  declare finished: boolean

  @column()
  declare chapterCount: number

  @column()
  declare latestChapterName: string | null

  @column()
  declare latestChapterDate: string | null

  @column()
  declare updatedAtSite: string | null

  @column()
  declare crawledAt: string

  @column()
  declare source: string | null

  @column()
  declare sourcePath: string | null

  @column()
  declare metaPath: string | null

  @column()
  declare coverPath: string | null

  @column()
  declare remoteCover: string | null

  @column()
  declare description: string | null

  @column()
  declare tagsJson: string | null

  @column()
  declare recentChaptersJson: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
