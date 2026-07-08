"""Persisted, user-editable STT settings (local Whisper only).

Env values in ``config.py`` are the *defaults*; this store holds the user's
explicit choices from the Speech-Recognition settings screen and overrides the
defaults at runtime.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel

from app.config import DATA_DIR, get_settings

from .whisper_models import WHISPER_MODELS

STT_SETTINGS_PATH = DATA_DIR / "stt_settings.json"

VALID_MODELS = {"fast", "balanced", "quality", "max"}
VALID_DEVICES = {"auto", "cpu", "gpu"}
# Live-движок: локальный Whisper (приватно, бесплатно) или облачный стриминг
# (Deepgram Nova-3 / Яндекс SpeechKit v3 — быстрее, нужен API-ключ).
VALID_ENGINES = {"whisper", "deepgram", "speechkit"}
# Модель SpeechKit: general — стабильная, general:rc — кандидат следующего
# релиза (улучшения качества русского по релиз-нотам приходят туда первыми).
VALID_SPEECHKIT_MODELS = {"general", "general:rc"}


class SttSettings(BaseModel):
    local_model: str = "balanced"
    partial_model: str = "fast"
    final_model: str = "balanced"
    device: str = "auto"
    engine: str = "whisper"
    speechkit_model: str = "general"

    def sanitized(self) -> SttSettings:
        s = get_settings()
        default_final = s.stt_local_model
        final = (
            self.final_model
            if self.final_model in VALID_MODELS
            else (self.local_model if self.local_model in VALID_MODELS else default_final)
        )
        partial = self.partial_model if self.partial_model in VALID_MODELS else "fast"
        return SttSettings(
            local_model=final,
            partial_model=partial,
            final_model=final,
            device=self.device if self.device in VALID_DEVICES else s.stt_device,
            engine=self.engine if self.engine in VALID_ENGINES else "whisper",
            speechkit_model=(
                self.speechkit_model
                if self.speechkit_model in VALID_SPEECHKIT_MODELS
                else "general"
            ),
        )


# Порядок предпочтения при выборе забандленной модели по умолчанию: если в
# установщик положили несколько, берём лучшую по качеству.
_QUALITY_PREFERENCE = ("max", "quality", "balanced", "fast")


def _bundled_qualities() -> list[str]:
    """Качества, чья модель ФИЗИЧЕСКИ лежит в SKILLCUE_MODELS_DIR (офлайн-кэш,
    вшитый в установщик; см. predownload_models.py и skillcue-backend.spec).

    Пусто в dev-режиме и когда ничего не забандлено — тогда дефолты берутся из
    env как раньше. Смысл: первый запуск упакованного приложения должен работать
    БЕЗ докачки модели с HuggingFace, поэтому дефолтное качество приравниваем к
    той модели, что уже есть на диске.
    """
    root = os.environ.get("SKILLCUE_MODELS_DIR")
    if not root:
        return []
    base = Path(root)
    if not base.is_dir():
        return []
    found: list[str] = []
    for spec in WHISPER_MODELS:
        cache = base / ("models--" + spec.download_repo.replace("/", "--"))
        # Настоящий снапшот с model.bin, а не пустая папка/.gitkeep.
        if cache.is_dir() and any(cache.glob("snapshots/*/model.bin")):
            found.append(spec.quality.value)
    return found


def _defaults() -> SttSettings:
    s = get_settings()
    final = s.stt_local_model
    partial = "fast"
    bundled = _bundled_qualities()
    if bundled:
        best = next((q for q in _QUALITY_PREFERENCE if q in bundled), None)
        if best:
            final = best
            # partial обычно самый лёгкий (fast=tiny). Оставляем "fast", только
            # если tiny реально забандлен; иначе тоже офлайн-модель, что есть.
            partial = "fast" if "fast" in bundled else best
    return SttSettings(
        local_model=final,
        partial_model=partial,
        final_model=final,
        device=s.stt_device,
    )


def load_stt_settings() -> SttSettings:
    if not STT_SETTINGS_PATH.exists():
        return _defaults()
    try:
        raw = json.loads(STT_SETTINGS_PATH.read_text(encoding="utf-8"))
        if "final_model" not in raw and "local_model" in raw:
            raw["final_model"] = raw["local_model"]
        if "partial_model" not in raw:
            raw["partial_model"] = "fast"
        return SttSettings.model_validate(raw).sanitized()
    except Exception:  # noqa: BLE001 - corrupt file -> safe defaults
        return _defaults()


def save_stt_settings(settings: SttSettings) -> SttSettings:
    clean = settings.sanitized()
    STT_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    STT_SETTINGS_PATH.write_text(clean.model_dump_json(indent=2), encoding="utf-8")
    return clean


def update_stt_settings(**fields) -> SttSettings:
    current = load_stt_settings()
    data = current.model_dump()
    for key, value in fields.items():
        if value is not None and key in data:
            data[key] = value
    if "final_model" in fields and fields["final_model"] is not None:
        data["local_model"] = fields["final_model"]
    if "local_model" in fields and fields["local_model"] is not None:
        data["final_model"] = fields["local_model"]
    return save_stt_settings(SttSettings.model_validate(data))
