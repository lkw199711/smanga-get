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
import { demo, get_all_img, get_all_file, check_img_num, delete_err_cover, check_small_zip } from '#services/test'
import ToomicsAll from '#services/toomics-all'
import ToomicsUpdate from '#services/toomics-update'
import OmegaScansUpdate from '#services/omegascans-update'
import ToZip from '#services/tozip'
import ToZipInOut from '#services/tozip-in-out'
import CopyMeta from '#services/copy-meta'
import MoveMeta from '#services/move-meta'
import RemoveDuplicates from '#services/remove-duplicates'
import { delay, get_config } from '#utils/index'
import { mangaTask } from '#api/task'

const immediately = get_config().immediately ?? {}

// 创建配置文件
create_config()

// 检查小压缩包
// check_small_zip('C:\\12manga-compress')

// 压缩漫画
// await new ToZipInOut('D:\\11manga\\bilibili', 'D:\\11manga\\bilibili-compress').start();
// await new ToZip('C:\\11manga\\omegascans', 'C:\\12manga-compress\\omegascans').start()
// await new RemoveDuplicates(
//   'C:\\99mnt\\0\\20manga-compress\\toptoon\\2023',
//   'C:\\12manga-compress\\omegascans'
// ).start()
// await new MoveMeta('C:\\12manga\\omegascans', 'C:\\12manga-compress\\omegascans').start()
// await new MoveMeta({
//   outFloder: 'C:\\12manga-meta\\toptoon\\2025',
//   mangaFloder: 'C:\\12manga-compress\\toptoon\\2025',
//   outPutMetaFloderType: '.',
//   deleteSource: false,
// }).start()
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

if (immediately.subscribeTask) {
  // 执行订阅
  task_allocation()
}

if (immediately.toomicsUpdateSc) {
  // 订阅简体漫画
  mangaTask.add({
    website: 'toomics-covers-sc',
    id: 0,
    name: '',
  })
}

if (immediately.toomicsUpdateTc) {
  // 订阅繁体漫画
  mangaTask.add({
    website: 'toomics-covers-tc',
    id: 0,
    name: '',
  })
}

if (immediately.omegascansUpdate) {
  // 订阅OmegaScans
  mangaTask.add({
    website: 'omegascans-update',
    id: 0,
    name: '',
  })
}

if (immediately.toomicsCompressSc) {
  // 压缩简体漫画
  mangaTask.add({ website: 'toomics-compress-sc', id: 0, name: '' })
}

if (immediately.toomicsCompressTc) {
  // 压缩繁体漫画
  mangaTask.add({ website: 'toomics-compress-tc', id: 0, name: '' })
}

if (immediately.omegascansCompress) {
  // 压缩OmegaScans
  mangaTask.add({ website: 'omegascans-compress', id: 0, name: '' })
}

if (immediately.omegascansSyncCloud) {
  // 同步OmegaScans到云盘
  mangaTask.add({ website: 'sync-omegascans', id: 0, name: '' })
}

/*
mangaTask.add({
  "website": "toomics",
  "name": "异世界骑士团长",
  "url": "https://global.toomics.com/sc/webtoon/episode/toon/7620",
  "id": 7620,
  "cover": "https://thumb-g1.toomics.com/upload/thumbnail/20230308163402/2023_03_20_16792713164524.jpg",
  "covers": [
    "https://thumb-g1.toomics.com/upload/thumbnail/20230308163402/2023_03_20_16792713196230.jpg",
    "https://thumb-g1.toomics.com/upload/thumbnail/20230308163402/2023_03_20_16792713164524.jpg"
  ],
  "describe": "<!--這個女生脾氣暴躁講話又難聽<br>\n區區金牌而已還敢嗆我!?<br>\n就讓她見識前準選手的厲害吧！-->",
  "chapterCount": 121,
  "audlt": true,
  "finsihed": true,
  "langTag": "sc"
})
*/

/*
const toomics = new Toomics({
  "website": "toomics",
  "id": 7616,
  "name": "难缠姐妹偏要和我同居"
})

toomics.get_cookie();
*/
