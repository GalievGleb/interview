"""Natural interview-question speech via a direct OpenAI key or SkillCue gateway."""

from __future__ import annotations

import asyncio
import json
import re

import httpx

from app.config import get_settings
from app.core.errors import AppError
from app.services import provider_adapter, secrets
from app.services.provider_adapter import _gateway_license_key, _gateway_root_url

TTS_MODEL = "gpt-4o-mini-tts"
TTS_VOICE = "marin"
MAX_TTS_CHARS = 800
RUSSIAN_SPEECH_INSTRUCTIONS = (
    "Говори естественно, спокойно и доброжелательно, как живой интервьюер. Без дикторской манеры."
)
ENGLISH_SPEECH_INSTRUCTIONS = (
    "Speak naturally, calmly, and warmly like a real interviewer, without an announcer voice."
)


def normalize_tts_input(raw: str) -> str:
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text or len(text) > MAX_TTS_CHARS:
        raise AppError(
            f"Текст озвучки должен содержать от 1 до {MAX_TTS_CHARS} символов.",
            422,
            "invalid_tts_input",
        )
    return text


def _direct_body(input_text: str, language: str) -> dict[str, str]:
    return {
        "model": TTS_MODEL,
        "voice": TTS_VOICE,
        "input": normalize_tts_input(input_text),
        "response_format": "wav",
        "instructions": (
            RUSSIAN_SPEECH_INSTRUCTIONS if language == "ru" else ENGLISH_SPEECH_INSTRUCTIONS
        ),
    }


def parse_tts_error(status: int, body: str) -> AppError:
    try:
        error = (json.loads(body) or {}).get("error") or {}
    except (json.JSONDecodeError, AttributeError, TypeError):
        error = {}
    code = error.get("code")
    message = error.get("message")
    passthrough_codes = {
        "gateway_unconfigured",
        "invalid_license",
        "rate_limited",
        "tts_provider_error",
        "tts_provider_unavailable",
    }
    if code in passthrough_codes and isinstance(message, str) and message.strip():
        return AppError(message.strip(), status, code)
    if status == 401:
        return AppError(
            "Не удалось авторизовать озвучку. Проверьте AI-ключ или лицензию.",
            401,
            "tts_unauthorized",
        )
    if status == 429:
        return AppError(
            "Слишком много запросов озвучки — подождите минуту.",
            429,
            "rate_limited",
        )
    return AppError(
        "Озвучка временно недоступна. Используется системный голос.",
        status if 400 <= status < 600 else 502,
        "tts_unavailable",
    )


async def synthesize_speech(input_text: str, language: str) -> bytes:
    normalized = normalize_tts_input(input_text)
    normalized_language = "en" if language == "en" else "ru"
    settings = get_settings()
    own_key = secrets.get_secret("openai_api_key")

    if own_key:
        url = "https://api.openai.com/v1/audio/speech"
        authorization = own_key
        body = _direct_body(normalized, normalized_language)
    else:
        license_key = await asyncio.to_thread(_gateway_license_key)
        if not settings.skillcue_gateway_url or not license_key:
            raise AppError(
                "Озвучка недоступна без подключения к AI.",
                503,
                "tts_unavailable",
            )
        url = f"{_gateway_root_url(settings.skillcue_gateway_url)}/gateway/tts/speech"
        authorization = license_key
        body = {"input": normalized, "language": normalized_language}

    try:
        response = await provider_adapter.get_client().post(
            url,
            headers={"Authorization": f"Bearer {authorization}"},
            json=body,
            timeout=httpx.Timeout(30.0, connect=8.0),
        )
    except httpx.HTTPError as exc:
        raise AppError(
            "Не удалось подключиться к озвучке. Используется системный голос.",
            502,
            "tts_unavailable",
        ) from exc
    if response.status_code >= 400:
        raise parse_tts_error(response.status_code, response.text)
    return response.content
