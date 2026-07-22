/**
 * 清理因路径拼接混用斜杠而产生的异常目录
 *
 * === 背景 ===
 * 在 Windows 通过 SMB 访问 Linux 文件系统时，Linux 端名称中含反斜杠 \ 的目录
 * 无法在 Windows 上正确显示，转而呈现为 8.3 短文件名格式（如 TVO0J3~Y）。
 * 这些目录通常位于盘符根目录下（如 M:\），需要被识别并清理。
 *
 * === 识别特征 ===
 * 1. 位置：盘符根目录（如 M:\）下，而非配置的 compressPath / downloadPath 内
 * 2. 名称：符合 8.3 短文件名格式（1-8 位字母数字 + ~ + 1-3 位字母数字）
 * 3. 类型：目录（非文件）
 * 4. 行为：通常无法正常 readdir（Windows API 无法解析含 \ 的路径）
 *
 * === 用法 ===
 *   # 预览 M 盘根目录下的异常条目（安全，仅列出不删除）
 *   npx tsx bin/clean-abnormal-dirs.ts --drive M --dry-run
 *
 *   # 预览多个盘符
 *   npx tsx bin/clean-abnormal-dirs.ts --drive M,N,U --dry-run
 *
 *   # 实际删除
 *   npx tsx bin/clean-abnormal-dirs.ts --drive M
 *
 *   # Linux 模式：直接检测名称含 \ 的目录
 *   npx tsx bin/clean-abnormal-dirs.ts --linux --path /vol2/1000/02manga-compress --dry-run
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── 类型定义 ────────────────────────────────────────────────

interface AbnormalEntry {
  fullPath: string
  name: string       // 显示名称（Windows 上为短名，Linux 上为含 \ 的原名）
  type: 'directory' | 'file'
  /** 置信度: high=确认异常, medium=高度可疑, low=可能异常 */
  confidence: 'high' | 'medium' | 'low'
  reason: string
  /** 如果能读取内容，记录子文件数 */
  childCount: number | null
  /** 低置信度时展示前几条内容供人工判断 */
  sampleContent: string[]
}

// ── CLI 参数解析 ────────────────────────────────────────────

interface CliOptions {
  drives: string[]          // 要扫描的盘符，如 ['M', 'N']
  linuxMode: boolean        // Linux 模式：直接检测名称含 \
  linuxPaths: string[]      // Linux 模式下的扫描路径
  dryRun: boolean
  autoConfirm: boolean
  includeLow: boolean       // 是否包含低置信度条目
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)

  const driveArg = args.find((a) => a.startsWith('--drive='))
  const pathArg = args.find((a) => a.startsWith('--path='))
  const linuxMode = args.includes('--linux')
  const dryRun = args.includes('--dry-run') || args.includes('-n')
  const autoConfirm = args.includes('--yes') || args.includes('-y')
    || process.env.AUTO_CONFIRM === '1'
  const includeLow = args.includes('--all') || args.includes('--include-low')

  let drives: string[] = []
  if (driveArg) {
    drives = driveArg.replace('--drive=', '').split(',').map((d) => d.trim().toUpperCase())
  }

  let linuxPaths: string[] = []
  if (pathArg) {
    linuxPaths = pathArg.replace('--path=', '').split(',').map((p) => p.trim())
  }

  return { drives, linuxMode, linuxPaths, dryRun, autoConfirm, includeLow }
}

// ── Windows 模式：SFN 短文件名检测 ─────────────────────────

/**
 * 8.3 短文件名正则
 *
 * Windows SFN 格式: 1-8 位字母数字 + ~ + 1-3 位字母数字
 * Samba mangled 格式类似但可能略有不同
 *
 * 匹配示例:
 *   TVO0J3~Y   ✓
 *   PROGRA~1   ✓
 *   ABCDEF~12  ✓
 *   A~1        ✓
 *   node_modules ✗ (不含 ~)
 *   temp_backup  ✗ (不含 ~)
 */
const SFN_PATTERN = /^[A-Z0-9]{1,8}~[0-9A-Z]{1,3}$/i

/**
 * 扫描指定盘符根目录，找出符合 SFN 模式的异常条目
 */
function scanDriveRoot(driveLetter: string): AbnormalEntry[] {
  const driveRoot = `${driveLetter}:\\`
  const results: AbnormalEntry[] = []

  if (!fs.existsSync(driveRoot)) {
    console.log(`[跳过] 盘符不存在: ${driveRoot}`)
    return results
  }

  // 同时获取普通文件名列表，用于后续过滤
  let allNames: string[] = []
  try {
    allNames = fs.readdirSync(driveRoot)
  } catch {
    return results
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(driveRoot, { withFileTypes: true })
  } catch (err: any) {
    console.error(`[跳过] 无法读取盘符根目录: ${driveRoot} (${err.message})`)
    return results
  }

  for (const entry of entries) {
    const entryName = entry.name

    // 只处理匹配 SFN 格式的条目
    if (!SFN_PATTERN.test(entryName)) continue

    const fullPath = path.join(driveRoot, entryName)
    const entryType = entry.isDirectory() ? 'directory' : 'file'

    // 尝试进一步验证：确认这是"无法正常访问"的异常条目
    const { confidence, reason, childCount, sampleContent } = verifyAbnormalEntry(fullPath, entryType)

    results.push({
      fullPath,
      name: entryName,
      type: entryType,
      confidence,
      reason,
      childCount,
      sampleContent,
    })
  }

  return results
}

/**
 * 验证条目是否确实为异常目录
 *
 * 验证策略：
 *   1. 尝试 readdir → 如果失败 → high confidence（Windows 无法解析含 \ 的路径）
 *   2. 尝试 stat → 如果成功但 readdir 失败 → high confidence
 *   3. readdir 成功 → 检查内容是否像漫画章节（含 .jpg）→ medium confidence
 *   4. readdir 成功且非图片内容 → low confidence（可能是正常目录）
 */
function verifyAbnormalEntry(
  fullPath: string,
  entryType: 'directory' | 'file'
): { confidence: AbnormalEntry['confidence']; reason: string; childCount: number | null; sampleContent: string[] } {
  const empty = { confidence: 'medium' as const, reason: '', childCount: null as number | null, sampleContent: [] as string[] }

  if (entryType === 'file') {
    // SFN 格式的文件也可能是异常的
    return { confidence: 'medium', reason: 'SFN 短文件名格式的文件', childCount: null, sampleContent: [] }
  }

  // 尝试 stat
  let stat: fs.Stats
  try {
    stat = fs.statSync(fullPath)
  } catch (err: any) {
    return {
      confidence: 'high',
      reason: `stat 失败: ${err.message}`,
      childCount: null,
      sampleContent: [],
    }
  }

  if (!stat.isDirectory()) {
    return { confidence: 'medium', reason: 'stat 显示非目录', childCount: null, sampleContent: [] }
  }

  // 尝试 readdir
  let children: string[]
  try {
    children = fs.readdirSync(fullPath)
  } catch (err: any) {
    return {
      confidence: 'high',
      reason: `无法读取目录内容 (疑似含非法字符): ${err.message}`,
      childCount: null,
      sampleContent: [],
    }
  }

  if (children.length === 0) {
    return {
      confidence: 'high',
      reason: '目录为空（正常漫画章节目录不应为空）',
      childCount: 0,
      sampleContent: [],
    }
  }

  // 检查是否像漫画章节目录（含 .jpg / .png / .webp 文件）
  const imageFiles = children.filter((c) =>
    /\.(jpe?g|png|webp|avif)$/i.test(c)
  )

  if (imageFiles.length > 0) {
    return {
      confidence: 'high',
      reason: `目录含 ${imageFiles.length} 个图片文件，确认是异常漫画章节目录`,
      childCount: children.length,
      sampleContent: [],
    }
  }

  // 检查是否像压缩后的漫画目录（含 .smanga 子目录 或 .zip 文件）
  const hasSmanga = children.some((c) => c === '.smanga')
  const zipFiles = children.filter((c) => /\.zip$/i.test(c))

  if (hasSmanga || zipFiles.length > 0) {
    const parts: string[] = []
    if (hasSmanga) parts.push('.smanga 元数据目录')
    if (zipFiles.length > 0) parts.push(`${zipFiles.length} 个 zip 压缩章节`)
    return {
      confidence: 'high',
      reason: `确认是异常漫画目录: ${parts.join('，')}`,
      childCount: children.length,
      sampleContent: [],
    }
  }

  // 非图片内容 → 可能是正常目录，降低置信度
  // 展示前 3 条内容供人工判断
  const sample = children.slice(0, 3).map((c) => {
    try {
      const s = fs.statSync(path.join(fullPath, c))
      return `${s.isDirectory() ? '📁' : '📄'} ${c}`
    } catch {
      return `? ${c}`
    }
  })

  return {
    confidence: 'low',
    reason: `目录可正常访问，含 ${children.length} 个非图片文件/子目录`,
    childCount: children.length,
    sampleContent: sample,
  }
}

// ── Linux 模式：反斜杠字符检测 ─────────────────────────────

/**
 * 在 Linux 上递归扫描，找出名称中含反斜杠 \ 的条目
 */
function scanBackslashEntries(
  dirPath: string,
  results: AbnormalEntry[] = []
): AbnormalEntry[] {
  if (!fs.existsSync(dirPath)) {
    console.log(`[跳过] 路径不存在: ${dirPath}`)
    return results
  }

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (err: any) {
    console.error(`[跳过] 无法读取目录: ${dirPath} (${err.message})`)
    return results
  }

  for (const entry of entries) {
    const entryName = entry.name

    if (entryName.includes('\\')) {
      results.push({
        fullPath: path.join(dirPath, entryName),
        name: entryName,
        type: entry.isDirectory() ? 'directory' : 'file',
        confidence: 'high',
        reason: `名称包含反斜杠 \\`,
        childCount: null,
        sampleContent: [],
      })
      continue
    }

    if (entry.isDirectory()) {
      scanBackslashEntries(path.join(dirPath, entryName), results)
    }
  }

  return results
}

// ── 删除操作 ────────────────────────────────────────────────

function deleteEntry(entry: AbnormalEntry): boolean {
  try {
    if (entry.type === 'directory') {
      fs.rmSync(entry.fullPath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(entry.fullPath)
    }
    return true
  } catch (err: any) {
    console.error(`[失败] 删除 ${entry.fullPath}: ${err.message}`)
    return false
  }
}

// ── 输出格式化 ──────────────────────────────────────────────

const CONFIDENCE_LABELS: Record<string, string> = {
  high: '⚠ 确认',
  medium: '? 可疑',
  low: '○ 低风险',
}

function printResults(results: AbnormalEntry[]): void {
  if (results.length === 0) {
    console.log('未发现异常条目，无需清理。')
    return
  }

  // 按置信度分组
  const highConf = results.filter((r) => r.confidence === 'high')
  const medConf = results.filter((r) => r.confidence === 'medium')
  const lowConf = results.filter((r) => r.confidence === 'low')

  console.log(`\n发现 ${results.length} 个异常条目:\n`)
  console.log('='.repeat(75))

  for (const group of [
    { label: '高置信度（确认异常，建议删除）', items: highConf },
    { label: '中置信度（高度可疑，请人工确认）', items: medConf },
    { label: '低置信度（可能正常，谨慎处理）', items: lowConf },
  ]) {
    if (group.items.length === 0) continue
    console.log(`\n── ${group.label} (${group.items.length} 个) ──\n`)

    for (const entry of group.items) {
      const icon = entry.type === 'directory' ? '📁' : '📄'
      const childInfo =
        entry.childCount !== null ? ` [内含 ${entry.childCount} 项]` : ''
      console.log(`  ${icon} ${entry.fullPath}${childInfo}`)
      console.log(`     ${CONFIDENCE_LABELS[entry.confidence]}: ${entry.reason}`)
      if (entry.sampleContent.length > 0) {
        for (const sample of entry.sampleContent) {
          console.log(`       ${sample}`)
        }
      }
    }
  }

  console.log('\n' + '='.repeat(75))
}

// ── 主流程 ────────────────────────────────────────────────

function main() {
  const opts = parseArgs()

  console.log('═══════════════════════════════════════════')
  console.log('  异常目录清理工具')
  console.log(`  平台: ${os.platform()}`)
  console.log(`  模式: ${opts.dryRun ? '预览 (--dry-run)' : '执行删除'}`)
  console.log('═══════════════════════════════════════════\n')

  let allResults: AbnormalEntry[] = []

  if (opts.linuxMode) {
    // ── Linux 模式 ──
    const scanPaths = opts.linuxPaths.length > 0
      ? opts.linuxPaths
      : ['/'] // 默认扫描根目录太过危险，强制要求指定路径
    if (opts.linuxPaths.length === 0) {
      console.log('Linux 模式需要明确指定扫描路径，例如:')
      console.log('  npx tsx bin/clean-abnormal-dirs.ts --linux --path /vol2/1000/02manga-compress')
      return
    }

    console.log(`扫描 ${scanPaths.length} 个路径（检测名称含 \\ 的条目）:\n`)
    for (const p of scanPaths) console.log(`  - ${p}`)
    console.log()

    for (const scanPath of scanPaths) {
      scanBackslashEntries(scanPath, allResults)
    }
  } else {
    // ── Windows 模式 ──
    const drives = opts.drives.length > 0 ? opts.drives : ['M']
    console.log(`扫描盘符根目录: ${drives.map((d) => `${d}:\\`).join(', ')}`)
    console.log(`匹配模式: 8.3 短文件名 (如 TVO0J3~Y)\n`)

    for (const drive of drives) {
      const driveResults = scanDriveRoot(drive)
      allResults.push(...driveResults)
    }
  }

  // 输出结果
  printResults(allResults)

  if (allResults.length === 0) return

  if (opts.dryRun) {
    console.log(
      `\n[预览模式] 以上 ${allResults.length} 个条目将被删除。`
    )
    console.log('去掉 --dry-run 参数以实际执行删除。')
    return
  }

  // 实际删除
  const highConf = allResults.filter((r) => r.confidence === 'high')
  const medConf = allResults.filter((r) => r.confidence === 'medium')
  const lowConf = allResults.filter((r) => r.confidence === 'low')

  const toDelete = opts.includeLow
    ? [...highConf, ...medConf, ...lowConf]
    : [...highConf, ...medConf]

  if (toDelete.length === 0) {
    console.log('\n没有需要删除的条目。')
    if (lowConf.length > 0 && !opts.includeLow) {
      console.log(
        `提示: 还有 ${lowConf.length} 个低置信度条目，使用 --all 或 --include-low 一并处理`
      )
    }
    return
  }

  const includedConf = opts.includeLow ? '全部' : '高/中'
  console.log(
    `\n即将删除 ${toDelete.length} 个条目 (${includedConf}置信度: 高 ${highConf.length}, 中 ${medConf.length}, 低 ${lowConf.length})`
  )

  let deletedCount = 0
  let failedCount = 0

  for (const entry of toDelete) {
    if (deleteEntry(entry)) {
      console.log(`[删除] ${entry.fullPath}`)
      deletedCount++
    } else {
      failedCount++
    }
  }

  console.log(`\n清理完成: 成功 ${deletedCount} 个, 失败 ${failedCount} 个`)
}

main()
