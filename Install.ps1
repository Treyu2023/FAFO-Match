# Downloads or updates FAFO Match only, then puts a Desktop shortcut on this PC.
# Does not clone or update the toolbox.
# Safe to run again. It will not delete a folder that is already there.
# One line from PowerShell:
#   irm https://raw.githubusercontent.com/Treyu2023/FAFO-Match/main/Install.ps1 | iex

$ErrorActionPreference = 'Stop'
$gitRoot = 'C:\_git'
New-Item -ItemType Directory -Force -Path $gitRoot | Out-Null

function Find-Git {
    $cmd = Get-Command git -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($path in @(
        "$env:ProgramFiles\Git\cmd\git.exe",
        "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
    )) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

function Get-ZipRepo([string]$Url, [string]$Dest, [string]$Marker) {
    $zip = Join-Path $env:TEMP ([IO.Path]::GetRandomFileName() + '.zip')
    $stage = Join-Path $env:TEMP ([IO.Path]::GetRandomFileName())
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
    $inner = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1
    if (-not $inner) { throw "Download did not contain the repo." }
    if (-not (Test-Path -LiteralPath $Dest)) {
        New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    }
    Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Dest -Recurse -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath (Join-Path $Dest $Marker))) {
        throw "Missing $Marker after download."
    }
}

function Update-Repo([string]$Url, [string]$Dest, [string]$Marker, [string]$ZipUrl) {
    $git = Find-Git
    $markerPath = Join-Path $Dest $Marker
    if ((Test-Path -LiteralPath $markerPath) -and (Test-Path -LiteralPath (Join-Path $Dest '.git')) -and $git) {
        Write-Host "Updating $Dest"
        & $git -C $Dest pull --ff-only
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Could not fast-forward $Dest. Local changes are still there. Nothing was deleted."
        }
        return $Dest
    }
    if (-not (Test-Path -LiteralPath $markerPath)) {
        Write-Host "Downloading $Url"
        if ($git) {
            & $git clone $Url $Dest
            if ($LASTEXITCODE -ne 0) { throw "git clone failed for $Url" }
        } else {
            Get-ZipRepo $ZipUrl $Dest $Marker
        }
    } else {
        Write-Host "Using existing $Dest"
    }
    return $Dest
}

function New-DesktopShortcut([string]$Name, [string]$Target, [string]$WorkDir, [string]$Arguments, [string]$Description) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $path = Join-Path $desktop ($Name + '.lnk')
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $Target
    if ($Arguments) { $link.Arguments = $Arguments }
    $link.WorkingDirectory = $WorkDir
    $link.WindowStyle = 1
    $link.Description = $Description
    $link.Save()
    Write-Host "Shortcut: $path"
}

Write-Host ""
Write-Host "FAFO Match install" -ForegroundColor Cyan
Write-Host "Toolbox is left alone."

$match = Update-Repo `
    -Url 'https://github.com/Treyu2023/FAFO-Match.git' `
    -Dest 'C:\_git\FAFO-Match' `
    -Marker 'Start FAFO Match.bat' `
    -ZipUrl 'https://github.com/Treyu2023/FAFO-Match/archive/refs/heads/main.zip'

$matchBat = Join-Path $match 'Start FAFO Match.bat'
New-DesktopShortcut -Name 'FAFO Match' -Target $matchBat -WorkDir $match -Arguments '' -Description 'FAFO Match. Copies and before/after pairs. Closes when you close the window.'

$installScript = Join-Path $match 'Install.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-DesktopShortcut -Name 'Update FAFO Match' -Target $powershell -WorkDir $match `
    -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$installScript`"" `
    -Description 'Pull the latest FAFO Match and refresh the desktop shortcut.'

Write-Host ""
Write-Host "Done."
Write-Host "  FAFO Match:  $match"
Write-Host "Desktop shortcuts: FAFO Match, Update FAFO Match"
Write-Host ""
