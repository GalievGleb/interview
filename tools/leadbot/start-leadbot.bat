@echo off
chcp 65001 >nul
rem Запуск SkillCue lead bot. Окно должно оставаться открытым, пока бот работает.
rem Для автозапуска при включении ПК: Win+R -> shell:startup -> положить ярлык на этот файл.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
:loop
py -3.12 -u leadbot.py
echo.
echo Бот остановился. Перезапуск через 10 секунд... (Ctrl+C — выйти)
timeout /t 10 >nul
goto loop
