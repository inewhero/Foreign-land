[CmdletBinding()]
param(
  [string]$OutputDirectory,
  [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root "releases" }
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$releaseName = "异域同行-Windows-x64-v$($package.version)-$timestamp"
$releaseRoot = Join-Path $OutputDirectory $releaseName
$archivePath = "$releaseRoot.zip"

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') 执行失败。" }
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return (($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "").ToUpperInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

Push-Location $root
try {
  if (-not $SkipChecks) {
    Write-Host "[1/5] 运行自动测试..." -ForegroundColor Cyan
    Invoke-Checked "npm.cmd" @("test")
    Write-Host "[2/5] 验证正式序列库..." -ForegroundColor Cyan
    Invoke-Checked "npm.cmd" @("run", "sequence:validate")
  }

  Write-Host "[3/5] 构建被试端与主试端..." -ForegroundColor Cyan
  Invoke-Checked "npm.cmd" @("run", "build")

  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $nodeVersion = (& $nodePath --version).Trim()
  if ($nodeVersion -notmatch "^v(2[4-9]|[3-9][0-9])\.") {
    throw "打包需要 Node.js 24 或更新版本，当前为 $nodeVersion。"
  }

  Write-Host "[4/5] 组装独立运行包..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
  foreach ($directory in @("dist", "server", "shared", "node_modules")) {
    Copy-Item -LiteralPath (Join-Path $root $directory) -Destination $releaseRoot -Recurse
  }
  Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $releaseRoot
  Copy-Item -LiteralPath (Join-Path $root "package-lock.json") -Destination $releaseRoot
  Copy-Item -Path (Join-Path $root "deployment\windows\*") -Destination $releaseRoot -Recurse
  New-Item -ItemType Directory -Path (Join-Path $releaseRoot "runtime"), (Join-Path $releaseRoot "data") -Force | Out-Null
  Copy-Item -LiteralPath $nodePath -Destination (Join-Path $releaseRoot "runtime\node.exe")

  $gitCommit = (& git rev-parse --short HEAD 2>$null)
  if (-not $gitCommit) { $gitCommit = "uncommitted" }
  $buildInfo = [ordered]@{
    name = "异域同行"
    applicationVersion = $package.version
    gitCommit = $gitCommit.Trim()
    builtAt = (Get-Date).ToString("o")
    nodeVersion = $nodeVersion
    platform = "Windows x64"
    containsParticipantData = $false
  }
  $buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseRoot "发行信息.json") -Encoding utf8

  Write-Host "[5/5] 创建压缩包并计算校验值..." -ForegroundColor Cyan
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $releaseRoot,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true
  )
  $archiveHash = Get-Sha256 $archivePath
  Set-Content -LiteralPath "$archivePath.sha256.txt" -Value $archiveHash -Encoding ascii

  Write-Host ""
  Write-Host "发行包已生成：" -ForegroundColor Green
  Write-Host $releaseRoot
  Write-Host $archivePath
  Write-Host "SHA256: $archiveHash"
} finally {
  Pop-Location
}
