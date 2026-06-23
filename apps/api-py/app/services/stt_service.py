import asyncio
import json
import logging
from collections.abc import Callable
from urllib.parse import urlencode

import websockets

from app.services.keyterms import FLUX_KEYTERMS, RU_KEYWORDS, STT_REPLACE, all_keyterms
from app.services.secrets import get_secret

logger = logging.getLogger("stt")

DEEPGRAM_V1 = "wss://api.deepgram.com/v1/listen"
DEEPGRAM_V2 = "wss://api.deepgram.com/v2/listen"

ENGINES = frozenset({"nova3-multi", "flux-multi", "nova2-ru-legacy"})

ENDPOINTING_FAST = 180
ENDPOINTING_STABLE = 250
UTTERANCE_END_FAST_MS = 1100
UTTERANCE_END_STABLE_MS = 1400


def _resolve_endpointing(mode: str) -> int:
    return ENDPOINTING_STABLE if mode == "stable" else ENDPOINTING_FAST


def _resolve_utterance_end(mode: str) -> int:
    return UTTERANCE_END_STABLE_MS if mode == "stable" else UTTERANCE_END_FAST_MS


def _resolve_deepgram_language(ui_language: str) -> str:
    if ui_language in ("ru", "multi", ""):
        return "multi"
    return ui_language or "multi"


def _append_replace(params: list[tuple[str, str]]) -> None:
    for wrong, right in STT_REPLACE:
        params.append(("replace", f"{wrong}:{right}"))


def _append_keyterms(params: list[tuple[str, str]]) -> None:
    params.extend(("keyterm", term) for term in all_keyterms())


def _build_nova3_multi(
    ui_language: str, endpointing: int, mode: str, sample_rate: int
) -> str:
    dg_language = _resolve_deepgram_language(ui_language)
    params: list[tuple[str, str]] = [
        ("encoding", "linear16"),
        ("sample_rate", str(sample_rate)),
        ("channels", "1"),
        ("model", "nova-3"),
        ("language", dg_language),
        ("interim_results", "true"),
        ("utterance_end_ms", str(_resolve_utterance_end(mode))),
        ("endpointing", str(endpointing)),
        ("smart_format", "true"),
        ("punctuate", "true"),
        ("vad_events", "true"),
    ]
    _append_keyterms(params)
    _append_replace(params)
    return f"{DEEPGRAM_V1}?{urlencode(params)}"


def _build_nova2_legacy(endpointing: int, mode: str, sample_rate: int) -> str:
    params: list[tuple[str, str]] = [
        ("encoding", "linear16"),
        ("sample_rate", str(sample_rate)),
        ("channels", "1"),
        ("model", "nova-2"),
        ("language", "ru"),
        ("interim_results", "true"),
        ("utterance_end_ms", str(_resolve_utterance_end(mode))),
        ("endpointing", str(endpointing)),
        ("smart_format", "true"),
        ("punctuate", "true"),
        ("vad_events", "true"),
    ]
    params.extend(("keywords", term) for term in RU_KEYWORDS)
    _append_replace(params)
    return f"{DEEPGRAM_V1}?{urlencode(params)}"


def _build_flux_multi(sample_rate: int) -> str:
    """Flux v2: только поддерживаемые query-параметры (replace/keywords ломают connect)."""
    params: list[tuple[str, str]] = [
        ("model", "flux-general-multi"),
        ("encoding", "linear16"),
        ("sample_rate", str(sample_rate)),
        ("language_hint", "ru"),
        ("language_hint", "en"),
    ]
    return f"{DEEPGRAM_V2}?{urlencode(params)}"


async def _flux_configure(dg) -> None:
    """Keyterms и пороги EOT — через Configure, не в URL."""
    payload = {
        "type": "Configure",
        "keyterms": FLUX_KEYTERMS,
        "language_hints": ["ru", "en"],
        "thresholds": {
            "eager_eot_threshold": 0.45,
            "eot_threshold": 0.65,
            "eot_timeout_ms": 5000,
        },
    }
    await dg.send(json.dumps(payload, ensure_ascii=False))


def build_listen_url(
    *,
    engine: str,
    ui_language: str,
    mode: str,
    sample_rate: int,
) -> tuple[str, str]:
    endpointing = _resolve_endpointing(mode)
    if engine == "flux-multi":
        return _build_flux_multi(sample_rate), "flux-general-multi"
    if engine == "nova2-ru-legacy":
        return _build_nova2_legacy(endpointing, mode, sample_rate), "nova-2-ru"
    return _build_nova3_multi(ui_language, endpointing, mode, sample_rate), "nova-3-multi"


async def _dg_connect(url: str, key: str):
    headers = {"Authorization": f"Token {key}"}
    try:
        return await websockets.connect(url, additional_headers=headers, max_size=None)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers, max_size=None)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Deepgram WS connect failed url=%s err=%s", url.split("?", 1)[0], exc)
        raise


def _extract_nova_transcript(evt: dict) -> tuple[str, bool, bool] | None:
    evt_type = evt.get("type") or ""
    if evt_type in ("SpeechStarted", "Metadata"):
        return None

    channel = evt.get("channel")
    if channel is None:
        return None
    if isinstance(channel, list):
        channel = channel[0] if channel else None
    if not isinstance(channel, dict):
        return None

    alts = channel.get("alternatives") or []
    if not alts or not isinstance(alts[0], dict):
        return None

    text = (alts[0].get("transcript") or "").strip()
    if not text:
        return None
    return text, bool(evt.get("is_final", False)), bool(evt.get("speech_final", False))


def _extract_flux_turn(evt: dict) -> tuple[str, bool, bool, bool] | None:
    """Returns text, is_final, speech_final, utterance_end."""
    if evt.get("type") != "TurnInfo":
        return None
    text = (evt.get("transcript") or "").strip()
    event = evt.get("event") or ""
    if event == "Update":
        if not text:
            return None
        return text, False, False, False
    if event == "EagerEndOfTurn":
        if not text:
            return None
        # Ранний триггер LLM — в UI строку ещё не финализируем (EndOfTurn придёт следом).
        return text, False, True, False
    if event == "EndOfTurn":
        if not text:
            return None
        return text, True, True, True
    if event == "StartOfTurn" and text:
        return text, False, False, False
    return None


async def run_proxy(
    client_ws,
    *,
    language: str,
    engine: str = "nova3-multi",
    sample_rate: int = 16000,
    endpointing: int | None = None,
    mode: str = "fast",
    on_final: Callable[[str], None] | None = None,
) -> None:
    if engine not in ENGINES:
        engine = "nova3-multi"
    if sample_rate not in (16000, 44100, 48000):
        sample_rate = 16000

    key = get_secret("deepgram_api_key")
    if not key:
        await client_ws.send_json({"type": "error", "message": "Deepgram API key не задан"})
        return

    url, model_label = build_listen_url(
        engine=engine, ui_language=language, mode=mode, sample_rate=sample_rate
    )
    logger.info(
        "Deepgram STT: engine=%s model=%s sample_rate=%s mode=%s lang=%s",
        engine,
        model_label,
        sample_rate,
        mode,
        language,
    )

    is_flux = engine == "flux-multi"

    try:
        dg = await _dg_connect(url, key)
        if is_flux:
            await _flux_configure(dg)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Deepgram connect failed: %s", exc)
        hint = ""
        if is_flux:
            hint = " Проверьте доступ к Flux на аккаунте Deepgram или выберите Nova-3 Multi."
        await client_ws.send_json(
            {"type": "error", "message": f"Не удалось подключиться к Deepgram: {exc}.{hint}"}
        )
        return

    await client_ws.send_json(
        {
            "type": "ready",
            "engine": engine,
            "model": model_label,
            "sample_rate": sample_rate,
        }
    )

    async def pump_audio() -> None:
        try:
            while True:
                data = await client_ws.receive_bytes()
                await dg.send(data)
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                await dg.send(json.dumps({"type": "CloseStream"}))
            except Exception:  # noqa: BLE001
                pass

    async def pump_transcripts() -> None:
        async for message in dg:
            try:
                evt = json.loads(message)
            except Exception:  # noqa: BLE001
                continue

            try:
                evt_type = evt.get("type", "")
                if evt_type == "Error" or evt_type == "FatalError":
                    desc = (
                        evt.get("description")
                        or evt.get("message")
                        or evt.get("code")
                        or "Deepgram error"
                    )
                    logger.warning("Deepgram error: %s", desc)
                    await client_ws.send_json({"type": "error", "message": desc})
                    break

                if is_flux:
                    if evt_type == "TurnResumed":
                        await client_ws.send_json({"type": "turn_resumed"})
                        continue
                    parsed = _extract_flux_turn(evt)
                    if not parsed:
                        continue
                    text, is_final, speech_final, utterance_end = parsed
                    await client_ws.send_json(
                        {
                            "type": "transcript",
                            "text": text,
                            "is_final": is_final,
                            "speech_final": speech_final,
                        }
                    )
                    if utterance_end:
                        await client_ws.send_json({"type": "utterance_end"})
                    if is_final and on_final:
                        on_final(text)
                    continue

                if evt_type == "UtteranceEnd":
                    await client_ws.send_json({"type": "utterance_end"})
                    continue

                parsed = _extract_nova_transcript(evt)
                if not parsed:
                    continue
                text, is_final, speech_final = parsed
                await client_ws.send_json(
                    {
                        "type": "transcript",
                        "text": text,
                        "is_final": is_final,
                        "speech_final": speech_final,
                    }
                )
                if is_final and on_final:
                    on_final(text)
            except Exception:  # noqa: BLE001
                logger.debug("Skip unhandled Deepgram event: %s", evt.get("type"), exc_info=True)
                continue

    audio_task = asyncio.create_task(pump_audio())
    tx_task = asyncio.create_task(pump_transcripts())
    try:
        _, pending = await asyncio.wait({audio_task, tx_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
    finally:
        await dg.close()
