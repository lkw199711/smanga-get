/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'
const TaskController = () => import('#controllers/tasks_controller')
const SubscribeController = () => import('#controllers/subscribes_controller')
const LogController = () => import('#controllers/logs_controller')
const ConfigController = () => import('#controllers/configs_controller')
const ManualAuthController = () => import('#controllers/manual_auth_controller')
const MangaController = () => import('#controllers/mangas_controller')

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

router.post('/task', [TaskController, 'add'])
router.get('/task', [TaskController, 'get'])
router.post('/task/trigger', [TaskController, 'trigger'])
router.put('/task/reorder', [TaskController, 'reorder'])
router.delete('/task', [TaskController, 'remove'])
router.delete('/task/clear', [TaskController, 'clear'])

router.post('/subscribe', [SubscribeController, 'add'])
router.get('/subscribe', [SubscribeController, 'get'])
router.put('/subscribe/reorder', [SubscribeController, 'reorder'])
router.delete('/subscribe', [SubscribeController, 'remove'])
router.delete('/subscribe/clear', [SubscribeController, 'clear'])

router.get('/log', [LogController, 'get'])
router.delete('/log', [LogController, 'clear'])

router.get('/manga', [MangaController, 'get'])
router.get('/manga/:id/chapters', [MangaController, 'chapters'])
router.get('/manga/cover', [MangaController, 'cover'])

router.get('/config', [ConfigController, 'get'])
router.put('/config', [ConfigController, 'update'])
router.patch('/config', [ConfigController, 'patch'])
router.delete('/config/toomics-cookie', [ConfigController, 'clearToomicsCookie'])

router.post('/auth/manual/start', [ManualAuthController, 'start'])
router.post('/auth/manual/finish', [ManualAuthController, 'finish'])
