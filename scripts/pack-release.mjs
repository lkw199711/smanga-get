#!/usr/bin/env node

/**
 * 漫画目录增量分包压缩脚本（网盘共享用）
 *
 * 功能：
 *   1. 将指定目录压缩为多个独立 zip 分包（默认每包 4GB 预算，可独立解压）
 *   2. zip 设置解压密码（默认 AES-256 加密）
 *   3. 生成 pack-manifest.json 版本清单（记录每个文件的 size/mtime/hash 与版本号）
 *   4. 再次运行时对照清单，只把「新增 + 修改」的文件打进增量更新包
 *   5. 保留完整目录层级，接收方按版本顺序解压覆盖即可
 *
 * 依赖：
 *   7-Zip 命令行（7z.exe）。安装方式：winget install 7zip.7zip
 *   自动探测 PATH 与常见安装路径，也可用环境变量 SEVEN_ZIP 指定完整路径。
 *
 * 用法：
 *   node scripts/pack-release.mjs --source <漫画目录> --out <输出目录> --password <密码>
 *
 * 常用参数：
 *   --source <dir>      源目录（必填）
 *   --out <dir>         输出目录（必填，清单与分包都放这里）
 *   --password <pwd>    解压密码（也可用环境变量 PACK_PASSWORD）
 *   --max-size <size>   单包大小预算，默认 4g（支持 500m / 2g 等写法）
 *   --level <0-9>       压缩等级，默认 0（仅存储；漫画 zip/图片已压缩，0 最快）
 *   --name <name>       分包文件名前缀，默认取源目录名
 *   --full              忽略清单强制全量打包
 *   --hash              用 SHA1 内容对比代替 size+mtime（更准但更慢）
 *   --zip-crypto        使用传统 ZipCrypto 加密（兼容性好但强度低，默认 AES-256）
 *   --verify            打包后执行 7z t 校验每个分包
 *   --exclude <pat>     排除相对路径（支持 * 通配，可多次指定）
 *   --dry-run           只显示差异与分包计划，不实际压缩
 *   --help              帮助
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

// ── 常量 ────────────────────────────────────────────────────────────────────

const MANIFEST_NAME = 'pack-manifest.json'
/** mtime 对比容差（毫秒），兼容 FAT/网络盘的时间精度差异 */
const MTIME_TOLERANCE_MS = 2000
/** 每包预留空间（zip 头部与目录开销） */
const PACK_RESERVE_BYTES = 16 * 1024 * 1024

// ── 参数解析 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    source: '',
    out: '',
    password: process.env.PACK_PASSWORD || '',
    maxSize: 4 * 1024 ** 3,
    level: 0,
    name: '',
    full: false,
    hash: false,
    zipCrypto: false,
    verify: false,
    exclude: [],
    dryRun: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--source': args.source = next() || ''; break
      case '--out': args.out = next() || ''; break
      case '--password': args.password = next() || ''; break
      case '--max-size': args.maxSize = parseSize(next()); break
      case '--level': args.level = Math.max(0, Math.min(9, Number(next()) || 0)); break
      case '--name': args.name = next() || ''; break
      case '--full': args.full = true; break
      case '--hash': args.hash = true; break
      case '--zip-crypto': args.zipCrypto = true; break
      case '--verify': args.verify = true; break
      case '--exclude': args.exclude.push(next() || ''); break
      case '--dry-run': args.dryRun = true; break
      case '--help': case '-h': args.help = true; break
      default:
        console.error(`未知参数: ${a}（使用 --help 查看帮助）`)
        process.exit(1)
    }
  }
  return args
}

/** 解析 "4g" / "500m" / "4gb" / 纯字节数 为字节数 */
function parseSize(str) {
  const m = String(str || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(g|gb|m|mb|k|kb|b)?$/)
  if (!m) {
    console.error(`无法解析大小: "${str}"（示例: 4g / 500m / 1024）`)
    process.exit(1)
  }
  const n = parseFloat(m[1])
  const unit = m[2] || 'b'
  const mul = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 }[unit]
  return Math.floor(n * mul)
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// ── 7-Zip 探测 ──────────────────────────────────────────────────────────────

function find7z() {
  // 1. 环境变量显式指定
  if (process.env.SEVEN_ZIP && fs.existsSync(process.env.SEVEN_ZIP)) {
    return process.env.SEVEN_ZIP
  }
  // 2. PATH 中查找
  const probe = os.platform() === 'win32'
    ? spawnSync('where.exe', ['7z'], { encoding: 'utf-8' })
    : spawnSync('which', ['7z'], { encoding: 'utf-8' })
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim().split(/\r?\n/)[0]
  }
  // 3. 常见安装路径
  const candidates = os.platform() === 'win32'
    ? [
        'C:\\rely\\7-Zip\\7z.exe',
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
      ]
    : ['/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z']
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

// ── 目录扫描 ────────────────────────────────────────────────────────────────

/** 将排除模式编译为正则（* 匹配任意字符段） */
function compileExcludes(patterns) {
  return patterns.filter(Boolean).map(p => {
    const escaped = p.replace(/[/\\]/g, '/')
      .replace(/[.+^${}()|[\]]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`, 'i')
  })
}

/**
 * 递归扫描源目录，返回 Map<相对路径(以 / 分隔), {size, mtimeMs}>
 * 跳过符号链接，避免死循环与外部引用。
 */
function scanFiles(root, excludeRegexps) {
  /** @type {Map<string, {size: number, mtimeMs: number}>} */
  const result = new Map()
  let lastReport = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      console.warn(`⚠ 无法读取目录，已跳过: ${dir} (${err.message})`)
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (excludeRegexps.some(re => re.test(rel))) continue
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full)
          result.set(rel, { size: st.size, mtimeMs: st.mtimeMs })
          // 每 2000 个文件刷新一次扫描进度（大目录/网络盘时避免长时间无反馈）
          if (result.size - lastReport >= 2000) {
            lastReport = result.size
            process.stdout.write(`\r  已扫描 ${result.size} 个文件...`)
          }
        } catch (err) {
          console.warn(`⚠ 无法读取文件信息，已跳过: ${full} (${err.message})`)
        }
      }
    }
  }
  walk(root)
  if (lastReport > 0) process.stdout.write('\r' + ' '.repeat(40) + '\r') // 清除进度行
  return result
}

/** 流式计算文件 SHA1 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => h.update(chunk))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

// ── 差异对比 ────────────────────────────────────────────────────────────────

/**
 * 对照清单计算差异
 * @returns {{ added: string[], modified: string[], deleted: string[], unchanged: number }}
 */
async function diffAgainstManifest(current, manifestFiles, useHash, sourceDir) {
  const added = []
  const modified = []
  const deleted = []
  let unchanged = 0

  // hash 模式进度统计：仅 size 相同的文件需要读内容计算哈希
  let hashTotal = 0
  if (useHash) {
    for (const [rel, info] of current) {
      const prev = manifestFiles[rel]
      if (prev && prev.size === info.size) hashTotal++
    }
  }
  let hashDone = 0

  for (const [rel, info] of current) {
    const prev = manifestFiles[rel]
    if (!prev) {
      added.push(rel)
      continue
    }
    if (useHash) {
      // hash 模式：size 不同必然变化；size 相同再比内容
      if (prev.size !== info.size) {
        modified.push(rel)
        continue
      }
      const h = await hashFile(path.join(sourceDir, rel))
      info.hash = h
      hashDone++
      if (hashDone % 50 === 0 || hashDone === hashTotal) {
        process.stdout.write(`\r  哈希对比进度: ${hashDone}/${hashTotal}`)
      }
      if (prev.hash && prev.hash === h) unchanged++
      else modified.push(rel)
    } else {
      const sameSize = prev.size === info.size
      const sameTime = Math.abs(prev.mtimeMs - info.mtimeMs) <= MTIME_TOLERANCE_MS
      if (sameSize && sameTime) unchanged++
      else modified.push(rel)
    }
  }

  if (useHash && hashDone > 0) process.stdout.write('\n')

  for (const rel of Object.keys(manifestFiles)) {
    if (!current.has(rel)) deleted.push(rel)
  }

  return { added, modified, deleted, unchanged }
}

// ── 分包规划 ────────────────────────────────────────────────────────────────

/**
 * 按路径排序后顺序装箱，保证同一漫画的文件尽量落在同一包内。
 * 单个文件超过预算时独占一包（zip64 支持超大文件）并给出警告。
 *
 * @param {string[]} files - 相对路径列表
 * @param {Map<string, {size: number}>} current
 * @param {number} maxSize
 * @returns {Array<{ files: string[], totalSize: number }>}
 */
function planPackages(files, current, maxSize) {
  const budget = Math.max(maxSize - PACK_RESERVE_BYTES, 1024 ** 2)
  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const packages = []
  let bin = { files: [], totalSize: 0 }

  for (const rel of sorted) {
    const size = current.get(rel).size
    if (size > budget) {
      // 超大文件独占一包
      if (bin.files.length > 0) {
        packages.push(bin)
        bin = { files: [], totalSize: 0 }
      }
      console.warn(`⚠ 文件超过单包预算，将独占一个分包: ${rel} (${formatSize(size)})`)
      packages.push({ files: [rel], totalSize: size })
      continue
    }
    if (bin.totalSize + size > budget && bin.files.length > 0) {
      packages.push(bin)
      bin = { files: [], totalSize: 0 }
    }
    bin.files.push(rel)
    bin.totalSize += size
  }
  if (bin.files.length > 0) packages.push(bin)
  return packages
}

/**
 * 计算分包内容指纹（文件列表 + size + mtime），用于断点续压时判断
 * 上次中断前已完成的分包是否仍与当前源文件一致。
 */
function planFingerprint(files, current) {
  const h = crypto.createHash('sha1')
  for (const rel of files) {
    const info = current.get(rel)
    h.update(`${rel}|${info.size}|${Math.round(info.mtimeMs)}\n`)
  }
  return h.digest('hex')
}

// ── 7-Zip 压缩执行 ──────────────────────────────────────────────────────────

/**
 * 调用 7z 将文件清单压缩为一个 zip（工作目录 = 源目录，保留相对路径层级）
 */
function create7zPackage(sevenZip, sourceDir, relFiles, outZipPath, opts) {
  // 清单文件写入临时目录（UTF-8，配合 -scsUTF-8 支持中文路径）
  const listFile = path.join(os.tmpdir(), `pack-release-list-${process.pid}-${Date.now()}.txt`)
  const nativePaths = relFiles.map(r => r.split('/').join(path.sep)).join(os.EOL)
  fs.writeFileSync(listFile, nativePaths, 'utf-8')

  try {
    const zipArgs = [
      'a',                 // 添加到压缩包
      '-tzip',             // zip 格式
      `-mx=${opts.level}`, // 压缩等级
      opts.zipCrypto ? '-mem=ZipCrypto' : '-mem=AES256',
      `-p${opts.password}`,
      '-scsUTF-8',         // 清单文件编码
      '-mcu=on',           // zip 内文件名使用 UTF-8
      '-ssw',              // 允许压缩被占用的文件
      '-bsp1',             // 进度输出到 stdout
      '-y',
      outZipPath,
      `@${listFile}`,
    ]
    const result = spawnSync(sevenZip, zipArgs, {
      cwd: sourceDir,
      stdio: 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.status !== 0) {
      throw new Error(`7z 压缩失败（退出码 ${result.status}）: ${outZipPath}`)
    }
  } finally {
    try { fs.unlinkSync(listFile) } catch { /* 忽略清理失败 */ }
  }
}

/** 用 7z t 校验分包完整性 */
function verify7zPackage(sevenZip, zipPath, password) {
  const result = spawnSync(sevenZip, ['t', `-p${password}`, '-y', zipPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return result.status === 0
}

// ── 清单读写 ────────────────────────────────────────────────────────────────

function loadManifest(outDir) {
  const file = path.join(outDir, MANIFEST_NAME)
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    console.error(`错误：清单文件已损坏，无法解析: ${file}`)
    console.error(`  ${err.message}`)
    console.error('  如需重新全量打包，请删除该文件或换一个输出目录。')
    process.exit(1)
  }
}

function passwordFingerprint(password) {
  return crypto.createHash('sha256').update(`smanga-pack:${password}`).digest('hex').slice(0, 16)
}

// ── 发布说明生成 ────────────────────────────────────────────────────────────

function buildReleaseNotes(ctx) {
  const { name, version, type, date, packages, diff, encryption } = ctx
  const lines = []
  const vTag = `v${String(version).padStart(3, '0')}`
  lines.push('═'.repeat(60))
  lines.push(`${name} 发布包 ${vTag}（${type === 'full' ? '全量包' : '增量更新包'}）`)
  lines.push(`生成时间: ${date}`)
  lines.push(`加密方式: ${encryption}（需 7-Zip / WinRAR / Bandizip 解压）`)
  lines.push('═'.repeat(60))
  lines.push('')
  lines.push('【使用方法】')
  lines.push('  1. 从 v001 全量包开始，按版本号顺序依次解压所有分包')
  lines.push('  2. 全部解压到同一个根目录，提示覆盖时选择「全部覆盖」')
  lines.push('  3. 若本说明包含「已删除文件」清单，请手动删除对应文件')
  lines.push('')
  lines.push(`【本版分包】共 ${packages.length} 个`)
  for (const p of packages) {
    lines.push(`  ${p.file}  (${formatSize(p.sizeBytes)}, ${p.fileCount} 个文件)`)
  }
  lines.push('')
  lines.push(`【变更统计】新增 ${diff.added.length} / 修改 ${diff.modified.length} / 删除 ${diff.deleted.length}`)
  if (type !== 'full') {
    if (diff.added.length > 0) {
      lines.push('')
      lines.push(`【新增文件】(${diff.added.length})`)
      for (const f of diff.added) lines.push(`  + ${f}`)
    }
    if (diff.modified.length > 0) {
      lines.push('')
      lines.push(`【修改文件】(${diff.modified.length})`)
      for (const f of diff.modified) lines.push(`  * ${f}`)
    }
  }
  if (diff.deleted.length > 0) {
    lines.push('')
    lines.push(`【已删除文件】请解压后手动删除 (${diff.deleted.length})`)
    for (const f of diff.deleted) lines.push(`  - ${f}`)
  }
  lines.push('')
  return lines.join(os.EOL)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(`
漫画目录增量分包压缩脚本

用法：
  node scripts/pack-release.mjs --source <源目录> --out <输出目录> --password <密码>

参数：
  --source <dir>     源目录（必填）
  --out <dir>        输出目录（必填）
  --password <pwd>   解压密码（也可用环境变量 PACK_PASSWORD）
  --max-size <size>  单包大小预算，默认 4g
  --level <0-9>      压缩等级，默认 0（仅存储，适合已压缩的漫画文件）
  --name <name>      分包文件名前缀，默认取源目录名
  --full             忽略清单强制全量打包
  --hash             用 SHA1 内容对比（更准确但需读取全部文件）
  --zip-crypto       使用 ZipCrypto 加密（兼容旧工具，强度低）
  --verify           打包后校验每个分包
  --exclude <pat>    排除相对路径（支持 * 通配，可多次指定）
  --dry-run          只显示差异与分包计划，不实际压缩
`)
    return
  }

  // ── 参数校验 ──
  if (!args.source || !args.out) {
    console.error('错误：--source 与 --out 为必填参数（--help 查看用法）')
    process.exit(1)
  }
  const sourceDir = path.resolve(args.source)
  const outDir = path.resolve(args.out)
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.error(`错误：源目录不存在: ${sourceDir}`)
    process.exit(1)
  }
  if (outDir === sourceDir || outDir.startsWith(sourceDir + path.sep)) {
    console.error('错误：输出目录不能位于源目录内部（会把分包自己也压进去）')
    process.exit(1)
  }
  if (!args.password && !args.dryRun) {
    console.error('错误：未提供密码（--password 或环境变量 PACK_PASSWORD）')
    process.exit(1)
  }

  const sevenZip = find7z()
  if (!sevenZip && !args.dryRun) {
    console.error('错误：未找到 7-Zip 命令行工具（7z.exe）')
    console.error('  安装方式: winget install 7zip.7zip')
    console.error('  或设置环境变量 SEVEN_ZIP 指向 7z.exe 完整路径')
    process.exit(1)
  }

  const name = args.name || path.basename(sourceDir)
  console.log(`源目录:   ${sourceDir}`)
  console.log(`输出目录: ${outDir}`)
  console.log(`包前缀:   ${name}`)
  console.log(`单包预算: ${formatSize(args.maxSize)}`)
  console.log(`压缩等级: ${args.level}${args.level === 0 ? '（仅存储）' : ''}`)
  console.log(`加密方式: ${args.zipCrypto ? 'ZipCrypto' : 'AES-256'}`)
  console.log(`对比方式: ${args.hash ? 'SHA1 内容对比' : 'size + mtime'}`)
  console.log(`7-Zip:    ${sevenZip || '(dry-run 未探测)'}`)
  console.log('')

  // ── 加载清单 ──
  const manifest = args.full ? null : loadManifest(outDir)
  const prevFiles = manifest?.files || {}
  const version = (manifest?.version || 0) + 1
  const isFull = !manifest
  const vTag = `v${String(version).padStart(3, '0')}`

  if (manifest) {
    console.log(`已加载清单: 当前版本 v${manifest.version}（${Object.keys(prevFiles).length} 个文件），本次将生成 ${vTag} 增量包`)
    // 密码一致性检查：各版本密码不一致会导致接收方混乱
    if (args.password && manifest.passwordFingerprint &&
        manifest.passwordFingerprint !== passwordFingerprint(args.password)) {
      console.warn('⚠ 警告：本次密码与历史版本不一致！接收方将需要两个不同密码。')
    }
    if (manifest.compare && manifest.compare !== (args.hash ? 'hash' : 'size-mtime')) {
      console.warn(`⚠ 警告：对比方式与清单记录不一致（清单: ${manifest.compare}），可能产生误判。`)
    }
  } else {
    console.log(`未找到历史清单${args.full ? '（--full 强制全量）' : ''}，本次将生成 ${vTag} 全量包`)
  }
  console.log('')

  // ── 扫描 + 差异对比 ──
  console.log('正在扫描源目录...')
  const excludeRegexps = compileExcludes(args.exclude)
  const current = scanFiles(sourceDir, excludeRegexps)
  const totalSize = [...current.values()].reduce((s, f) => s + f.size, 0)
  console.log(`扫描完成: ${current.size} 个文件，共 ${formatSize(totalSize)}`)

  if (args.hash) console.log('正在计算文件哈希（--hash 模式，可能较慢）...')
  const diff = await diffAgainstManifest(current, isFull ? {} : prevFiles, args.hash, sourceDir)
  const changedFiles = [...diff.added, ...diff.modified]

  console.log('')
  console.log(`差异统计: 新增 ${diff.added.length} / 修改 ${diff.modified.length} / 删除 ${diff.deleted.length} / 未变化 ${diff.unchanged}`)

  if (changedFiles.length === 0 && diff.deleted.length === 0) {
    console.log('')
    console.log('✓ 没有任何变化，无需打包。')
    return
  }

  // ── 分包规划 ──
  const changedSize = changedFiles.reduce((s, f) => s + current.get(f).size, 0)
  const plan = planPackages(changedFiles, current, args.maxSize)
  console.log(`待打包: ${changedFiles.length} 个文件（${formatSize(changedSize)}）→ ${plan.length} 个分包`)
  console.log('')
  plan.forEach((p, i) => {
    console.log(`  part${String(i + 1).padStart(2, '0')}: ${p.files.length} 个文件, ${formatSize(p.totalSize)}`)
  })

  if (args.dryRun) {
    console.log('')
    if (diff.deleted.length > 0) {
      console.log(`已删除文件（将写入发布说明）:`)
      diff.deleted.slice(0, 50).forEach(f => console.log(`  - ${f}`))
      if (diff.deleted.length > 50) console.log(`  ... 等共 ${diff.deleted.length} 个`)
      console.log('')
    }
    console.log('⚠ 当前为 --dry-run 预览模式，未执行压缩，清单未更新。')
    return
  }

  // ── 执行压缩（支持断点续压）──
  const releaseDirName = `${vTag}-${isFull ? 'full' : 'update'}`
  const releaseDir = path.join(outDir, releaseDirName)
  fs.mkdirSync(releaseDir, { recursive: true })

  // 断点续压：读取上次中断的进度状态，指纹一致的已完成分包直接跳过
  const progressFile = path.join(releaseDir, '.pack-progress.json')
  const fingerprints = plan.map(p => planFingerprint(p.files, current))
  let completedParts = new Set()
  try {
    const prog = JSON.parse(fs.readFileSync(progressFile, 'utf-8'))
    if (prog.version === version &&
        Array.isArray(prog.fingerprints) &&
        prog.fingerprints.length === fingerprints.length &&
        prog.fingerprints.every((f, i) => f === fingerprints[i])) {
      completedParts = new Set(prog.completed || [])
      if (completedParts.size > 0) {
        console.log('')
        console.log(`⚿ 检测到上次中断的进度：已完成 ${completedParts.size}/${plan.length} 个分包，将断点续压`)
      }
    } else {
      console.log('')
      console.log('⚠ 检测到中断进度，但源文件或分包计划已变化，将重新生成全部分包')
    }
  } catch { /* 无进度文件，正常全新打包 */ }

  const saveProgress = () => {
    fs.writeFileSync(progressFile, JSON.stringify({
      version,
      fingerprints,
      completed: [...completedParts],
    }), 'utf-8')
  }

  const startTime = Date.now()
  const packages = []
  for (let i = 0; i < plan.length; i++) {
    const part = String(i + 1).padStart(2, '0')
    const zipName = `${name}.${vTag}.part${part}.zip`
    const zipPath = path.join(releaseDir, zipName)

    // 已完成的分包：文件存在即跳过（--verify 时仍重新校验一遍）
    if (completedParts.has(i) && fs.existsSync(zipPath)) {
      let ok = true
      if (args.verify) {
        process.stdout.write(`── [${i + 1}/${plan.length}] ${zipName} 已完成，校验中... `)
        ok = verify7zPackage(sevenZip, zipPath, args.password)
        console.log(ok ? '通过 ✓，跳过' : '失败，重新压缩')
      } else {
        console.log(`── [${i + 1}/${plan.length}] ${zipName} 已完成，跳过（断点续压）──`)
      }
      if (ok) {
        packages.push({
          file: zipName,
          sizeBytes: fs.statSync(zipPath).size,
          fileCount: plan[i].files.length,
        })
        continue
      }
      completedParts.delete(i)
    }
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath) // 清理压到一半的残留

    console.log('')
    console.log(`── [${i + 1}/${plan.length}] 压缩 ${zipName}（${plan[i].files.length} 个文件, ${formatSize(plan[i].totalSize)}）──`)
    create7zPackage(sevenZip, sourceDir, plan[i].files, zipPath, {
      level: args.level,
      password: args.password,
      zipCrypto: args.zipCrypto,
    })

    if (args.verify) {
      process.stdout.write('  校验中... ')
      if (!verify7zPackage(sevenZip, zipPath, args.password)) {
        console.error(`\n错误：分包校验失败: ${zipPath}`)
        process.exit(1)
      }
      console.log('通过 ✓')
    }

    // 每个分包成功后立即记录进度，中断后可续压
    completedParts.add(i)
    saveProgress()

    packages.push({
      file: zipName,
      sizeBytes: fs.statSync(zipPath).size,
      fileCount: plan[i].files.length,
    })
  }

  // ── 更新清单（所有分包成功后才写入） ──
  const now = new Date()
  const dateStr = now.toISOString()
  const newFiles = {}
  for (const [rel, info] of current) {
    const prev = prevFiles[rel]
    const isChanged = isFull || !prev || diff.added.includes(rel) || diff.modified.includes(rel)
    newFiles[rel] = {
      size: info.size,
      mtimeMs: Math.round(info.mtimeMs),
      ...(info.hash ? { hash: info.hash } : prev?.hash ? { hash: prev.hash } : {}),
      version: isChanged ? version : prev.version,
    }
  }

  const releaseRecord = {
    version,
    tag: vTag,
    type: isFull ? 'full' : 'update',
    date: dateStr,
    dir: releaseDirName,
    packages,
    added: diff.added.length,
    modified: diff.modified.length,
    deleted: diff.deleted.length,
    deletedFiles: diff.deleted,
  }

  const newManifest = {
    name,
    version,
    createdAt: manifest?.createdAt || dateStr,
    updatedAt: dateStr,
    compare: args.hash ? 'hash' : 'size-mtime',
    encryption: args.zipCrypto ? 'ZipCrypto' : 'AES-256',
    passwordFingerprint: passwordFingerprint(args.password),
    sourceDir,
    fileCount: current.size,
    totalSizeBytes: totalSize,
    files: newFiles,
    releases: [...(manifest?.releases || []), releaseRecord],
  }
  fs.writeFileSync(path.join(outDir, MANIFEST_NAME), JSON.stringify(newManifest, null, 2), 'utf-8')

  // 全部完成，清理断点续压进度文件
  try { fs.unlinkSync(progressFile) } catch { /* 忽略 */ }

  // ── 生成发布说明 ──
  const notes = buildReleaseNotes({
    name,
    version,
    type: isFull ? 'full' : 'update',
    date: now.toLocaleString('zh-CN'),
    packages,
    diff,
    encryption: args.zipCrypto ? 'ZipCrypto' : 'AES-256',
  })
  fs.writeFileSync(path.join(releaseDir, `${vTag}-发布说明.txt`), notes, 'utf-8')

  // ── 汇总 ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const packedSize = packages.reduce((s, p) => s + p.sizeBytes, 0)
  console.log('')
  console.log('═'.repeat(60))
  console.log(`✓ ${vTag} ${isFull ? '全量包' : '增量更新包'} 生成完成（耗时 ${elapsed}s）`)
  console.log(`  输出目录: ${releaseDir}`)
  console.log(`  分包数量: ${packages.length} 个，共 ${formatSize(packedSize)}`)
  console.log(`  清单已更新: ${path.join(outDir, MANIFEST_NAME)}`)
  if (diff.deleted.length > 0) {
    console.log(`  ⚠ 有 ${diff.deleted.length} 个文件已删除，清单已写入发布说明，请提醒接收方手动删除`)
  }
  console.log('')
  console.log('分享时请上传整个版本目录（分包 + 发布说明），pack-manifest.json 无需分享。')
}

main().catch((err) => {
  console.error('脚本执行出错:', err)
  process.exit(1)
})
