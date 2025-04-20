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

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

router.post('/task', [TaskController, 'add'])
router.get('/task', [TaskController, 'get'])
router.delete('/task', [TaskController, 'remove'])
router.delete('/task/clear', [TaskController, 'clear'])

router.post('/subscribe', [SubscribeController, 'add'])
router.get('/subscribe', [SubscribeController, 'get'])
router.delete('/subscribe', [SubscribeController, 'remove'])
router.delete('/subscribe/clear', [SubscribeController, 'clear'])

router.get('/log', [LogController, 'get'])
router.delete('/log', [LogController, 'clear'])