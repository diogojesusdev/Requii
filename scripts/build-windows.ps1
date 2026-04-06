param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('all', 'installer', 'portable')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot -Parent
$builderPath = Join-Path $projectRoot 'node_modules\.bin\electron-builder.cmd'
$stagingOutputDir = Join-Path $env:LOCALAPPDATA 'Requii\release'
$projectReleaseDir = Join-Path $projectRoot 'release'

if (-not (Test-Path $builderPath)) {
    throw "electron-builder was not found at $builderPath"
}

$targets = @(switch ($Mode) {
    'installer' { @('nsis', 'msi') }
    'portable' { @('portable') }
    default { @('nsis', 'portable', 'msi') }
})

$builderArgs = @('--win') + $targets + @("-c.directories.output=$stagingOutputDir")

New-Item -ItemType Directory -Path $stagingOutputDir -Force | Out-Null
Get-ChildItem -Path $stagingOutputDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

Push-Location $projectRoot
try {
    & $builderPath @builderArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}

New-Item -ItemType Directory -Path $projectReleaseDir -Force | Out-Null
Get-ChildItem -Path $stagingOutputDir -File | Copy-Item -Destination $projectReleaseDir -Force

Write-Host "Windows artifacts copied to $projectReleaseDir"
Write-Host "Staging output used: $stagingOutputDir"