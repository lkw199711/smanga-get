# Quick force delete - Try immediate deletion with process explorer
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Path
)

Write-Host "=== Quick Force Delete ===" -ForegroundColor Cyan
Write-Host ""

$resolvedPath = Resolve-Path $Path -ErrorAction SilentlyContinue
if (-not $resolvedPath) {
    Write-Host "[ERROR] Path not found: $Path" -ForegroundColor Red
    exit 1
}

Write-Host "[INFO] Target: $($resolvedPath.Path)" -ForegroundColor Yellow
Write-Host "[INFO] Waiting 2 seconds for locks to release..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

# Try multiple times with short delays
$attempts = 3
for ($i = 1; $i -le $attempts; $i++) {
    Write-Host "[INFO] Attempt $i of $attempts..." -ForegroundColor Cyan
    
    try {
        if (Test-Path $resolvedPath.Path -PathType Container) {
            # Try to take ownership first
            cmd /c "takeown /f `"$($resolvedPath.Path)`" /r /d y" 2>&1 | Out-Null
            cmd /c "icacls `"$($resolvedPath.Path)`" /grant administrators:F /t" 2>&1 | Out-Null
            
            Remove-Item -Path $resolvedPath.Path -Recurse -Force -ErrorAction Stop
            Write-Host "[SUCCESS] Deleted on attempt $i!" -ForegroundColor Green
            exit 0
        } else {
            Remove-Item -Path $resolvedPath.Path -Force -ErrorAction Stop
            Write-Host "[SUCCESS] Deleted on attempt $i!" -ForegroundColor Green
            exit 0
        }
    } catch {
        Write-Host "[WARN] Attempt $i failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Start-Sleep -Milliseconds 500
    }
}

# If all attempts failed, use PowerShell's built-in COM object
Write-Host "[INFO] Trying COM object method..." -ForegroundColor Cyan
try {
    $fso = New-Object -ComObject Scripting.FileSystemObject
    $folder = $fso.GetFolder($resolvedPath.Path)
    $folder.Delete($true)
    Write-Host "[SUCCESS] Deleted with COM object!" -ForegroundColor Green
    exit 0
} catch {
    Write-Host "[WARN] COM method failed" -ForegroundColor Yellow
}

# Last resort: schedule deletion in 10 seconds
Write-Host "[INFO] Scheduling deletion in 10 seconds..." -ForegroundColor Yellow
Write-Host "[INFO] Please close any programs that might be using this folder" -ForegroundColor Yellow

$batchFile = Join-Path $env:TEMP "quick_delete_$(Get-Date -Format 'yyyyMMddHHmmss').bat"
$batchContent = @"
@echo off
timeout /t 10 /nobreak
rd /s /q "$($resolvedPath.Path)" 2>nul
if exist "$($resolvedPath.Path)" (
    echo Failed to delete
) else (
    echo Success
)
del "%~f0"
"@

$batchContent | Out-File -FilePath $batchFile -Encoding ASCII
Start-Process cmd.exe -ArgumentList "/c", $batchFile -WindowStyle Hidden

Write-Host "[SUCCESS] Deletion scheduled, will execute in 10 seconds" -ForegroundColor Green
Write-Host "[INFO] Batch file: $batchFile" -ForegroundColor Cyan
exit 0
