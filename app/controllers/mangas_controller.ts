import type { HttpContext } from '@adonisjs/core/http'
import { getMangaChapters, getMangaResults, resolveAllowedMangaAsset } from '#api/manga'

export default class MangasController {
  async get({ request }: HttpContext) {
    const status = request.input('status')
    const result = await getMangaResults({
      page: Number(request.input('page', 1)),
      pageSize: Number(request.input('pageSize', 80)),
      keyword: request.input('keyword'),
      website: request.input('website'),
      status: status === 'serial' || status === 'finished' ? status : 'all',
    })

    return {
      code: 200,
      data: result.data,
      meta: result.meta,
    }
  }

  async chapters({ params }: HttpContext) {
    const id = Number(params.id)
    if (!Number.isFinite(id) || id <= 0) {
      return {
        code: 400,
        message: 'Invalid manga id',
        data: [],
      }
    }

    return {
      code: 200,
      data: await getMangaChapters(id),
    }
  }

  cover({ request, response }: HttpContext) {
    const token = request.input('file')

    if (!token || typeof token !== 'string') {
      return response.status(400).json({
        code: 400,
        message: 'Missing cover file token',
      })
    }

    const filePath = resolveAllowedMangaAsset(token)
    if (!filePath) {
      return response.status(404).json({
        code: 404,
        message: 'Cover not found',
      })
    }

    response.header('Cache-Control', 'public, max-age=3600')
    return response.download(filePath)
  }
}
