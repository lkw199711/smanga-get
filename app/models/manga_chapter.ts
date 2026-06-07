import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class MangaChapter extends BaseModel {
  static table = 'manga_chapters'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare mangaResultId: number

  @column()
  declare name: string

  @column()
  declare title: string | null

  @column()
  declare chapterOrder: number | null

  @column()
  declare date: string | null

  @column()
  declare url: string | null

  @column()
  declare cover: string | null

  @column()
  declare isFree: boolean | null

  @column()
  declare price: number | null

  @column()
  declare imageCount: number | null

  @column()
  declare rawJson: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
