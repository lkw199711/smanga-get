# E2E 测试说明

项目使用 [Japa](https://japa.dev) 测试框架，测试分为两类：

- **unit** — 纯逻辑测试（订阅文件 API、任务队列），无需任何环境变量，可直接运行
- **e2e** — 真实网站下载测试，**必须手动设置环境变量才能启动**，默认全部跳过

---

## 运行命令

```bash
# 运行所有测试（e2e 默认跳过）
npm test

# 只跑 unit
node ace test unit

# 只跑 e2e（需先设置环境变量）
node ace test e2e
```

---

## Toomics 测试

需要账号密码登录，cookie 会自动管理（过期后通过 env 中的账号密码重新登录）。

### 必填

| 环境变量 | 说明 |
|---|---|
| `TOOMICS_E2E_ENABLED=true` | 启用开关 |
| `TOOMICS_E2E_USER` | 登录邮箱 |
| `TOOMICS_E2E_PASSWORD` | 登录密码 |
| `TOOMICS_E2E_MANGA_ID` | 漫画数字 ID（正整数） |
| `TOOMICS_E2E_MANGA_NAME` | 漫画名称 |

### 选填

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TOOMICS_E2E_LANG` | `tc` | 语言版本：`tc` 繁中 / `en` |
| `TOOMICS_E2E_MANGA_URL` | 自动拼接 | 不填则按 `https://toomics.com/{lang}/webtoon/episode/toon/{id}` 生成 |
| `TOOMICS_E2E_CHAPTER_COUNT` | `999` | 订阅章节总数（用于判断是否有更新） |
| `TOOMICS_E2E_KEEP_ARTIFACTS` | `false` | 是否保留下载产物，默认测试结束后自动删除 |

---

## OmegaScans 测试

公开站点，无需登录。

### 必填

| 环境变量 | 说明 |
|---|---|
| `OMEGASCANS_E2E_ENABLED=true` | 启用开关 |
| `OMEGASCANS_E2E_MANGA_ID` | 漫画数字 ID（正整数） |
| `OMEGASCANS_E2E_MANGA_NAME` | 漫画名称 |
| `OMEGASCANS_E2E_SERIES_SLUG` | URL 中的 series slug |

### 选填

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OMEGASCANS_E2E_CHAPTER_COUNT` | `999` | 订阅章节总数 |
| `OMEGASCANS_E2E_KEEP_ARTIFACTS` | `false` | 是否保留下载产物 |

---

## Gentleman 测试

公开站点（绅士漫画 `wnacg.ru`），无需登录。

### 必填

| 环境变量 | 说明 |
|---|---|
| `GENTLEMAN_E2E_ENABLED=true` | 启用开关 |
| `GENTLEMAN_E2E_MANGA_NAME` | 漫画名称 |
| `GENTLEMAN_E2E_MANGA_URL` | 漫画目录页完整 URL |

### 选填

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `GENTLEMAN_E2E_MANGA_ID` | `gentleman-e2e` | 漫画标识 |
| `GENTLEMAN_E2E_CHAPTER_INCLUDES` | 空 | 章节名正则过滤（只下载匹配的） |
| `GENTLEMAN_E2E_CHAPTER_EXCLUDES` | 空 | 章节名正则排除（跳过匹配的） |
| `GENTLEMAN_E2E_KEEP_ARTIFACTS` | `false` | 是否保留下载产物 |

---

## 验证标准

所有 E2E 测试共享统一的下载结果校验：

- 下载目录存在且有漫画子目录
- 元数据文件（`meta.json`）正常（Gentleman 除外）
- 至少下载 **2 个章节**（取最早的两话）
- 每张图片 **> 250 bytes**
- 图片文件名序号连续

---

## 测试下载目录与配置共享

测试与生产**共享 `data/config.json`**（保证 cookie 一致性），下载产物写入独立的测试目录。

测试下载根目录优先级（三选一，按顺序）：

| 方式 | 说明 |
|---|---|
| `TEST_DOWNLOAD_PATH` 环境变量 | 最方便，直接在 `.env` 设置 |
| `config.json` 中新增 `"testDownloadPath"` 字段 | 持久化配置 |
| 系统临时目录 `os.tmpdir()` | 无任何配置时的兜底 |

示例 `.env`：
```
TEST_DOWNLOAD_PATH=D:/test-downloads
```

测试产物结构：
```
{testDownloadPath}/e2e/{website}/
├── download/      ← 下载的漫画
├── compress/      ← 压缩产物（Toomics/OmegaScans）
├── organize/      ← 整理产物（Gentleman）
└── cover-cache/   ← 封面缓存（Toomics）
```

**测试结束后自动清理下载产物，`config.json` 恢复原始值。**

---

## 安全机制

1. **环境变量开关** — 未设置 `*_E2E_ENABLED=true` 的测试直接跳过
2. **配置隔离** — 测试覆盖的 config 字段在 cleanup 时自动恢复
3. **下载隔离** — 测试下载到独立目录，不影响生产数据
4. **默认清理** — 测试产物默认自动删除，设置 `*_E2E_KEEP_ARTIFACTS=true` 可保留
