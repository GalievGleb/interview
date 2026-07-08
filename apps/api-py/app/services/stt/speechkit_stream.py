"""Яндекс SpeechKit API v3 (gRPC RecognizeStreaming) поверх /stt/stream.

Лучшее облачное распознавание русского: серверный endpointing (eou_update),
partial-результаты и нормализация текста. Протокол клиента тот же, что у
whisper_stream/deepgram_stream — десктоп не отличает движки.

Особенности:
* Лимиты gRPC-сессии — 5 минут аудио И 10 МБ данных; мост следит за обоими
  бюджетами и переподключается заранее (при 48 кГц байты кончаются за ~100 с).
  Обрыв сессии не фатален: до 3 ретраев с бэкоффом, live на 40+ минут
  работает бесшовно.
* Зависимости (grpcio + yandexcloud) тяжёлые, поэтому вынесены в
  requirements-stt-cloud.txt и импортируются лениво с понятной ошибкой.
* Порядок событий v3 на фразу: partial* -> final -> final_refinement -> eou_update.
  Финал клиенту шлём на eou_update, текст берём из refinement (нормализованный).
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.config import get_settings
from app.services import secrets

from .base import (
    PRIVACY_CLOUD,
    BaseTranscriptionProvider,
    ProviderMode,
)
from .whisper_stream import RECEIVE_POLL_S, quality_gate

logger = logging.getLogger("stt.speechkit")

SPEECHKIT_ENDPOINT = "stt.api.cloud.yandex.net:443"
# Лимиты сессии SpeechKit v3: 5 минут аудио И 10 МБ данных. При 16 кГц первым
# истекает время, при 48 кГц (A/B-режим) — байты (~104 с). Ротация обязана
# учитывать оба бюджета, иначе сервер рвёт сессию сам.
SESSION_RECONNECT_S = 240
SESSION_SOFT_BYTES = 8_000_000  # мягкая ротация в паузе между фразами
SESSION_HARD_BYTES = 9_500_000  # аварийная ротация даже посреди фразы
# Сетевой глитч не должен убивать STT до конца интервью — пробуем переподняться.
MAX_SESSION_FAILURES = 3
DEPS_HINT = "Для Яндекс SpeechKit установите зависимости: pip install -r requirements-stt-cloud.txt"
# EOU-детектор HIGH — конец фразы фиксируется раньше (дока: «минимальная
# задержка» финалов), суфлёр получает вопрос быстрее. Цена — риск ложных
# разрывов на медленной речи; подсказка о паузах его гасит: кандидат на
# интервью думает вслух, пауза между словами до ~0.8 с — ещё не конец фразы.
EOU_MAX_PAUSE_HINT_MS = 800


def soft_rotation_due(elapsed_s: float, bytes_sent: int, speech_active: bool) -> bool:
    """Пора мягко ротировать сессию (только в паузе между фразами)."""
    if speech_active:
        return False
    return elapsed_s > SESSION_RECONNECT_S or bytes_sent >= SESSION_SOFT_BYTES


def hard_rotation_due(bytes_sent: int) -> bool:
    """Байтовый бюджет почти исчерпан — ротируем немедленно, иначе сервер
    оборвёт сессию сам и финал фразы пропадёт целиком."""
    return bytes_sent >= SESSION_HARD_BYTES


def api_key() -> str:
    return secrets.get_secret("yandex_api_key")


def _language_codes(language: str) -> list[str]:
    """Наш код языка → whitelist SpeechKit v3.

    Для авто/multi отдаём обе поддерживаемые локали: SpeechKit сам выбирает
    язык из WHITELIST. Литерала "auto" в API v3 нет — раньше сюда уходил
    ["auto"], и авто-режим («Авто (ru+en)») по сути был сломан.
    """
    lang = (language or "").lower()
    if lang.startswith("ru"):
        return ["ru-RU"]
    if lang.startswith("en"):
        return ["en-US"]
    return ["ru-RU", "en-US"]


def _import_grpc():
    """Ленивая загрузка тяжёлых зависимостей с человеческой ошибкой."""
    import grpc  # noqa: PLC0415
    from yandex.cloud.ai.stt.v3 import stt_pb2, stt_service_pb2_grpc  # noqa: PLC0415

    return grpc, stt_pb2, stt_service_pb2_grpc


def build_session_options(stt_pb2, *, language: str, sample_rate: int, model: str = "general"):
    lang_codes = _language_codes(language)
    restriction = stt_pb2.LanguageRestrictionOptions(
        restriction_type=stt_pb2.LanguageRestrictionOptions.WHITELIST,
        language_code=lang_codes,
    )
    return stt_pb2.StreamingOptions(
        recognition_model=stt_pb2.RecognitionModelOptions(
            model=model,
            audio_format=stt_pb2.AudioFormatOptions(
                raw_audio=stt_pb2.RawAudio(
                    audio_encoding=stt_pb2.RawAudio.LINEAR16_PCM,
                    sample_rate_hertz=sample_rate,
                    audio_channel_count=1,
                )
            ),
            text_normalization=stt_pb2.TextNormalizationOptions(
                text_normalization=stt_pb2.TextNormalizationOptions.TEXT_NORMALIZATION_ENABLED,
                profanity_filter=False,
                literature_text=True,
            ),
            language_restriction=restriction,
            audio_processing_type=stt_pb2.RecognitionModelOptions.REAL_TIME,
        ),
        eou_classifier=stt_pb2.EouClassifierOptions(
            default_classifier=stt_pb2.DefaultEouClassifier(
                type=stt_pb2.DefaultEouClassifier.HIGH,
                max_pause_between_words_hint_ms=EOU_MAX_PAUSE_HINT_MS,
            )
        ),
    )


def alternatives_text(event) -> str:
    """Первый вариант распознавания из события (partial/final/refinement)."""
    alts = getattr(event, "alternatives", None) or []
    if not alts:
        return ""
    return (alts[0].text or "").strip()


def gateway_stt_ws_url(
    gateway_root: str, license_key: str, *, language: str, sample_rate: int
) -> str:
    """HTTP(S)-корень шлюза (см. provider_adapter._gateway_root_url) → WS(S)-URL
    /gateway/stt/stream. Выделено в чистую функцию ради юнит-тестов без сети."""
    if gateway_root.startswith("https://"):
        ws_root = "wss://" + gateway_root[len("https://") :]
    elif gateway_root.startswith("http://"):
        ws_root = "ws://" + gateway_root[len("http://") :]
    else:
        ws_root = gateway_root
    return f"{ws_root}/gateway/stt/stream?key={license_key}&language={language}&sample_rate={sample_rate}"


async def _run_gateway_relay(
    client_ws,
    *,
    language: str,
    sample_rate: int,
) -> None:
    """Без своего ключа Яндекса, но с настроенным облачным шлюзом SkillCue —
    аудио уходит через СЕРВЕР SkillCue вместо прямого gRPC в Yandex. Ключ
    Яндекса живёт только на сервере (см. apps/api/src/gateway/gateway-stt.gateway.ts);
    десктоп получает бесплатный триал/лицензию автоматически, тем же способом,
    каким provider_adapter уже делает это для LLM (_gateway_license_key) — без
    единого действия пользователя.

    Протокол шлюза побайтово совпадает с локальным /stt/stream (см. модуль),
    поэтому это почти прозрачный релей: бинарные чанки — туда, JSON-строки —
    обратно, без трансляции событий.
    """
    from app.services.provider_adapter import _gateway_license_key, _gateway_root_url

    gateway_url = get_settings().skillcue_gateway_url
    if not gateway_url:
        await client_ws.send_json(
            {
                "type": "error",
                "message": (
                    "Не задан API-ключ Яндекс SpeechKit. Откройте Настройки → "
                    "Распознавание речи и вставьте ключ сервисного аккаунта, "
                    "либо переключитесь на локальный Whisper."
                ),
            }
        )
        return

    license_key = _gateway_license_key()
    if not license_key:
        await client_ws.send_json(
            {
                "type": "error",
                "message": (
                    "Не удалось подключиться к облачному распознаванию SkillCue "
                    "(нет интернета или сервис недоступен). Переключитесь на "
                    "локальный Whisper или вставьте свой ключ Яндекса в Настройках."
                ),
            }
        )
        return

    try:
        import websockets
    except ImportError:
        await client_ws.send_json(
            {
                "type": "error",
                "message": "Модуль websockets не установлен (pip install websockets).",
            }
        )
        return

    root = _gateway_root_url(gateway_url)
    url = gateway_stt_ws_url(root, license_key, language=language, sample_rate=sample_rate)

    try:
        upstream = await websockets.connect(url, max_size=2**22)
    except Exception as exc:  # noqa: BLE001 — сеть/квота: пользователю нужен текст
        logger.warning("Gateway STT connect failed: %s", exc)
        await client_ws.send_json(
            {"type": "error", "message": f"Не удалось подключиться к облачному STT SkillCue: {exc}"}
        )
        return

    async def pump_audio() -> None:
        try:
            while True:
                data = await client_ws.receive_bytes()
                await upstream.send(data)
        except Exception:  # noqa: BLE001 — клиент отключился
            pass

    async def pump_events() -> None:
        async for raw in upstream:
            if isinstance(raw, bytes):
                continue
            # Уже валидный JSON протокола (шлюз шлёт тот же формат, что и
            # локальные движки) — пересылаем как есть, без разбора/пересборки.
            await client_ws.send_text(raw)

    try:
        audio_task = asyncio.create_task(pump_audio())
        events_task = asyncio.create_task(pump_events())
        done, pending = await asyncio.wait(
            {audio_task, events_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            task_exc = task.exception()
            if task_exc and not isinstance(task_exc, asyncio.CancelledError):
                raise task_exc
    except Exception as exc:  # noqa: BLE001 — дисконнект клиента заканчивает стрим
        logger.debug("Gateway STT relay ended: %s", exc)
    finally:
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001
            pass


async def run_speechkit_stream(
    client_ws,
    *,
    language: str = "ru",
    sample_rate: int = 16000,
) -> None:
    key = api_key()
    if not key:
        # Свой ключ не задан — не отказываем сразу: если настроен облачный
        # шлюз SkillCue, аудио уходит через него (ключ Яндекса пользователь
        # никогда не вводит). Иначе — прежняя явная ошибка внутри relay-функции.
        await _run_gateway_relay(client_ws, language=language, sample_rate=sample_rate)
        return

    try:
        grpc, stt_pb2, stt_service_pb2_grpc = _import_grpc()
    except ImportError:
        await client_ws.send_json({"type": "error", "message": DEPS_HINT})
        return

    from .settings_store import load_stt_settings

    model = load_stt_settings().speechkit_model
    model_label = f"speechkit-v3-{model}"
    await client_ws.send_json(
        {
            "type": "ready",
            "engine": "speechkit",
            "model": model_label,
            "partial_model": model_label,
            "final_model": model_label,
            "sample_rate": sample_rate,
        }
    )

    # Один приёмник аудио на всё соединение: переживает реконнекты gRPC-сессий.
    audio_q: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=256)

    async def receive_client_audio() -> None:
        try:
            while True:
                data = await client_ws.receive_bytes()
                try:
                    audio_q.put_nowait(data)
                except asyncio.QueueFull:
                    # Бэкенд не успевает — дропаем самый старый чанк, не новый.
                    try:
                        audio_q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                    audio_q.put_nowait(data)
        except Exception:  # noqa: BLE001 — клиент отключился
            pass
        finally:
            await audio_q.put(None)

    receiver = asyncio.create_task(receive_client_audio())

    state = {
        "last_final": "",
        "speech_started_sent": False,
        "speech_started_at": 0.0,
        "first_partial_at": 0.0,
        "partial_count": 0,
        "pending_final": "",
        "client_gone": False,
    }

    async def emit_speech_started() -> None:
        if state["speech_started_sent"]:
            return
        state["speech_started_sent"] = True
        state["speech_started_at"] = time.monotonic()
        state["first_partial_at"] = 0.0
        state["partial_count"] = 0
        await client_ws.send_json({"type": "speech_started"})

    async def emit_final() -> None:
        text = state["pending_final"]
        state["pending_final"] = ""
        state["speech_started_sent"] = False
        if not text:
            return
        now = time.monotonic()
        started = state["speech_started_at"]
        timings = {
            "speechMs": int((now - started) * 1000) if started else None,
            "firstPartialMs": (
                int((state["first_partial_at"] - started) * 1000)
                if state["first_partial_at"] and started
                else None
            ),
            "speechEndToFinalMs": None,  # серверный EOU — паузу меряет SpeechKit
            "partialCount": state["partial_count"],
        }
        ok, reason = quality_gate(text, state["last_final"])
        if not ok:
            await client_ws.send_json(
                {"type": "low_quality", "text": text, "reason": reason, "timings": timings}
            )
            return
        state["last_final"] = text
        await client_ws.send_json(
            {"type": "transcript", "text": text, "is_final": True, "speech_final": True}
        )
        await client_ws.send_json({"type": "utterance_end", "timings": timings})

    async def one_session(channel) -> str:
        """Одна gRPC-сессия до реконнект-дедлайна. Возвращает reconnect|client_gone."""
        stub = stt_service_pb2_grpc.RecognizerStub(channel)
        session_started = time.monotonic()
        session_over = asyncio.Event()

        async def requests():
            yield stt_pb2.StreamingRequest(
                session_options=build_session_options(
                    stt_pb2, language=language, sample_rate=sample_rate, model=model
                )
            )
            bytes_sent = 0
            while True:
                try:
                    data = await asyncio.wait_for(audio_q.get(), timeout=RECEIVE_POLL_S)
                except TimeoutError:
                    data = None
                    timed_out = True
                else:
                    timed_out = False
                if not timed_out and data is None:
                    state["client_gone"] = True
                    break
                if data is not None:
                    bytes_sent += len(data)
                    yield stt_pb2.StreamingRequest(chunk=stt_pb2.AudioChunk(data=data))
                # Дедлайн проверяем на КАЖДОЙ итерации, не только в таймауте:
                # при непрерывном аудио таймаут очереди может не наступать вовсе.
                elapsed = time.monotonic() - session_started
                if hard_rotation_due(bytes_sent) or soft_rotation_due(
                    elapsed, bytes_sent, state["speech_started_sent"]
                ):
                    break
            session_over.set()

        call = stub.RecognizeStreaming(requests(), metadata=(("authorization", f"Api-Key {key}"),))
        try:
            async for resp in call:
                event = resp.WhichOneof("Event")
                if event == "partial":
                    text = alternatives_text(resp.partial)
                    if not text:
                        continue
                    await emit_speech_started()
                    state["partial_count"] += 1
                    if not state["first_partial_at"]:
                        state["first_partial_at"] = time.monotonic()
                    await client_ws.send_json(
                        {
                            "type": "transcript",
                            "text": text,
                            "is_final": False,
                            "speech_final": False,
                        }
                    )
                elif event == "final":
                    text = alternatives_text(resp.final)
                    if text:
                        state["pending_final"] = text
                elif event == "final_refinement":
                    text = alternatives_text(resp.final_refinement.normalized_text)
                    if text:
                        state["pending_final"] = text
                elif event == "eou_update":
                    await emit_final()
                if session_over.is_set() and not state["speech_started_sent"]:
                    break
        finally:
            call.cancel()
        return "client_gone" if state["client_gone"] else "reconnect"

    try:
        failures = 0
        while True:
            channel = grpc.aio.secure_channel(SPEECHKIT_ENDPOINT, grpc.ssl_channel_credentials())
            try:
                outcome = await one_session(channel)
                failures = 0
            except Exception as exc:  # noqa: BLE001 — сеть/лимит: ретраим с бэкоффом
                failures += 1
                logger.warning(
                    "SpeechKit session failed (%s/%s): %s", failures, MAX_SESSION_FAILURES, exc
                )
                if state["client_gone"] or failures >= MAX_SESSION_FAILURES:
                    try:
                        await client_ws.send_json({"type": "error", "message": f"SpeechKit: {exc}"})
                    except Exception:  # noqa: BLE001
                        pass
                    break
                # Незавершённая фраза при обрыве потеряна на стороне сервера —
                # отдадим клиенту то, что успело прийти, и поднимем новую сессию.
                if state["pending_final"]:
                    await emit_final()
                state["speech_started_sent"] = False
                await asyncio.sleep(0.5 * failures)
                continue
            finally:
                await channel.close()
            if outcome == "client_gone":
                break
            logger.info("SpeechKit session rotated (time/byte budget)")
    finally:
        receiver.cancel()
        # Финал, который сервер прислал, но eou не успел дойти до клиента.
        if state["pending_final"]:
            try:
                await emit_final()
            except Exception:  # noqa: BLE001
                pass


def wav_to_lpcm(audio: bytes) -> tuple[bytes, int]:
    """WAV (PCM16 mono) → сырой LPCM + частота. Для v1 REST-распознавания.

    Бенчмарк-клипы — 16 кГц mono WAV; всё нестандартное отклоняем с понятной
    ошибкой, а не тихо кормим сервису мусор.
    """
    import io
    import wave

    with wave.open(io.BytesIO(audio), "rb") as wf:
        if wf.getnchannels() != 1:
            raise RuntimeError("SpeechKit-бенчмарк принимает только mono WAV")
        if wf.getsampwidth() != 2:
            raise RuntimeError("SpeechKit-бенчмарк принимает только PCM16 WAV")
        rate = wf.getframerate()
        if rate not in (8000, 16000, 48000):
            raise RuntimeError(f"SpeechKit поддерживает 8/16/48 кГц, а не {rate}")
        return wf.readframes(wf.getnframes()), rate


class SpeechKitProvider(BaseTranscriptionProvider):
    """Стриминг живёт в run_speechkit_stream; здесь диагностика и батч-режим
    (v1 sync REST ≤30 с / ≤1 МБ) — его использует STT-бенчмарк."""

    id = "yandex-speechkit-v3"
    display_name = "Яндекс SpeechKit v3 (облако)"
    mode = ProviderMode.CLOUD
    estimated_latency_ms = 400

    def is_available(self) -> bool:
        if not api_key():
            return False
        try:
            _import_grpc()
        except ImportError:
            return False
        return True

    def _availability_reason(self) -> str:
        if not api_key():
            return "Нужен API-ключ Яндекс Cloud (Настройки)"
        try:
            _import_grpc()
        except ImportError:
            return DEPS_HINT
        return "available"

    def get_privacy_description(self) -> str:
        return PRIVACY_CLOUD + " Аудио уходит в Яндекс Cloud (Россия)."

    def _active_model(self) -> str:
        from .settings_store import load_stt_settings

        return f"speechkit-v3-{load_stt_settings().speechkit_model}"

    async def _transcribe_file(
        self, audio: bytes, *, language: str | None, sample_rate: int
    ) -> str:
        import httpx

        key = api_key()
        if not key:
            raise RuntimeError("Не задан API-ключ Яндекс Cloud (Настройки → Распознавание речи)")
        pcm, rate = wav_to_lpcm(audio)
        if len(pcm) > 1_000_000:
            raise RuntimeError("SpeechKit sync REST принимает до 1 МБ (~30 с речи)")
        codes = _language_codes(language or "ru")
        params = {
            "lang": codes[0] if codes else "ru-RU",
            "format": "lpcm",
            "sampleRateHertz": str(rate),
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize",
                params=params,
                headers={"Authorization": f"Api-Key {key}"},
                content=pcm,
            )
        if resp.status_code != 200:
            raise RuntimeError(f"SpeechKit {resp.status_code}: {resp.text[:200]}")
        return (resp.json().get("result") or "").strip()
