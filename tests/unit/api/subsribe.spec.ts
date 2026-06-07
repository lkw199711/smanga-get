import fs from 'node:fs'
import path from 'node:path'
import { test } from '@japa/runner'
import type { subsribeType } from '#type/index.js'
import {
  subscribe_add,
  subscribe_read,
  subscribe_remove,
  subscribe_reorder,
  subscribe_write,
} from '#api/subsribe'
import { getTestDataDir, getTestDataFile, resetTestDataDir } from '#tests/helpers/test_data_dir'

function makeSubscribe(params: Partial<subsribeType>): subsribeType {
  return {
    website: params.website ?? 'toomics',
    id: params.id ?? 1,
    name: params.name ?? '漫画',
    url: params.url,
    moveEndSubscribe: params.moveEndSubscribe,
  }
}

test.group('subscribe file api', (group) => {
  group.each.setup(() => {
    resetTestDataDir()
  })

  test('订阅文件不存在时返回空数组', ({ assert }) => {
    assert.deepEqual(subscribe_read(), [])
  })

  test('新增订阅时会按 website/id 去重', ({ assert }) => {
    subscribe_add(makeSubscribe({ id: 100, name: 'A' }))
    subscribe_add(makeSubscribe({ id: '100', name: 'A duplicate' }))

    const subscribes = subscribe_read()

    assert.equal(subscribes.length, 1)
    assert.equal(subscribes[0].name, 'A')
  })

  test('gentleman 订阅可按 url 精确删除', ({ assert }) => {
    subscribe_write([
      makeSubscribe({ website: 'gentleman', id: 0, name: 'A', url: 'https://example.test/a' }),
      makeSubscribe({ website: 'gentleman', id: 0, name: 'B', url: 'https://example.test/b' }),
    ])

    subscribe_remove({
      website: 'gentleman',
      id: 0,
      name: 'A',
      url: 'https://example.test/a',
    })

    const subscribes = subscribe_read()

    assert.equal(subscribes.length, 1)
    assert.equal(subscribes[0].name, 'B')
  })

  test('重排订阅时保留未出现在排序参数中的项目', ({ assert }) => {
    const first = makeSubscribe({ id: 1, name: 'A' })
    const second = makeSubscribe({ id: 2, name: 'B' })
    const third = makeSubscribe({ id: 3, name: 'C' })
    subscribe_write([first, second, third])

    const result = subscribe_reorder([third, first])

    assert.deepEqual(
      result.map((item) => item.name),
      ['C', 'A', 'B']
    )
  })

  test('订阅文件 JSON 损坏时返回空数组并备份原文件', ({ assert }) => {
    const subscribeFile = getTestDataFile('subscribe.json')
    fs.writeFileSync(subscribeFile, '{ broken json', 'utf-8')

    const result = subscribe_read()
    const backups = fs
      .readdirSync(getTestDataDir())
      .filter((file) => path.basename(file).startsWith('subscribe.json.invalid-'))

    assert.deepEqual(result, [])
    assert.equal(backups.length, 1)
  })
})
