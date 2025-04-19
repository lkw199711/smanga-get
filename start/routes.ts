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

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

router.post('/task', [TaskController, 'add'])
router.get('/task', [TaskController, 'get'])