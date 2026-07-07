@echo off
REM Выпуск новой версии SkillCue двойным кликом.
REM Поднимает версию (patch), коммитит, тегает и пушит — CI соберёт и опубликует
REM установщик в ScillCue (кнопка «Скачать» получит новую версию).
cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File "%~dp0release.ps1" %*
echo.
pause
