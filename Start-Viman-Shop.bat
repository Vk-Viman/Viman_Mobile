@echo off
setlocal
cd /d "%~dp0"
title Viman Mobile Shop

rem --- 1. Node.js check
where node >nul 2>nul
if errorlevel 1 goto :nonode
node "scripts\check-node.mjs"
if errorlevel 1 goto :nonode
goto :nodeok

:nonode
echo.
echo Node.js 24 or newer is required but was not found.
echo Please download and install the LTS version from https://nodejs.org
echo and then double-click this file again.
echo.
pause
exit /b 1

:nodeok
rem --- 2. Already running?
node "scripts\open-when-ready.mjs" --check
if errorlevel 1 goto :notrunning
echo Viman Mobile Shop is already running. Opening the browser...
start "" "http://localhost:4300"
exit /b 0

:notrunning
rem --- 3. Install dependencies on first run
if exist "node_modules\" goto :hasmodules
echo Installing required files (internet needed, first run only)...
call npm ci
if errorlevel 1 (
  echo.
  echo Installation failed. Please check the internet connection and try again.
  echo.
  pause
  exit /b 1
)
:hasmodules

rem --- 4. Build the web app if missing or out of date
node "scripts\needs-build.mjs"
if not errorlevel 1 goto :hasbuild
echo Building the shop screens, please wait...
call npm run build
if errorlevel 1 (
  echo.
  echo The build failed. Please read the error above.
  echo.
  pause
  exit /b 1
)
:hasbuild

rem --- 5. Open the browser once the server is ready
start "" /b node "scripts\open-when-ready.mjs"

rem --- 6. Run the server in this window
echo.
echo ================================================================
echo   Viman Mobile Shop is starting...
echo   Keep this window open. Press Ctrl+C to stop.
echo ================================================================
echo.
node "server\src\index.ts"
set "EXITCODE=%errorlevel%"

rem --- 7. Show errors
if not "%EXITCODE%"=="0" (
  echo.
  echo The server stopped with an error ^(code %EXITCODE%^). Please read the messages above.
  echo.
  pause
)
exit /b %EXITCODE%
