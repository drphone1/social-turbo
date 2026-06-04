@echo off
echo ========================================
echo   Social Turbo - Server
echo ========================================
echo.

cd /d "%~dp0"

echo Starting Social Turbo server...
echo Server: http://localhost:3000
echo.
echo Press Ctrl+C to stop.
echo.

call npm run dev

pause
