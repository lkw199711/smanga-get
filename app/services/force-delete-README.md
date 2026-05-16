# 强制删除工具 (Force Delete)

解决 Windows 11 文件/目录被占用无法删除的问题。

## 📍 脚本位置

```
d:/15dev/smanga/smanga-get/app/services/force-delete.ps1
```

## 🚀 使用方法

### 方法1: 直接传入路径参数
```powershell
.\force-delete.ps1 -Path "D:\path\to\directory"
```

### 方法2: 简写形式
```powershell
.\force-delete.ps1 "D:\path\to\directory"
```

## 💡 使用示例

```powershell
# 进入脚本目录
cd d:/15dev/smanga/smanga-get/app/services

# 删除 organized 目录
.\force-delete.ps1 "organized"

# 删除 zipped 目录
.\force-delete.ps1 "zipped"

# 删除 extract_001 目录
.\force-delete.ps1 "extract_001"

# 删除指定文件
.\force-delete.ps1 "D:\temp\占用文件.txt"
```

## 🔧 5种删除策略

脚本会自动尝试以下方法,逐级降级直到成功:

1. **普通删除** - PowerShell `Remove-Item` 命令
2. **Robocopy清空** - 用空目录镜像覆盖后再删除 (解决深度路径问题)
3. **CMD命令** - 使用 `rd /s /q` 强制删除
4. **结束进程** - 查找并结束占用文件的进程 (需要 handle.exe)
5. **重启后删除** - 创建计划任务,重启后自动删除

## ✨ 功能亮点

- ✅ **安全确认** - 删除前显示文件大小和内容,需要输入 Y 确认
- ✅ **智能降级** - 自动尝试多种方法,直到成功
- ✅ **彩色输出** - 清晰的状态提示和错误信息
- ✅ **详细日志** - 显示使用的删除方法和结果
- ✅ **进度显示** - 实时反馈删除进度

## 📊 输出示例

```
========================================
  Force Delete Tool
========================================

[DIR] D:\15dev\smanga\smanga-get\app\services\organized
  Items: 1234 files/directories
  Size: 1.25 GB

WARNING: This action is irreversible!
Confirm deletion? (Type Y to confirm): Y

[INFO] Preparing to delete: D:\15dev\smanga\smanga-get\app\services\organized
[INFO] Using robocopy method...
[SUCCESS] Deleted (robocopy): D:\15dev\smanga\smanga-get\app\services\organized
```

## ⚠️ 注意事项

1. **不可逆操作** - 删除后无法恢复,请谨慎使用
2. **管理员权限** - 某些系统文件可能需要管理员权限运行
3. **handle.exe** - 第4种方法需要 Sysinternals 的 handle.exe 工具
4. **重启删除** - 如果所有方法都失败,脚本会创建重启后删除任务

## 🛠️ 常见问题

### Q: 提示"无法加载脚本"怎么办?
A: 需要先允许PowerShell执行脚本:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Q: 如何获取 handle.exe?
A: 从 Microsoft Sysinternals 下载:
https://learn.microsoft.com/en-us/sysinternals/downloads/handle

下载后放到系统PATH目录或脚本同级目录。

### Q: 删除大目录很慢怎么办?
A: Robocopy方法通常最快,脚本会自动优先使用。如果还是很慢,可以尝试:
- 关闭杀毒软件实时防护
- 关闭Windows Defender
- 使用第三方工具如 IObit Unlocker

## 📝 脚本参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| -Path | string | 是 | 要删除的文件或目录路径 |

## 🎯 适用场景

- Windows 11 文件被占用无法删除
- 深度嵌套目录结构删除失败
- 权限问题导致删除失败
- 需要批量删除大量文件
- 需要强制清理临时文件

## 📄 许可证

仅供个人学习和使用,请谨慎操作重要文件。

