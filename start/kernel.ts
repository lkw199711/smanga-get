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

import Toomics from '#services/toomics'
import Bilibili from '#services/bilibili'
import { create_scan_cron, task_allocation, create_config } from './init.js'
import { demo, get_all_img, get_all_file, check_img_num, delete_err_cover } from '#services/test'
import ToomicsAll from '#services/toomics-all'
import ToomicsUpdate from '#services/toomics-update'
import OmegaScansUpdate from '#services/omegascans-update'
import ToZip from '#services/tozip'
import { delay, get_config } from '#utils/index'
import { toomicsBrowser } from '#api/browser'
import { mangaTask } from '#api/task'

const immediately = get_config().immediately ?? 0;

// 创建配置文件
create_config();

// 压缩漫画
// await new ToZip('M:\\manga\\toomics-连载').start();

// 删除错误黑封面
// delete_err_cover('A:\\02manga\\02压缩处理\\toomics');
// delete_err_cover('M:\\manga\\toomics');

// 定时任务
create_scan_cron();

// 查询干扰图片
// console.log(check_img_num("M:\\manga\\omegascans"));
// console.log('执行完毕');
// process.exit(0)
// console.log(get_all_file("A:\\02manga\\02压缩处理\\toomics"));
// console.log(get_all_file("A:\\02manga\\02压缩处理\\toomics"));

if (immediately) {
  /*
    // 获取全部漫画信息 并存储封面
    await new ToomicsAll('sc').start();
    await new ToomicsAll('tc').start();
    // await new ToomicsAll('en').start();
  
    // 更新今天 昨天的漫画
    await new ToomicsUpdate('sc').start();
    await new ToomicsUpdate('tc').start();
  */
 
  // 订阅简体漫画
  mangaTask.add({
    "website": 'toomics-covers-sc',
    "id": 0,
    "name": ''
  })
  mangaTask.add({
    "website": 'toomics-update-sc',
    "id": 0,
    "name": ''
  })

  // 订阅繁体漫画
  mangaTask.add({
    "website": 'toomics-covers-tc',
    "id": 0,
    "name": ''
  })
  mangaTask.add({
    "website": 'toomics-update-tc',
    "id": 0,
    "name": ''
  })
  // 执行订阅
  task_allocation();


  /*  
   mangaTask.add({
          "website": "toomics",
          "name": "新都市外送員",
          "url": "https://toomics.com/tc/webtoon/episode/toon/7146",
          "id": 7146,
          "cover": "https://thumb-g2.toomics.com/upload/thumbnail/20240327100145/2024_04_03_17121144258499.jpg",
          "covers": [
              "https://thumb-g2.toomics.com/upload/thumbnail/20240327100145/2024_04_03_17121144258499.jpg"
          ],
          "describe": "<!--  -->",
          "chapterCount": 47,
          "audlt": true,
          "finsihed": false
      })
          */
}

/*
const toomics = new Toomics({
  "website": "toomics",
  "id": 7616,
  "name": "难缠姐妹偏要和我同居"
})

toomics.get_cookie();
*/