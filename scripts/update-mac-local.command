#!/bin/zsh

script_dir=$(dirname "$(realpath "$0")")
cd "$script_dir/.." || exit 1

if pnpm update:mac:local; then
  print '\nSkillCue обновлён и открыт.'
  result=0
else
  result=$?
  print '\nОбновление не удалось. Оставьте это окно открытым, чтобы видеть ошибку.'
fi

read -r '?Нажмите Enter, чтобы закрыть окно…'
exit "$result"
