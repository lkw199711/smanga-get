import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('manga_results', (table) => {
      table.increments('id')
      table.string('identity_key').notNullable().unique()
      table.string('website').notNullable().index()
      table.string('manga_id').nullable().index()
      table.string('name').notNullable().index()
      table.string('author').nullable()
      table.string('status').nullable()
      table.boolean('finished').notNullable().defaultTo(false).index()
      table.integer('chapter_count').notNullable().defaultTo(0)
      table.string('latest_chapter_name').nullable()
      table.string('latest_chapter_date').nullable().index()
      table.string('updated_at_site').nullable().index()
      table.string('crawled_at').notNullable().index()
      table.string('source').nullable()
      table.text('source_path').nullable()
      table.text('meta_path').nullable()
      table.text('cover_path').nullable()
      table.text('remote_cover').nullable()
      table.text('description').nullable()
      table.text('tags_json').nullable()
      table.text('recent_chapters_json').nullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')
    })

    this.schema.createTable('manga_chapters', (table) => {
      table.increments('id')
      table
        .integer('manga_result_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('manga_results')
        .onDelete('CASCADE')
      table.string('name').notNullable()
      table.string('title').nullable()
      table.integer('chapter_order').nullable().index()
      table.string('date').nullable().index()
      table.text('url').nullable()
      table.text('cover').nullable()
      table.boolean('is_free').nullable()
      table.float('price').nullable()
      table.integer('image_count').nullable()
      table.text('raw_json').nullable()
      table.timestamp('created_at')
      table.timestamp('updated_at')

      table.index(['manga_result_id', 'date'])
      table.unique(['manga_result_id', 'name'])
    })
  }

  async down() {
    this.schema.dropTable('manga_chapters')
    this.schema.dropTable('manga_results')
  }
}
