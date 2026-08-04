@echo off
REM Release a new SkillCue version by double-clicking.
REM Bumps version (patch), commits, tags and pushes - CI builds and publishes
REM the installer to SkillCue (the Download button gets the new version).
cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
echo.
pause
