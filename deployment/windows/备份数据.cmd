@echo off
chcp 65001 >nul
title 异域同行 - 备份数据
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Backup-Data.ps1"
if errorlevel 1 echo 备份未完成，请按上面的提示操作。
echo.
pause
