@echo off
rem JD "double subsidy" 5-minute push runner
rem Called by Windows Task Scheduler: schtasks /tn "JDBabelPush5Min"
setlocal
cd /d "%~dp0.."
if not exist "data\push" mkdir "data\push"
set "LOG=data\push\run.log"
echo [%date% %time%] ==== start ==== >> "%LOG%"

curl -s --max-time 3 http://127.0.0.1:9222/json/version >nul 2>&1
if errorlevel 1 goto SSR

echo [%date% %time%] CDP OK >> "%LOG%"
node src\cli.js --cdp http://127.0.0.1:9222 --push --max-scroll 8 --sessions 1 >> "%LOG%" 2>&1
if errorlevel 1 echo [%date% %time%] node exit=%errorlevel% >> "%LOG%"
goto NOTIFY

:SSR
echo [%date% %time%] CDP unavailable, SSR only >> "%LOG%"
node src\cli.js --push --max-scroll 8 --sessions 1 >> "%LOG%" 2>&1
if errorlevel 1 echo [%date% %time%] node exit=%errorlevel% >> "%LOG%"

:NOTIFY
rem Desktop toast only when this round has real changes (skip noisy no-op rounds)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0toast.ps1" >> "%LOG%" 2>&1

echo [%date% %time%] ==== done ==== >> "%LOG%"
endlocal
