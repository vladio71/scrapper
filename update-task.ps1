$ErrorActionPreference = 'Stop'
$taskName = 'JobWatcher'
$workDir  = 'C:\Users\vladd\Documents\new_resumes\job-scrapper'
$npmCmd   = 'C:\nvm4w\nodejs\npm.cmd'

# Action: npm.cmd run watch
$action = New-ScheduledTaskAction `
    -Execute $npmCmd `
    -Argument 'run watch' `
    -WorkingDirectory $workDir

# Trigger: at logon of current user
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

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Updating existing task..."
    Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
} else {
    Write-Host "Creating new task..."
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
    Register-ScheduledTask `
        -TaskName  $taskName `
        -Action    $action `
        -Trigger   $trigger `
        -Settings  $settings `
        -Principal $principal `
        -Force | Out-Null
}

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

Write-Host "=== Task State ==="
Get-ScheduledTaskInfo -TaskName $taskName |
    Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime | Format-List
