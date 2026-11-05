@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

set "TASK=JDBabelPush5Min"
set "RUNNER=%~dp0push.bat"

if /i "%~1"=="remove" goto REMOVE
if /i "%~1"=="status" goto STATUS

echo.
echo   注册计划任务：%TASK%
echo   每 5 分钟运行一次，调用 %RUNNER%
echo.
schtasks /create /tn "%TASK%" /tr "\"%RUNNER%\"" /sc minute /mo 5 /f
if errorlevel 1 (
  echo.
  echo   [失败] 可能是权限不足：请右键本文件 - 以管理员身份运行
  echo.
  pause
  exit /b 1
)
echo.
echo   [成功] 已注册。立即试跑一次 ...
schtasks /run /tn "%TASK%"
echo.
echo   查看运行日志：type data\push\run.log
echo   查看最新播报：type data\push\latest.txt
echo   卸载：双击本文件后加参数 remove，或运行  install-task.bat remove
echo.
pause
exit /b 0

:STATUS
schtasks /query /tn "%TASK%" /fo LIST /v
pause
exit /b 0

:REMOVE
schtasks /delete /tn "%TASK%" /f
echo.
echo   [完成] 已删除计划任务 %TASK%
echo.
pause
exit /b 0
