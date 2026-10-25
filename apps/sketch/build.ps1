<#
.SYNOPSIS
  Builds Sketch's installer into a folder, for a release.

.DESCRIPTION
  The release workflow runs this for a sketch-v<version> tag and attaches everything in -OutDir to the
  GitHub release, so people without the build tools can install it with `python install.py --setup <path>`.
  The build stamps no repo (SKETCH_RELEASE=1): an installer from a release has no clone to update itself
  from. Needs Node 24 or newer, Rust with its MSVC toolchain and the Visual Studio C++ build tools.

.PARAMETER OutDir
  Where to put Sketch_<version>_x64-setup.exe. Made if it doesn't exist.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $env:SKETCH_RELEASE = '1'
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Write-Host "npm ci failed." -ForegroundColor Red; exit 1 }
    & npm run tauri build
    if ($LASTEXITCODE -ne 0) { Write-Host "Build failed." -ForegroundColor Red; exit 1 }
    $version = (Get-Content (Join-Path $PSScriptRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
    $setup = Join-Path $PSScriptRoot "src-tauri\target\release\bundle\nsis\Sketch_${version}_x64-setup.exe"
    if (-not (Test-Path $setup)) { Write-Host "The build made no $setup." -ForegroundColor Red; exit 1 }
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    Copy-Item $setup $OutDir -Force
    Write-Host "Built $(Join-Path $OutDir (Split-Path $setup -Leaf))"
} finally {
    Remove-Item Env:SKETCH_RELEASE -ErrorAction SilentlyContinue
    Pop-Location
}
