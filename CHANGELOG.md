# Changelog

Все заметные изменения SkillCue. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии по [SemVer](https://semver.org/lang/ru/) (правила — `docs/VERSIONING.md`).

## [Unreleased]

## [0.1.2] — 2026-07-06

### Added
- Managed SkillCue Cloud trial: fresh installs can use the gateway without asking
  the user for an OpenRouter API key.
- Gateway endpoint `/gateway/trial` issues a limited signed trial license and
  keeps the normal Redis token quota path.
- Серверный гейтвей лицензий (`apps/api`): OpenAI-совместимый прокси `/v1/*`,
  офлайн-проверка Ed25519-ключей, учёт токенов по тарифам в Redis, выпуск ключей
  `/gateway/issue`, публичный `/health` для мониторинга.
- Облачные STT-движки: Deepgram Nova-3 (стриминг) и Яндекс SpeechKit v3 (gRPC) —
  выбираются в настройках, сравниваются в STT-бенчмарке.
- Деплой на VPS: `deploy.py` + `setup-vps.sh` (гейтвей+Redis+лидбот, swap, не
  трогает чужой :80), `setup-web.sh` (домен + TLS), `status.sh`, `README.md`.
- Лидбот SkillCue переехал на сервер (24/7, systemd, самовосстановление).
- План версий (`docs/VERSIONING.md`) и этот changelog.

### Changed
- Desktop release scripts now build the frozen Python backend by default before
  packaging the installer.
- Startup UX no longer exposes backend warmup as a user-facing warning.
- Релизы десктопа публикуются в публичный репозиторий `GalievGleb/ScillCue`
  (код остаётся в приватном `interview`); ссылки «Скачать» и автообновление
  выровнены на него.
- Лендинг: canonical/OG на `skill-cue.ru`, готовый к заполнению сниппет Метрики.

### Fixed
- Freshly downloaded installer no longer ships without `skillcue-backend.exe`
  when built through the normal `dist`/`dist:desktop` command.
- Removed the native Electron menu bar from packaged desktop windows.
- Sidebar and live preflight no longer show dev-oriented backend/API-key noise
  during normal startup.

### Security
- Redis AOF включён — учёт токенов переживает сбой (потеря ≤1 сек).
- fail2ban для sshd на сервере (блок брутфорса).

## [0.1.1] — 2026-07

### Added
- MVP launch prep: язык ответов, демо-режим, лендинг, лицензии/trial.
- Vacancy Review «сеньор-интервьюер»: рубрика проектных вопросов,
  anti-hallucination guard, LLM-отчёт готовности, интерактивные дожимы.
- Персональный профиль кандидата вместо хардкода в live-промпте.

### Fixed
- Русификация UI, светлая тема, консистентность экранов.
- Overlay layout/crispness, honest fallback labels.

> До `0.1.1` история — в git-логе; changelog начат при подготовке к первому релизу.
