$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $dist "zcode-to-dsh-migrate-v$version.zip"
$staging = Join-Path $dist "zcode-to-dsh-migrate-v$version"

$allowlist = @(
  'bin',
  'lib',
  'test',
  'scripts',
  'package.json',
  'README.md',
  'LICENSE',
  '.gitignore',
  'zcode2dsh.cmd'
)

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

foreach ($item in $allowlist) {
  $source = Join-Path $root $item
  if (-not (Test-Path $source)) {
    throw "Missing publishable item: $item"
  }
  Copy-Item $source -Destination $staging -Recurse -Force
}

# Never ship local migration artifacts or machine-specific launchers.
$forbidden = @('backups', 'reports', 'MIGRATION-RECORD.md', 'node_modules', 'dist', 'bilibili', 'zcode2dsh.local.cmd')
foreach ($name in $forbidden) {
  $target = Join-Path $staging $name
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $zip).Length

Write-Output "Package: $zip"
Write-Output "Size: $size bytes"
Write-Output "SHA256: $hash"
