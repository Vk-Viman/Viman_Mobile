@echo off
rem Start-Viman-Shop.bat - the owner double-clicks this file to start the Viman Mobile shop system.
rem
rem What it does, in order: checks Node.js, avoids starting a second copy, installs files on first run, rebuilds the
rem screens only when needed, opens the browser once the server answers, then runs the server in this window.
rem Closing this window (or Ctrl+C) stops the shop system. Keep it ASCII with Windows (CRLF) line endings.
rem
rem @echo off hides the command text so the owner only sees the friendly messages below.
rem setlocal keeps the variables set here (such as EXITCODE) from leaking into the owner's command window.
setlocal
rem Work from the folder this file is in, so it still works when double-clicked from anywhere (/d also switches drive).
cd /d "%~dp0"
title Viman Mobile Shop

rem The server needs a recent Node.js. "where node" finds out whether it is installed at all;
rem check-node.mjs then checks that the version is new enough (24 or newer).
rem --- 1. Node.js check
where node >nul 2>nul
if errorlevel 1 goto :nonode
node "scripts\check-node.mjs"
if errorlevel 1 goto :nonode
goto :nodeok

rem Reached when Node.js is missing or too old: explain what to install, wait for a key press so the window does not
rem vanish before it can be read, then stop with an error code.
:nonode
echo.
echo Node.js 24 or newer is required but was not found.
echo Please download and install the LTS version from https://nodejs.org
echo and then double-click this file again.
echo.
pause
exit /b 1

:nodeok
rem Ask the running server (if any) for its health. If it answers, just open the browser instead of starting a second
rem server that would fight over the same port and database.
rem --- 2. Already running?
node "scripts\open-when-ready.mjs" --check
if errorlevel 1 goto :notrunning
echo Viman Mobile Shop is already running. Opening the browser...
start "" "http://localhost:4300"
exit /b 0

:notrunning
rem No node_modules folder = first run: download the required packages (needs internet once). "npm ci" installs exactly
rem the locked versions, so the result is the same on every computer.
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

rem needs-build.mjs compares file timestamps: it exits 0 when the built screens are newer than every source file, so the
rem slow build is skipped on normal starts and only runs after the screens were changed.
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

rem "start /b" runs the helper in the background of this window. It keeps asking the server's /health address and opens the
rem browser only when the server answers (opening it earlier would show an error page).
rem --- 5. Open the browser once the server is ready
start "" /b node "scripts\open-when-ready.mjs"

rem The server runs in the foreground so its messages are visible and closing the window stops it.
rem Its exit code is saved right away, before any other command can overwrite it.
rem --- 6. Run the server in this window
echo.
echo ================================================================
echo   Viman Mobile Shop is starting...
echo   Keep this window open. Press Ctrl+C to stop.
echo ================================================================
echo.
node "server\src\index.ts"
set "EXITCODE=%errorlevel%"

rem Exit code 0 means a normal stop. Anything else is a failure (for example a damaged database file): keep the window open
rem with the message above visible so the owner can read it or send a photo of it.
rem --- 7. Show errors
if not "%EXITCODE%"=="0" (
  echo.
  echo The server stopped with an error ^(code %EXITCODE%^). Please read the messages above.
  echo.
  pause
)
exit /b %EXITCODE%
