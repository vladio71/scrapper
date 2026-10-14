# Run from an elevated PowerShell:  powershell -ExecutionPolicy Bypass -File .\update-task.ps1
#
# Registers "JobWatcher" with LogonType S4U ("run whether user is logged on or not",
# no password stored). The process then lives outside the interactive desktop, so no
# console window ever appears. The watcher only needs network, not the screen, so
# that is fine. Output goes to .watch\watch.log (watch.ts writes it itself).

$ErrorActionPreference = 'Stop'
$taskName = 'JobWatcher'
$workDir  = $PSScriptRoot
$npmCmd   = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { $npmCmd = 'C:\nvm4w\nodejs\npm.cmd' }
if (-not (Test-Path $npmCmd)) { throw "npm.cmd not found: $npmCmd" }
Write-Host "Folder: $workDir"
Write-Host "npm:    $npmCmd"

# Action: npm.cmd run watch
$action = New-ScheduledTaskAction `
    -Execute $npmCmd `
    -Argument 'run watch' `
    -WorkingDirectory $workDir

# Trigger: at logon of current user (S4U task starts then, but detached from the desktop)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# Settings: no time limit (PT0S = unlimited), restart every 1 min up to 999 times,
#           StartWhenAvailable, no parallel runs, battery-safe
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 999 `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

# Stop any currently running instance
$running = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Running' }
if ($running) {
    Write-Host "Stopping running instance..."
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
}

# Always re-register: Set-ScheduledTask cannot change the principal (LogonType).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -Principal $principal `
    -Force | Out-Null

# Kill a watcher started by hand from a terminal, otherwise the new one exits with
# "Watcher already running" (port lock) and the task restarts every minute forever.
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -match 'watch\.ts' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "Done. Starting task..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "=== Action ==="
(Get-ScheduledTask -TaskName $taskName).Actions |
    Select-Object Execute, Arguments, WorkingDirectory | Format-List

Write-Host "=== Trigger ==="
(Get-ScheduledTask -TaskName $taskName).Triggers | Format-List *

Write-Host "=== Settings ==="
(Get-ScheduledTask -TaskName $taskName).Settings |
    Select-Object StartWhenAvailable, MultipleInstances, ExecutionTimeLimit,
        RestartInterval, RestartCount,
        DisallowStartIfOnBatteries, StopIfGoingOnBatteries | Format-List

Write-Host "=== Principal ==="
(Get-ScheduledTask -TaskName $taskName).Principal | Select-Object UserId, LogonType, RunLevel | Format-List

Write-Host "=== Task State ==="
Get-ScheduledTaskInfo -TaskName $taskName |
    Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime | Format-List
