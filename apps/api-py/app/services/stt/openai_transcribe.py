"""OpenAI GPT-4o mini Transcribe, with direct-key and managed-gateway paths."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import TypedDict

import httpx

from app.config import get_settings
from app.services import secrets
from app.services.provider_adapter import _gateway_license_key, _gateway_root_url

from .base import PRIVACY_CLOUD, BaseTranscriptionProvider, ProviderMode
from .pcm_audio import pcm16_mono_wav

MINI_MODEL = "gpt-4o-mini-transcribe"
ANSWER_MODEL = "gpt-transcribe"
STT_RETRY_DELAYS_S = (0.2, 0.6)
STT_RETRY_STATUS_CODES = {429, 500, 502, 503, 504}
STT_TEMPORARY_ERROR = "Сервис распознавания временно недоступен. Повторите фразу."
GATEWAY_MIN_REQUEST_INTERVAL_S = 6.2

# Mic and system audio use separate WebSockets/providers, while the managed
# gateway receives ordinary HTTP uploads and currently protects a licence at
# ten starts per minute. Pace only the managed path across the whole backend so
# two live sources cannot burst into 429s. Direct user OpenAI keys stay
# unaffected.
_gateway_request_lock = asyncio.Lock()
_gateway_next_request_at = 0.0


async def _post_stt_with_retry(
    request: Callable[[], Awaitable[httpx.Response]],
) -> httpx.Response:
    """Retry a short transient STT outage without killing the live microphone."""
    for attempt in range(len(STT_RETRY_DELAYS_S) + 1):
        try:
            response = await request()
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            if attempt >= len(STT_RETRY_DELAYS_S):
                raise RuntimeError(STT_TEMPORARY_ERROR) from exc
        else:
            if response.status_code not in STT_RETRY_STATUS_CODES or attempt >= len(
                STT_RETRY_DELAYS_S
            ):
                return response
        await asyncio.sleep(STT_RETRY_DELAYS_S[attempt])
    raise RuntimeError(STT_TEMPORARY_ERROR)


async def _post_gateway_stt(
    request: Callable[[], Awaitable[httpx.Response]],
) -> httpx.Response:
    global _gateway_next_request_at
    async with _gateway_request_lock:
        delay = _gateway_next_request_at - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        response = await _post_stt_with_retry(request)
        _gateway_next_request_at = time.monotonic() + GATEWAY_MIN_REQUEST_INTERVAL_S
        return response


class AnswerRequestData(TypedDict):
    model: str
    response_format: str
    prompt: str
    keywords: list[str]
    languages: list[str]


def build_answer_request_data(
    *,
    question: str,
    hints: list[str],
    language: str,
) -> AnswerRequestData:
    normalized_language = language.lower()
    languages = ["en"] if normalized_language.startswith("en") else ["ru", "en"]
    return {
        "model": ANSWER_MODEL,
        "response_format": "json",
        "prompt": f"Техническое интервью. Вопрос интервьюера: {question}",
        "keywords": hints,
        "languages": languages,
    }


def build_request_data(*, language: str | None) -> dict[str, str]:
    data = {
        "model": MINI_MODEL,
        "response_format": "json",
    }
    if language and language.lower() not in {"auto", "multi"}:
        data["language"] = "ru" if language.lower().startswith("ru") else "en"
    return data


class OpenAiMiniTranscribeProvider(BaseTranscriptionProvider):
    id = "openai-gpt-4o-mini-transcribe"
    display_name = "OpenAI GPT-4o mini Transcribe"
    mode = ProviderMode.CLOUD
    estimated_latency_ms = 1800
    benchmark_mode = "file-upload"

    def __init__(self) -> None:
        super().__init__()
        self._client: httpx.AsyncClient | None = None
        self._prepare_task: asyncio.Task[None] | None = None
        self._model_warm_task: asyncio.Task[None] | None = None

    def is_available(self) -> bool:
        settings = get_settings()
        return bool(secrets.get_secret("openai_api_key") or settings.skillcue_gateway_url)

    def _availability_reason(self) -> str:
        return "ready" if self.is_available() else "SkillCue cloud is unavailable"

    def get_privacy_description(self) -> str:
        return f"{PRIVACY_CLOUD} Аудио обрабатывается OpenAI."

    def _active_model(self) -> str:
        return MINI_MODEL

    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=45.0,
                limits=httpx.Limits(max_keepalive_connections=4, max_connections=8),
            )
        return self._client

    async def prepare_async(self) -> None:
        """Claim the managed trial and warm the public TLS connection once."""
        if self._prepared:
            return
        if self._prepare_task is None or self._prepare_task.done():
            self._prepare_task = asyncio.create_task(self._prepare_impl())
        await self._prepare_task

    async def _prepare_impl(self) -> None:
        if secrets.get_secret("openai_api_key"):
            self._prepared = True
            return
        settings = get_settings()
        if not settings.skillcue_gateway_url:
            raise RuntimeError("SkillCue cloud is not configured")
        license_key = await _gateway_license_key()
        if not license_key:
            raise RuntimeError("SkillCue license is unavailable")
        root = _gateway_root_url(settings.skillcue_gateway_url)
        response = await self._http_client().get(f"{root}/health", timeout=8.0)
        response.raise_for_status()
        self._prepared = True

    async def prewarm_model_async(self) -> None:
        """Warm the upstream model without blocking live-session readiness."""
        await self.prepare_async()
        if secrets.get_secret("openai_api_key"):
            return
        if self._model_warm_task is None or self._model_warm_task.done():
            self._model_warm_task = asyncio.create_task(self._prewarm_model_impl())
        await self._model_warm_task

    async def _prewarm_model_impl(self) -> None:
        silence = pcm16_mono_wav(b"\0\0" * 4000, sample_rate=16000)
        await self._transcribe_via_gateway(silence, language="ru")

    async def aclose(self) -> None:
        if self._model_warm_task is not None and not self._model_warm_task.done():
            self._model_warm_task.cancel()
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._prepared = False

    async def _transcribe_file(
        self,
        audio: bytes,
        *,
        language: str | None,
        sample_rate: int,
    ) -> str:
        del sample_rate
        key = secrets.get_secret("openai_api_key")
        if key:
            return await self._transcribe_direct(audio, language=language, key=key)
        return await self._transcribe_via_gateway(audio, language=language)

    async def _transcribe_direct(
        self,
        audio: bytes,
        *,
        language: str | None,
        key: str,
    ) -> str:
        response = await _post_stt_with_retry(
            lambda: self._http_client().post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {key}"},
                data=build_request_data(language=language),
                files={"file": ("utterance.wav", audio, "audio/wav")},
            )
        )
        return self._response_text(response)

    async def _transcribe_via_gateway(
        self,
        audio: bytes,
        *,
        language: str | None,
    ) -> str:
        settings = get_settings()
        if not settings.skillcue_gateway_url:
            raise RuntimeError("SkillCue cloud is not configured")
        license_key = await _gateway_license_key()
        if not license_key:
            raise RuntimeError("SkillCue license is unavailable")
        root = _gateway_root_url(settings.skillcue_gateway_url)
        params = {}
        if language:
            params["language"] = language
        response = await _post_gateway_stt(
            lambda: self._http_client().post(
                f"{root}/gateway/stt/transcribe",
                headers={
                    "Authorization": f"Bearer {license_key}",
                    "Content-Type": "audio/wav",
                },
                params=params,
                content=audio,
            )
        )
        return self._response_text(response)

    @staticmethod
    def _response_text(response: httpx.Response) -> str:
        if not 200 <= response.status_code < 300:
            if response.status_code in STT_RETRY_STATUS_CODES:
                raise RuntimeError(STT_TEMPORARY_ERROR)
            raise RuntimeError(f"OpenAI Mini STT {response.status_code}: {response.text[:240]}")
        return str(response.json().get("text") or "").strip()


class OpenAiAnswerTranscriber:
    """One completed mock answer, kept separate from the latency-first live path."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=60.0,
                limits=httpx.Limits(max_keepalive_connections=2, max_connections=4),
            )
        return self._client

    async def transcribe(
        self,
        audio: bytes,
        *,
        question: str,
        hints: list[str],
        language: str,
    ) -> str:
        request_data = build_answer_request_data(
            question=question,
            hints=hints,
            language=language,
        )
        key = secrets.get_secret("openai_api_key")
        if key:
            return await self._transcribe_direct(audio, request_data=request_data, key=key)
        return await self._transcribe_via_gateway(audio, request_data=request_data)

    async def _transcribe_direct(
        self,
        audio: bytes,
        *,
        request_data: AnswerRequestData,
        key: str,
    ) -> str:
        data = {
            "model": str(request_data["model"]),
            "response_format": str(request_data["response_format"]),
            "prompt": str(request_data["prompt"]),
            "keywords[]": list(request_data["keywords"]),
            "languages[]": list(request_data["languages"]),
        }
        response = await _post_stt_with_retry(
            lambda: self._http_client().post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {key}"},
                data=data,
                files={"file": ("answer.wav", audio, "audio/wav")},
            )
        )
        return self._response_text(response)

    async def _transcribe_via_gateway(
        self,
        audio: bytes,
        *,
        request_data: AnswerRequestData,
    ) -> str:
        settings = get_settings()
        if not settings.skillcue_gateway_url:
            raise RuntimeError("SkillCue cloud is not configured")
        license_key = await _gateway_license_key()
        if not license_key:
            raise RuntimeError("SkillCue license is unavailable")
        root = _gateway_root_url(settings.skillcue_gateway_url)
        response = await _post_stt_with_retry(
            lambda: self._http_client().post(
                f"{root}/gateway/stt/answer",
                headers={"Authorization": f"Bearer {license_key}"},
                data={
                    "prompt": str(request_data["prompt"]),
                    "keywords": json.dumps(request_data["keywords"], ensure_ascii=False),
                    "languages": json.dumps(request_data["languages"], ensure_ascii=False),
                },
                files={"file": ("answer.wav", audio, "audio/wav")},
            )
        )
        return self._response_text(response)

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @staticmethod
    def _response_text(response: httpx.Response) -> str:
        if not 200 <= response.status_code < 300:
            if response.status_code in STT_RETRY_STATUS_CODES:
                raise RuntimeError(STT_TEMPORARY_ERROR)
            raise RuntimeError(f"OpenAI answer STT {response.status_code}: {response.text[:240]}")
        return str(response.json().get("text") or "").strip()


_answer_transcriber: OpenAiAnswerTranscriber | None = None


def get_answer_transcriber() -> OpenAiAnswerTranscriber:
    global _answer_transcriber
    if _answer_transcriber is None:
        _answer_transcriber = OpenAiAnswerTranscriber()
    return _answer_transcriber


__all__ = [
    "ANSWER_MODEL",
    "MINI_MODEL",
    "OpenAiAnswerTranscriber",
    "OpenAiMiniTranscribeProvider",
    "build_answer_request_data",
    "build_request_data",
    "get_answer_transcriber",
]
