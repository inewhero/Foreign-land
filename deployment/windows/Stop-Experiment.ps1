[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".run\server.pid"

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host "实验服务当前未运行。"
  exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host "实验服务已停止，已清理旧状态。"
  exit 0
}
if ($process.ProcessName -ne "node") {
  throw "PID $serverPid 不是实验服务，已拒绝停止。请联系开发人员处理。"
}

Stop-Process -Id $serverPid
$process.WaitForExit(5000) | Out-Null
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "异域同行实验服务已安全停止。" -ForegroundColor Green
