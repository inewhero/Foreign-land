@echo off
chcp 65001 >nul
title 异域同行 - 启动实验
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Experiment.ps1"
if errorlevel 1 (
  echo.
  echo 启动失败，请把上面的错误信息发给开发人员。
)
echo.
pause
