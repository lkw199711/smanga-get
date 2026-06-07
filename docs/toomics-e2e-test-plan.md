# Toomics 功能测试方案

## 背景

当前项目已经有 Japa/Adonis 的测试基础，并已补充 `subsribe.ts`、`task.ts` 的单元测试。下一阶段需要增加真实功能测试，用真实 Toomics 网站验证核心下载链路是否可用。

这类测试依赖真实网络、真实账号、Cookie 状态、站点页面结构和下载目录，因此不应放入默认 `npm test`。建议作为独立 E2E 测试套件，需要显式开关才执行。

## 测试目标

验证 Toomics 单个任务的完整流程：

1. 打开 Toomics 网站。
2. 初始化浏览器和 Cookie。
3. 获取漫画详情页元数据。
4. 解析章节列表。
5. 下载指定漫画的 2 个章节。
6. 校验下载目录中的元数据和图片文件。

测试通过条件：

- 下载根目录下存在目标漫画目录。
- 漫画目录中存在 `.smanga/meta.json`。
- 至少存在 2 个章节目录。
- 每个被校验章节目录中存在图片文件。
- 所有图片文件大小都大于 `250 bytes`。
- 图片文件命名从 `00000` 开始连续递增。
- 不存在空章节、跳号、异常小图。

## 测试定位

新增独立测试套件：

```txt
tests/e2e/
  toomics_download.spec.ts

tests/helpers/
  toomics_e2e_env.ts
  download_assertions.ts
```

建议在 `adonisrc.ts` 中新增 suite：

```ts
{
  files: ['tests/e2e/**/*.spec(.ts|.js)'],
  name: 'e2e',
  timeout: 10 * 60 * 1000,
}
```

建议在 `package.json` 增加脚本：

```json
{
  "test:e2e:toomics": "node ace test e2e",
  "test:e2e:omegascans": "node ace test e2e",
  "test:e2e:gentleman": "node ace test e2e"
}
```

默认 `node ace test` 不应执行真实网站测试。E2E 测试必须由开关控制。

## 环境变量

建议使用以下环境变量驱动测试：

```txt
TOOMICS_E2E_ENABLED=false
TOOMICS_E2E_MANGA_ID=7620
TOOMICS_E2E_MANGA_NAME=测试漫画名
TOOMICS_E2E_MANGA_URL=https://toomics.com/sc/webtoon/episode/toon/7620
TOOMICS_E2E_LANG=sc
TOOMICS_E2E_USER=
TOOMICS_E2E_PASSWORD=
TOOMICS_E2E_KEEP_ARTIFACTS=false

OMEGASCANS_E2E_ENABLED=false
OMEGASCANS_E2E_MANGA_ID=
OMEGASCANS_E2E_MANGA_NAME=
OMEGASCANS_E2E_SERIES_SLUG=
OMEGASCANS_E2E_CHAPTER_COUNT=999
OMEGASCANS_E2E_KEEP_ARTIFACTS=false

GENTLEMAN_E2E_ENABLED=false
GENTLEMAN_E2E_MANGA_ID=
GENTLEMAN_E2E_MANGA_NAME=
GENTLEMAN_E2E_MANGA_URL=
GENTLEMAN_E2E_CHAPTER_INCLUDES=
GENTLEMAN_E2E_CHAPTER_EXCLUDES=
GENTLEMAN_E2E_KEEP_ARTIFACTS=false
```

说明：

- `TOOMICS_E2E_ENABLED` 不为 `true` 时跳过测试。
- `TOOMICS_E2E_USER` 和 `TOOMICS_E2E_PASSWORD` 建议使用专门测试账号。
- `TOOMICS_E2E_KEEP_ARTIFACTS=true` 时保留下载产物，便于失败后排查。
- 测试下载路径必须使用临时目录，不允许写入真实漫画目录。

OmegaScans 说明：

- `OMEGASCANS_E2E_MANGA_ID` 必须是 OmegaScans API 使用的 series id。
- `OMEGASCANS_E2E_SERIES_SLUG` 用于访问 `https://omegascans.org/comics/{slug}` 和章节页。
- OmegaScans 测试会自动写入临时 `data/omegascans.json`，不依赖本机已有缓存。
- OmegaScans 当前不需要账号密码环境变量。

## 测试配置

测试执行前写入临时 `config.json`：

```json
{
  "headless": true,
  "endAfterSetCookie": false,
  "shutdownAfterSetCookie": false,
  "toomics": {
    "noiseEnabled": false,
    "pretendNumStrategy": "fixed",
    "pretendNumWeights": [1, 0, 0],
    "homePageScrollMin": 0,
    "homePageScrollMax": 0
  },
  "toomics-sc": {
    "userName": "${TOOMICS_E2E_USER}",
    "passWord": "${TOOMICS_E2E_PASSWORD}",
    "downloadPath": "${TEMP_DOWNLOAD_PATH}",
    "compressPath": "${TEMP_COMPRESS_PATH}",
    "coverCache": "${TEMP_COVER_CACHE_PATH}",
    "cookieFile": "data/toomics-cookies.json",
    "downloadLockedMeta": false,
    "autoCompress": false,
    "jumpExist": false,
    "scrollStep": 800,
    "scrollDelay": 300,
    "maxRetry": 2,
    "downloadChapterLimit": 2
  }
}
```

如果测试目标是繁体或英文，需要按 `TOOMICS_E2E_LANG` 写入 `toomics-tc` 或 `toomics-en`。

## 需要的代码改造

### 1. 支持章节下载数量限制

当前 `Toomics.start()` 会下载所有未下载章节。为了让 E2E 测试只下载 2 个章节，需要增加配置项：

```ts
downloadChapterLimit?: number
```

建议在 `Toomics.start()` 中筛选章节后限制：

```ts
const limit = Number(this.config?.downloadChapterLimit || 0)
const limitedChaptersToDownload = limit > 0
  ? chaptersToDownload.slice(0, limit)
  : chaptersToDownload
```

生产配置默认不设置，保持原行为。

### 2. 关闭噪声浏览和长延迟

E2E 测试只验证下载链路，不验证反爬行为模型。测试配置中应关闭：

- 登录后噪声浏览
- 任务间隙噪声浏览
- 过长阅读延迟
- 自动压缩

如果现有阅读延迟无法配置，应补一个测试配置开关，例如：

```json
{
  "toomics": {
    "e2eFastMode": true
  }
}
```

然后在 `readingDelay`、`betweenChapterDelay`、`betweenMangaDelay` 中快速返回。

### 3. 避免进程退出

`ToomicsChapterDownloader` 和上层流程中会调用 `end_app()`。测试环境必须确保：

```json
{
  "endAfterSetCookie": false,
  "shutdownAfterSetCookie": false
}
```

必要时给 `end_app()` 增加测试环境保护，避免 E2E 被 `process.exit()` 打断。

### 4. 失败后关闭浏览器

测试必须在 `finally` 中调用：

```ts
await close_all_browsers()
```

避免 Chromium 残留进程影响下一次测试。

## 测试流程

### 准备阶段

1. 检查 `TOOMICS_E2E_ENABLED === 'true'`，否则跳过。
2. 创建独立临时目录：
   - `data`
   - `download`
   - `compress`
   - `cover-cache`
3. 写入 `data/config.json`。
4. 构造 Toomics 任务参数。

示例任务：

```ts
const task = {
  website: 'toomics',
  id: Number(process.env.TOOMICS_E2E_MANGA_ID),
  name: process.env.TOOMICS_E2E_MANGA_NAME,
  url: process.env.TOOMICS_E2E_MANGA_URL,
  langTag: process.env.TOOMICS_E2E_LANG || 'sc',
  chapterCount: 999,
}
```

`chapterCount` 可设置为较大数字，确保 `check_update()` 判定有更新。

### 执行阶段

建议第一版直接调用 service：

```ts
await new Toomics(task, reporter).start()
```

不要先走 `mangaTask`。原因：

- 本测试目标是 Toomics 下载链路。
- 队列层已有单元测试覆盖。
- 直接调用 service 更容易定位失败。

等 Toomics E2E 稳定后，再补一个队列层 E2E：

```ts
mangaTask.add(task)
```

### 校验阶段

校验下载目录：

```txt
download/
  漫画名/
    .smanga/
      meta.json
      banner.jpg
      bannerBackground.jpg
    第001话 xxx/
      00000.jpg
      00001.jpg
      00002.jpg
    第002话 xxx/
      00000.jpg
      00001.jpg
```

断言规则：

1. `meta.json` 存在且可解析。
2. `meta.title` 不为空。
3. `meta.chapters` 是非空数组。
4. 章节目录数量至少为 2。
5. 每个章节目录至少有 1 张图片。
6. 图片文件名连续。
7. 图片大小全部大于 `250 bytes`。

图片连续性检查：

```ts
const indexes = images.map((file) => Number(path.parse(file).name))
const expected = Array.from({ length: indexes.length }, (_, index) => index)
assert.deepEqual(indexes, expected)
```

图片大小检查：

```ts
for (const image of images) {
  const stat = fs.statSync(path.join(chapterDir, image))
  assert.isAbove(stat.size, 250)
}
```

### 清理阶段

默认清理临时目录：

```ts
if (process.env.TOOMICS_E2E_KEEP_ARTIFACTS !== 'true') {
  fs.rmSync(e2eRoot, { recursive: true, force: true })
}
```

失败时建议保留路径输出到日志，便于人工查看：

```txt
E2E artifacts kept at: C:\Users\...\Temp\smanga-get-toomics-e2e
```

## 失败分类

测试失败时应尽量给出明确分类，方便快速判断是代码问题、账号问题还是网站变化。

| 分类 | 含义 | 常见处理 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 未登录或 Cookie 失效 | 检查账号密码、手动认证 |
| `VERIFY_REQUIRED` | 出现手机/验证码验证 | 手动完成验证后重跑 |
| `META_PARSE_FAILED` | 详情页结构变更 | 调整 `meta-fetcher` 解析逻辑 |
| `NO_CHAPTERS_FOUND` | 没解析到章节 | 检查页面结构或权限 |
| `EMPTY_CHAPTER` | 章节目录无图片 | 检查图片请求或风控 |
| `IMAGE_TOO_SMALL` | 图片小于 250 bytes | 可能是干扰图/占位图 |
| `IMAGE_SEQUENCE_GAP` | 图片编号不连续 | 检查下载重试逻辑 |
| `NETWORK_TIMEOUT` | 页面或图片加载超时 | 网络/站点稳定性问题 |

## 风险控制

真实网站 E2E 测试需要控制风险：

- 使用专门测试账号。
- 不在默认测试中执行。
- 不并发执行 Toomics E2E。
- 每次只下载 2 个章节。
- 测试目录使用临时目录。
- 失败时关闭浏览器。
- 不在 CI 高频运行，可改为手动或每日一次。

## 推荐实现顺序

### 阶段一：测试基础设施

1. 在 `adonisrc.ts` 增加 `e2e` suite。
2. 在 `package.json` 增加 `test:e2e:toomics`。
3. 新增 `tests/helpers/toomics_e2e_env.ts`。
4. 新增 `tests/helpers/download_assertions.ts`。

### 阶段二：业务小改造

1. `Toomics` 支持 `downloadChapterLimit`。
2. 测试配置关闭噪声浏览和自动压缩。
3. 确保测试环境不会被 `end_app()` 或 `shut_down()` 退出。

### 阶段三：第一条真实 E2E

1. 新增 `tests/e2e/toomics_download.spec.ts`。
2. 使用真实 Toomics 任务下载 2 个章节。
3. 校验 `.smanga/meta.json` 和章节图片。
4. `finally` 关闭浏览器并按配置清理产物。

### 阶段四：稳定性增强

1. 失败时保存截图、HTML 和下载目录路径。
2. 把失败分类写入错误信息。
3. 增加一个队列层 E2E，验证 `mangaTask.add(task)` 到下载完成。
4. 加入手动 CI job 或本地定时检查。

## OmegaScans 补充实现

OmegaScans E2E 与 Toomics 共用下载目录断言规则，但准备阶段略有不同：

1. 创建临时 `download` 和 `compress` 目录。
2. 写入临时 `data/config.json` 的 `omegascans` 配置。
3. 写入临时 `data/omegascans.json`，包含测试漫画的 `id/title/series_slug`。
4. 调用 `new OmegaScans(task, reporter).start()`。
5. 校验 `.smanga/meta.json` 和前 2 个章节目录中的图片。

执行命令：

```bash
npm run test:e2e:omegascans
```

启用真实测试前至少需要设置：

```txt
OMEGASCANS_E2E_ENABLED=true
OMEGASCANS_E2E_MANGA_ID=...
OMEGASCANS_E2E_MANGA_NAME=...
OMEGASCANS_E2E_SERIES_SLUG=...
```

与 Toomics 一样，未开启 `OMEGASCANS_E2E_ENABLED=true` 时测试只会安全跳过，不访问真实网站。

## Gentleman 补充实现

Gentleman E2E 与 Toomics/OmegaScans 复用下载目录断言，但有两个差异：

1. Gentleman 当前服务会写入 `.smanga` 目录和封面，但不生成 `.smanga/meta.json`，所以断言只要求 `.smanga` 目录存在。
2. Gentleman 下载图片时复用原站图片文件名，不强制改成 `00000.jpg`，所以测试会从文件名末尾提取数字并校验连续性。

测试准备阶段会写入临时 `data/config.json` 的 `gentleman` 配置：

```json
{
  "gentleman": {
    "downloadPath": "${TEMP_DOWNLOAD_PATH}",
    "organizePath": "${TEMP_ORGANIZE_PATH}",
    "organize": false,
    "downloadChapterLimit": 2,
    "chapterIncludes": "",
    "chapterExcludes": ""
  }
}
```

执行命令：

```bash
npm run test:e2e:gentleman
```

启用真实测试前至少需要设置：

```txt
GENTLEMAN_E2E_ENABLED=true
GENTLEMAN_E2E_MANGA_NAME=...
GENTLEMAN_E2E_MANGA_URL=...
```

`GENTLEMAN_E2E_MANGA_ID` 可选；`GENTLEMAN_E2E_CHAPTER_INCLUDES` 和 `GENTLEMAN_E2E_CHAPTER_EXCLUDES` 可用于缩小章节范围。未开启 `GENTLEMAN_E2E_ENABLED=true` 时测试只会安全跳过，不访问真实网站。

## 初版验收标准

初版完成后，执行：

```bash
npm run test:e2e:toomics
```

满足以下条件视为通过：

- 测试能在未开启 `TOOMICS_E2E_ENABLED` 时自动跳过。
- 开启后能真实打开 Toomics。
- 能写入 `meta.json`。
- 能下载 2 个章节。
- 所有图片大于 `250 bytes`。
- 所有章节图片命名连续。
- 测试结束后浏览器关闭。
- 默认不污染真实下载目录。
