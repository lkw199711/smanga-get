import type { HttpContext } from '@adonisjs/core/http'
import { dataRoot, get_config, replace_config, patch_config, get_config_path } from '#utils/index'
import { create_scan_cron } from '../../start/init.js'
import db from '@adonisjs/lucid/services/db'
import { encodeMangaFileToken } from '#services/manga_index'
import fs from 'fs'
import path from 'path'

function normalizeRelativePath(filePath: string) {
  return filePath.replace(/^[.][\\/]/, '')
}

function resolveCookiePaths(cookieFile: string) {
  if (path.isAbsolute(cookieFile)) return [cookieFile]

  const normalizedPath = normalizeRelativePath(cookieFile)

  return Array.from(new Set([
    path.resolve(process.cwd(), cookieFile),
    path.resolve(process.cwd(), normalizedPath),
    path.resolve(dataRoot || process.cwd(), normalizedPath),
  ]))
}

export default class ConfigsController {
  /**
   * GET /config - 获取完整配置和元信息
   */
  get({ response }: HttpContext) {
    try {
      const config = get_config()
      if (!config) {
        return response.status(404).json({
          code: 404,
          message: '配置文件不存在',
        })
      }

      return {
        code: 200,
        data: config,
        meta: {
          configPath: get_config_path(),
        },
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `读取配置失败: ${e.message}`,
      })
    }
  }

  /**
   * PUT /config - 完整替换配置
   */
  async update({ request, response }: HttpContext) {
    try {
      const config = request.body()

      // 基本合法性校验
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return response.status(400).json({
          code: 400,
          message: '配置数据格式无效，需要 JSON 对象',
        })
      }

      replace_config(config)

      // 处理 cron 热更新
      this.handleCronUpdate(config)

      return {
        code: 200,
        message: '配置保存成功',
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `保存配置失败: ${e.message}`,
      })
    }
  }

  /**
   * PATCH /config - 局部深合并更新配置
   */
  async patch({ request, response }: HttpContext) {
    try {
      const partial = request.body()

      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        return response.status(400).json({
          code: 400,
          message: '配置数据格式无效，需要 JSON 对象',
        })
      }

      patch_config(partial)

      // 如果更新涉及 cron 字段，则重新调度
      if (partial.cron) {
        const config = get_config()
        this.handleCronUpdate(config)
      }

      return {
        code: 200,
        message: '配置更新成功',
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `更新配置失败: ${e.message}`,
      })
    }
  }

  /**
   * DELETE /config/toomics-cookie - 清空玩漫 cookie 文件
   */
  clearToomicsCookie({ response }: HttpContext) {
    try {
      const config = get_config()
      const toomicsCookieFiles = ['toomics', 'toomics-sc', 'toomics-tc']
        .map((key) => config?.[key]?.cookieFile)
        .filter((cookieFile): cookieFile is string => typeof cookieFile === 'string' && Boolean(cookieFile.trim()))
      const cookieFiles = Array.from(new Set([
        ...toomicsCookieFiles,
        'data/toomics-cookie.json',
        'data/toomics-cookies.json',
        'data/cookies/toomics-cookie.json',
        'data/cookies/toomics-cookies.json',
      ]))

      const clearedFiles = cookieFiles.flatMap((cookieFile) => {
        return resolveCookiePaths(cookieFile).map((fullPath) => {
          fs.mkdirSync(path.dirname(fullPath), { recursive: true })
          fs.writeFileSync(fullPath, '[]', 'utf-8')

          return fullPath
        })
      })

      return {
        code: 200,
        message: '玩漫 cookie 已清除',
        data: {
          files: clearedFiles,
        },
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `清除玩漫 cookie 失败: ${e.message}`,
      })
    }
  }

  /**
   * GET /config/priority - 获取优先级配置 + 按优先级分组的漫画列表
   */
  async getPriority({ response }: HttpContext) {
    try {
      const config = get_config()
      const toomicsConfig = config?.toomics || {}
      const priority = toomicsConfig.priority || {}
      const highPriorityIds: number[] = Array.isArray(priority.highPriorityIds) ? priority.highPriorityIds : []
      const autoUpgradeThreshold: number = typeof priority.autoUpgradeThreshold === 'number' ? priority.autoUpgradeThreshold : 3

      // 查询所有 toomics 漫画
      const rows = await db.rawQuery(
        `SELECT mr.\`id\`, mr.\`identity_key\`, mr.\`name\`, mr.\`website\`, mr.\`chapter_count\`,
           mr.\`finished\`, mr.\`cover_path\`, mr.\`remote_cover\`,
           COALESCE((SELECT COUNT(*) FROM manga_chapters mc WHERE mc.manga_result_id = mr.\`id\`), 0) AS indexed_count
         FROM manga_results mr
         WHERE mr.website LIKE 'toomics%'
         ORDER BY mr.\`name\` ASC`
      ) as any[]

      const parsed = Array.isArray(rows) ? rows : (rows[0] || [])
      const highSet = new Set(highPriorityIds)

      const allManga = parsed.map((row: any) => {
        const mangaId = Number(row.id)
        const chapterCount = Number(row.chapter_count) || 0
        const indexedCount = Number(row.indexed_count) || 0
        const isHigh = highSet.has(mangaId)
        const isMedium = !isHigh && (chapterCount - indexedCount >= autoUpgradeThreshold)

        return {
          id: mangaId,
          key: row.identity_key || '',
          name: row.name || '',
          website: row.website || '',
          chapterCount,
          indexedCount,
          finished: !!row.finished,
          coverToken: row.cover_path ? encodeMangaFileToken(row.cover_path) : undefined,
          remoteCover: row.remote_cover || undefined,
          priority: isHigh ? 'high' : isMedium ? 'medium' : 'low',
        }
      })

      const highList = allManga.filter((m) => m.priority === 'high')
      const mediumList = allManga.filter((m) => m.priority === 'medium')
      const lowList = allManga.filter((m) => m.priority === 'low')

      return {
        code: 200,
        data: {
          highPriorityIds,
          autoUpgradeThreshold,
          highList,
          mediumList,
          lowList,
        },
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `获取优先级配置失败: ${e.message}`,
      })
    }
  }

  /**
   * PUT /config/priority - 更新高优先级 ID 列表，自动去重
   */
  async updatePriority({ request, response }: HttpContext) {
    try {
      const body = request.body()
      const highPriorityIds: number[] = Array.isArray(body?.highPriorityIds) ? body.highPriorityIds : []

      // 去重：过滤非数字和重复值
      const cleaned = Array.from(new Set(
        highPriorityIds.filter((id) => typeof id === 'number' && Number.isFinite(id) && id > 0)
      ))

      // 写入配置
      patch_config({
        toomics: {
          priority: {
            highPriorityIds: cleaned,
          },
        },
      })

      return {
        code: 200,
        message: '优先级配置已保存',
        data: {
          highPriorityIds: cleaned,
        },
      }
    } catch (e: any) {
      return response.status(500).json({
        code: 500,
        message: `保存优先级配置失败: ${e.message}`,
      })
    }
  }

  /**
   * 检测 cron 配置变更并重新调度定时任务
   */
  private handleCronUpdate(config: any) {
    try {
      if (config?.cron) {
        create_scan_cron()
      }
    } catch (e: any) {
      console.error(`定时任务热更新失败: ${e.message}`)
    }
  }
}
