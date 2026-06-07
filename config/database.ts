import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from '../app/utils/index.js'

const sqliteDir = path.resolve(dataRoot || '', 'data')
const sqliteFile = process.env.NODE_ENV === 'test'
  ? app.tmpPath(`smanga-get-test-${process.pid}.sqlite3`)
  : path.join(sqliteDir, 'smanga-get.sqlite3')

fs.mkdirSync(sqliteDir, { recursive: true })
// 测试模式下 sqlite 放在 app.tmpPath()，需确保 tmp 目录存在
if (process.env.NODE_ENV === 'test') {
  fs.mkdirSync(path.dirname(sqliteFile), { recursive: true })
}

const dbConfig = defineConfig({
  connection: 'sqlite',
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: sqliteFile
      },
      useNullAsDefault: true,
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
