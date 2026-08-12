@echo off
REM Build the private SkillCue Dev installer by double-clicking.
cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File "%~dp0dev-build.ps1" %*
echo.
pause
