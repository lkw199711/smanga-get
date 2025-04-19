/*
 * @Author: 梁楷文 lkw199711@163.com
 * @Date: 2024-09-30 05:07:46
 * @LastEditors: lkw199711 lkw199711@163.com
 * @LastEditTime: 2024-11-17 18:14:29
 * @FilePath: \manga-get\start\kernel.ts
 */
/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| The HTTP kernel file is used to register the middleware with the server
| or the router.
|
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

/**
 * The error handler is used to convert an exception
 * to a HTTP response.
 */
server.errorHandler(() => import('#exceptions/handler'))

/**
 * The server middleware stack runs middleware on all the HTTP
 * requests, even if there is no route registered for
 * the request URL.
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([() => import('@adonisjs/core/bodyparser_middleware')])

/**
 * Named middleware collection must be explicitly assigned to
 * the routes or the routes group.
 */
export const middleware = router.named({})

import { read_json } from '#utils/index'
import { subsribeType } from '#type/index.js'
import Toomics from '#services/toomics'
import Bilibili from '#services/bilibili'
import { create_scan_cron, task_allocation } from './init.js'
import demo from '#services/test'

// demo();
// create_scan_cron();

task_allocation();
/*
const toomics = new Toomics({
  "website": "toomics",
  "id": 7616,
  "name": "难缠姐妹偏要和我同居"
})

toomics.get_cookie();
*/