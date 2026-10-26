# Run on the toolbox PC. GrokBot can run this after pulling FAFO-Power-Toolbox.
# Removes the logon watchdog and the always-on server shortcut.
# Leaves a 2-minute check that starts the tagger when Chrome is open, then exits.
$ErrorActionPreference = "Continue"
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $root "server\server_watchdog.py"))) {
    $root = "C:\_git\HTMLPROJECTS"
}
$watchdog = Join-Path $root "server\server_watchdog.py"
$py = Join-Path $root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $py)) { $py = Join-Path $root ".venv\Scripts\python.exe" }

Write-Host "Toolbox root: $root"
Write-Host "Stopping resident watchdog and tray..."
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "server_watchdog.py|tray_launcher.py" -and $_.Name -match "python" } |
    ForEach-Object {
        Write-Host "  stop pid $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
foreach ($name in @(
    "FAFO Server Watchdog.cmd",
    "FAFO Server Watchdog.lnk",
    "FAFO Toolbox Servers.lnk",
    "AI Toolbox Server.lnk"
)) {
    $path = Join-Path $startup $name
    if (Test-Path $path) {
        Remove-Item $path -Force
        Write-Host "Removed startup $name"
    }
}

foreach ($task in @("FAFO-Server-Watchdog", "FAFO-Server-Watchdog-Poll")) {
    schtasks /Delete /TN $task /F 2>$null | Out-Null
}

if ((Test-Path $watchdog) -and (Test-Path $py)) {
    $tr = "`"$py`" `"$watchdog`" --once"
    schtasks /Create /TN "FAFO-Server-Watchdog-Poll" /TR $tr /SC MINUTE /MO 2 /RL LIMITED /F | Out-Null
    Write-Host "2-minute check installed. It exits when finished. It is not a resident server."
    & $py $watchdog --once
} else {
    Write-Host "Watchdog or toolbox Python was not found. Pull the toolbox, then run this again from Scripts."
}

Write-Host "Toolbox Python stays up only while the toolbox is open."
Write-Host "The tagger stays up while Chrome or the toolbox is open, and stops when both are closed."
