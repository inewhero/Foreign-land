@echo off
chcp 65001 >nul
title 异域同行 - 停止实验
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Experiment.ps1"
if errorlevel 1 echo 停止失败，请把错误信息发给开发人员。
echo.
pause
