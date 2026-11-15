<#
.SYNOPSIS
    Run Verdandi Writer for development.

.DESCRIPTION
    By default starts the Electron app in dev mode; the app launches the Python
    sidecar itself. -SidecarOnly runs just the sidecar on a fixed port with a
    printed token, for exercising the API by hand.

    -Samples copies samples\ to "%LOCALAPPDATA%\Verdandi Writer samples" (once;
    -ResetSamples copies it afresh) and opens that copy as a workspace root, so
    trying things never changes the repo's samples.
#>
param(
    [switch]$SidecarOnly,
    [switch]$Samples,
    [switch]$ResetSamples,
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'app'
$sidecarDir = Join-Path $repoRoot 'sidecar'
$python = Join-Path $sidecarDir '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    throw "Sidecar environment missing. Run scripts\setup-sidecar.ps1 first."
}

if ($SidecarOnly) {
    Push-Location $sidecarDir
    try { & $python -m verdandi_ai --port $Port } finally { Pop-Location }
    return
}

if ($Samples -or $ResetSamples) {
    $copy = Join-Path $env:LOCALAPPDATA 'Verdandi Writer samples'
    if ($ResetSamples -and (Test-Path $copy)) { Remove-Item -Recurse -Force $copy }
    if (-not (Test-Path $copy)) {
        Copy-Item -Recurse (Join-Path $repoRoot 'samples') $copy
        Write-Host "Copied the samples to $copy"
    }
    $env:VERDANDI_ADD_ROOT = $copy
}

Push-Location $appDir
try {
    if (-not (Test-Path (Join-Path $appDir 'node_modules'))) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    npm run dev
} finally {
    Pop-Location
}
