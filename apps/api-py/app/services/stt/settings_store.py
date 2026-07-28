"""Fixed STT configuration.

SkillCue deliberately exposes one speech-recognition path:
OpenAI ``gpt-4o-mini-transcribe``. Legacy persisted settings are accepted by
Pydantic and discarded so an upgrade cannot restore Whisper or another engine.
"""

from __future__ import annotations

from pydantic import BaseModel

STT_ENGINE = "openai-mini"
STT_MODEL = "gpt-4o-mini-transcribe"
VALID_ENGINES = {STT_ENGINE}


class SttSettings(BaseModel):
    engine: str = STT_ENGINE
    model: str = STT_MODEL

    def sanitized(self) -> SttSettings:
        return SttSettings(engine=STT_ENGINE, model=STT_MODEL)


def load_stt_settings() -> SttSettings:
    return SttSettings()


def save_stt_settings(settings: SttSettings) -> SttSettings:
    return settings.sanitized()


def update_stt_settings(**_fields: object) -> SttSettings:
    return SttSettings()


__all__ = [
    "STT_ENGINE",
    "STT_MODEL",
    "VALID_ENGINES",
    "SttSettings",
    "load_stt_settings",
    "save_stt_settings",
    "update_stt_settings",
]
