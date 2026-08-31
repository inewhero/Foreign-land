[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 3000,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = Join-Path $root "runtime\node.exe"
$serverEntry = "node_modules\tsx\dist\cli.mjs"
$serverSource = "server\index.ts"
$runDirectory = Join-Path $root ".run"
$dataDirectory = Join-Path $root "data"
$pidFile = Join-Path $runDirectory "server.pid"
$stdoutLog = Join-Path $runDirectory "server.out.log"
$stderrLog = Join-Path $runDirectory "server.err.log"
$connectionFile = Join-Path $root "连接信息.txt"

function Test-LocalPort([int]$CandidatePort) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect("127.0.0.1", $CandidatePort, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
  throw "运行时缺失：$runtime。请重新解压完整实验包。"
}
New-Item -ItemType Directory -Path $runDirectory, $dataDirectory -Force | Out-Null

$serverProcess = $null
if (Test-Path -LiteralPath $pidFile) {
  $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  $serverProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
  if (-not $serverProcess) { Remove-Item -LiteralPath $pidFile -Force }
}

if (-not $serverProcess) {
  if (Test-LocalPort $Port) {
    throw "端口 $Port 已被其他程序占用。请关闭占用程序，或使用其他端口启动。"
  }
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
  $env:PORT = [string]$Port
  $env:EXPERIMENT_DB = Join-Path $dataDirectory "experiment.sqlite"
  $serverProcess = Start-Process -FilePath $runtime `
    -ArgumentList @($serverEntry, $serverSource) `
    -WorkingDirectory $root `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $pidFile -Value $serverProcess.Id -Encoding ascii
}

$ready = $false
for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
  if ($serverProcess.HasExited) {
    $details = if (Test-Path -LiteralPath $stderrLog) { Get-Content -LiteralPath $stderrLog -Raw } else { "无错误日志" }
    throw "实验服务启动失败：$details"
  }
  if (Test-LocalPort $Port) { $ready = $true; break }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) { throw "实验服务在20秒内未能启动，请查看 .run\server.err.log。" }

$adminUrl = ""
$participantUrl = ""
for ($attempt = 0; $attempt -lt 20 -and -not $adminUrl; $attempt += 1) {
  if (Test-Path -LiteralPath $stdoutLog) {
    $urls = [regex]::Matches((Get-Content -LiteralPath $stdoutLog -Raw), "http://[^\s]+") | ForEach-Object Value
    $adminUrl = $urls | Where-Object { $_ -match "/admin\?" } | Select-Object -Last 1
    $participantUrl = $urls | Where-Object { $_ -notmatch "/admin\?" } | Select-Object -Last 1
  }
  if (-not $adminUrl) { Start-Sleep -Milliseconds 200 }
}
if (-not $adminUrl) { $adminUrl = "http://127.0.0.1:$Port/admin" }
if (-not $participantUrl) { $participantUrl = "请在主试端二维码区域查看局域网地址" }

$connectionText = @"
异域同行已启动

主试端（仅在本机使用）：
$adminUrl

被试入口：
$participantUrl

服务进程：$($serverProcess.Id)
数据文件：data\experiment.sqlite

请勿把主试端地址或管理令牌发给被试。
实验结束并导出数据后，请双击“停止实验.cmd”。
"@
Set-Content -LiteralPath $connectionFile -Value $connectionText -Encoding utf8

Write-Host ""
Write-Host "异域同行已启动" -ForegroundColor Green
Write-Host "被试入口：$participantUrl"
Write-Host "主试端：$adminUrl"
Write-Host "连接信息已保存到：连接信息.txt"
if (-not $NoBrowser) { Start-Process $adminUrl }
