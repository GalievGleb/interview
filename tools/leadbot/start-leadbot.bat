@echo off
rem SkillCue lead bot launcher. Keep this window open while the bot runs.
rem Autostart: Win+R -> shell:startup -> put a shortcut to this file there.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
chcp 65001 >nul
:loop
py -3.12 -u leadbot.py
echo.
echo Bot stopped. Restarting in 10 seconds... (Ctrl+C to exit)
timeout /t 10 /nobreak >nul
goto loop
