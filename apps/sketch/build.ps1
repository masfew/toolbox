<#
.SYNOPSIS
  Builds Sketch's installer and its update files into a folder, for a release.

.DESCRIPTION
  The release workflow runs this for a sketch-v<version> tag and attaches everything in -OutDir to the
  GitHub release, so people without the build tools can install it with `python install.py --setup <path>`.
  The build stamps no repo (SKETCH_RELEASE=1): it is the release channel, which updates itself from
  releases, not from a clone. After the installer, scripts/release-files.mjs writes sketch-<version>-app.zip
  (the update) into -OutDir, and latest.json (the update's signed description) when SKETCH_UPDATE_KEY is
  set; without the key it says why and writes no latest.json. Needs Node 24 or newer, Rust with its MSVC
  toolchain and the Visual Studio C++ build tools.

.PARAMETER OutDir
  Where to put Sketch_<version>_x64-setup.exe and the update files. Made if it doesn't exist.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $PWD.Path $OutDir }
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
    & node scripts/release-files.mjs $OutDir
    if ($LASTEXITCODE -ne 0) { Write-Host "Writing the update files failed." -ForegroundColor Red; exit 1 }
    Write-Host "Built $(Join-Path $OutDir (Split-Path $setup -Leaf))"
} finally {
    Remove-Item Env:SKETCH_RELEASE -ErrorAction SilentlyContinue
    Pop-Location
}
