@echo off
rem ------------------------------------------------------------
rem Start script for the Job application stack (backend + frontend)
rem ------------------------------------------------------------

:: Add the project's "node" folder to the PATH (required for npm and node)
set "PROJECT_ROOT=%~dp0"
set "NODE_BIN=%PROJECT_ROOT%node"
set "PATH=%NODE_BIN%;%PATH%"

rem ------------ Start Backend ---------------------------------
echo Killing old node processes...
taskkill /F /IM node.exe > nul 2>&1
echo Starting backend server ...
start "Backend" cmd /c "node %PROJECT_ROOT%backend\server.js"

rem ------------ Wait a moment for backend to bind --------------
timeout /t 2 > nul

rem ------------ Start Frontend --------------------------------
echo Starting frontend dev server ...
cd /d "%PROJECT_ROOT%frontend"
start "Frontend" cmd /c "npm run dev"

echo All services launched. Use the URLs shown in the consoles.
pause
