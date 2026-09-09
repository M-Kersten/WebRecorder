@echo off
REM Double-click this file to open the Walkthrough Recorder.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this machine.
  echo   Install it from https://nodejs.org ^(take the LTS version^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run: installing what the recorder needs. This takes a minute.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   That did not work. Send this window to whoever set the tool up.
    pause
    exit /b 1
  )
)

echo   Checking everything is in place...
call node src/index.js setup
if errorlevel 1 (
  pause
  exit /b 1
)

node src/index.js ui
