[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".run\server.pid"
$database = Join-Path $root "data\experiment.sqlite"
$backupDirectory = Join-Path $root "backups"

if (Test-Path -LiteralPath $pidFile) {
  $serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
    throw '请先在主试端导出数据，再双击停止实验.cmd，然后执行备份。'
  }
}
if (-not (Test-Path -LiteralPath $database)) {
  throw "尚未找到实验数据库；请至少启动过一次实验。"
}

New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$destinationDirectory = Join-Path $backupDirectory "experiment-$stamp"
New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
$databaseFiles = Get-ChildItem -LiteralPath (Split-Path -Parent $database) -File | Where-Object {
  $_.Name -eq "experiment.sqlite" -or $_.Name -eq "experiment.sqlite-wal" -or $_.Name -eq "experiment.sqlite-shm"
}
foreach ($file in $databaseFiles) {
  Copy-Item -LiteralPath $file.FullName -Destination $destinationDirectory
}
$hashLines = Get-ChildItem -LiteralPath $destinationDirectory -File | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.Name
}
Set-Content -LiteralPath (Join-Path $destinationDirectory "SHA256.txt") -Value $hashLines -Encoding ascii
Write-Host "数据已备份到：$destinationDirectory" -ForegroundColor Green
