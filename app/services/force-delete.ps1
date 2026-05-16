# Force Delete Script - Solve Windows file/directory lock issues
# Usage: .\force-delete.ps1 [-Path] "directory or file path"

param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Path
)

function Write-Status {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host $Message -ForegroundColor $Color
}

function ForceDelete {
    param(
        [string]$TargetPath
    )
    
    if (-not (Test-Path $TargetPath)) {
        Write-Status "[ERROR] Path does not exist: $TargetPath" "Red"
        return $false
    }
    
    Write-Status "[INFO] Preparing to delete: $TargetPath" "Yellow"
    
    # Method 1: Try normal deletion
    try {
        if (Test-Path $TargetPath -PathType Container) {
            Remove-Item -Path $TargetPath -Recurse -Force -ErrorAction Stop
            Write-Status "[SUCCESS] Deleted (normal): $TargetPath" "Green"
            return $true
        } else {
            Remove-Item -Path $TargetPath -Force -ErrorAction Stop
            Write-Status "[SUCCESS] Deleted (normal): $TargetPath" "Green"
            return $true
        }
    } catch {
        Write-Status "[WARN] Normal delete failed, trying force delete..." "Yellow"
    }
    
    # Method 2: Use robocopy to empty directory then delete
    if (Test-Path $TargetPath -PathType Container) {
        try {
            Write-Status "[INFO] Using robocopy method..." "Cyan"
            $emptyDir = Join-Path $env:TEMP "empty_dir_$(Get-Date -Format 'yyyyMMddHHmmss')"
            New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
            
            robocopy $emptyDir $TargetPath /MIR /R:0 /W:0 /NP | Out-Null
            
            Remove-Item -Path $emptyDir -Force
            Remove-Item -Path $TargetPath -Force -ErrorAction Stop
            
            Write-Status "[SUCCESS] Deleted (robocopy): $TargetPath" "Green"
            return $true
        } catch {
            Write-Status "[WARN] Robocopy method failed: $_" "Yellow"
        }
    }
    
    # Method 3: Use cmd rd command
    if (Test-Path $TargetPath -PathType Container) {
        try {
            Write-Status "[INFO] Using cmd rd command..." "Cyan"
            $shortPath = (Get-Item $TargetPath).FullName
            cmd /c "rd /s /q `"$shortPath`"" 2>&1 | Out-Null
            
            if (-not (Test-Path $TargetPath)) {
                Write-Status "[SUCCESS] Deleted (cmd rd): $TargetPath" "Green"
                return $true
            }
        } catch {
            Write-Status "[WARN] cmd rd command failed: $_" "Yellow"
        }
    }
    
    # Method 4: Try to find and kill locking processes
    try {
        Write-Status "[INFO] Trying to find and close locking processes..." "Cyan"
        
        $handleOutput = handle.exe $TargetPath 2>&1
        
        if ($handleOutput -match "pid:") {
            $pids = [regex]::Matches($handleOutput, "pid:\s*(\d+)") | ForEach-Object { $_.Groups[1].Value }
            $pids = $pids | Select-Object -Unique
            
            foreach ($pid in $pids) {
                try {
                    $process = Get-Process -Id $pid -ErrorAction Stop
                    Write-Status "  Closing process: $($process.Name) (PID: $pid)" "Cyan"
                    Stop-Process -Id $pid -Force -ErrorAction Stop
                    Start-Sleep -Milliseconds 500
                } catch {
                    Write-Status "  [WARN] Cannot close process $pid : $_" "Yellow"
                }
            }
            
            # Try delete again
            if (Test-Path $TargetPath -PathType Container) {
                Remove-Item -Path $TargetPath -Recurse -Force -ErrorAction Stop
            } else {
                Remove-Item -Path $TargetPath -Force -ErrorAction Stop
            }
            
            Write-Status "[SUCCESS] Deleted (after closing process): $TargetPath" "Green"
            return $true
        }
    } catch {
        Write-Status "[WARN] Close process method failed: $_" "Yellow"
    }
    
    # Method 5: Delete after reboot (create scheduled task)
    try {
        Write-Status "[INFO] Creating delete task after reboot..." "Cyan"
        
        $batchContent = @"
@echo off
timeout /t 3 /nobreak > nul
rd /s /q "$TargetPath" 2>nul
del /f /q "$TargetPath" 2>nul
if exist "$TargetPath" (
    echo Delete failed, please delete manually
) else (
    echo Delete success
)
"@
        
        $batchFile = Join-Path $env:TEMP "force_delete_$(Get-Date -Format 'yyyyMMddHHmmss').bat"
        $batchContent | Out-File -FilePath $batchFile -Encoding ASCII
        
        schtasks /Create /TN "ForceDelete_$(Get-Date -Format 'yyyyMMddHHmmss')" /TR "$batchFile" /SC ONCE /ST 00:00 /RU SYSTEM /F | Out-Null
        
        Write-Status "[SUCCESS] Created delete task after reboot" "Green"
        Write-Status "   Batch file: $batchFile" "Cyan"
        Write-Status "   Will delete automatically after reboot" "Yellow"
        return $true
    } catch {
        Write-Status "[ERROR] All methods failed: $_" "Red"
        Write-Status "Suggestions:" "Yellow"
        Write-Status "  1. Close all programs that might be using the file" "White"
        Write-Status "  2. Reboot and delete immediately" "White"
        Write-Status "  3. Use third-party tools (e.g., IObit Unlocker)" "White"
        return $false
    }
}

# Main flow
Write-Status "========================================" "Cyan"
Write-Status "  Force Delete Tool" "Cyan"
Write-Status "========================================" "Cyan"
Write-Host ""

# Validate path
$resolvedPath = Resolve-Path $Path -ErrorAction SilentlyContinue
if (-not $resolvedPath) {
    Write-Status "[ERROR] Path does not exist: $Path" "Red"
    exit 1
}

# Show what will be deleted
$item = Get-Item $resolvedPath
if ($item.PSIsContainer) {
    $items = (Get-ChildItem $resolvedPath -Recurse -Force -ErrorAction SilentlyContinue).Count
    $size = (Get-ChildItem $resolvedPath -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $sizeStr = if ($size -gt 1GB) { "{0:N2} GB" -f ($size / 1GB) } 
               elseif ($size -gt 1MB) { "{0:N2} MB" -f ($size / 1MB) }
               elseif ($size -gt 1KB) { "{0:N2} KB" -f ($size / 1KB) }
               else { "$size bytes" }
    
    Write-Status "[DIR] $($resolvedPath.Path)" "White"
    Write-Status "  Items: $items files/directories" "White"
    Write-Status "  Size: $sizeStr" "White"
} else {
    Write-Status "[FILE] $($resolvedPath.Path)" "White"
    $sizeKB = [math]::Round($item.Length / 1KB, 2)
    Write-Status "  Size: $sizeKB KB" "White"
}

Write-Host ""
Write-Status "WARNING: This action is irreversible!" "Red"
$confirm = Read-Host "Confirm deletion? (Type Y to confirm)"

if ($confirm -ne "Y" -and $confirm -ne "y") {
    Write-Status "Operation cancelled" "Yellow"
    exit 0
}

Write-Host ""
$result = ForceDelete -TargetPath $resolvedPath.Path

if ($result) {
    exit 0
} else {
    exit 1
}
