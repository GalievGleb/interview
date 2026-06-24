"""Deepgram prerecorded transcription for voice regression tests."""

import logging
import time
from urllib.parse import urlencode

import httpx

from app.services.keyterms import all_keyterms
from app.services.secrets import get_secret

logger = logging.getLogger("stt_prerecorded")

DEEPGRAM_LISTEN = "https://api.deepgram.com/v1/listen"


async def transcribe_wav_bytes(
    audio: bytes,
    *,
    language: str = "multi",
    sample_rate: int = 16000,
) -> tuple[str, int]:
    """Returns (transcript, latency_ms)."""
    key = get_secret("deepgram_api_key")
    if not key:
        raise RuntimeError("Deepgram API key не задан")

    params = [
        ("model", "nova-3"),
        ("language", "multi" if language in ("ru", "multi", "") else language),
        ("smart_format", "true"),
        ("punctuate", "true"),
        ("encoding", "linear16"),
        ("sample_rate", str(sample_rate)),
        ("channels", "1"),
    ]
    for term in all_keyterms()[:40]:
        params.append(("keyterm", term))

    url = f"{DEEPGRAM_LISTEN}?{urlencode(params)}"
    headers = {
        "Authorization": f"Token {key}",
        "Content-Type": "audio/wav",
    }

    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, content=audio, headers=headers)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if resp.status_code >= 400:
        logger.warning("Deepgram prerecorded failed: %s %s", resp.status_code, resp.text[:300])
        raise RuntimeError(f"Deepgram STT error {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    channels = data.get("results", {}).get("channels") or []
    if not channels:
        return "", latency_ms
    alts = channels[0].get("alternatives") or []
    if not alts:
        return "", latency_ms
    text = (alts[0].get("transcript") or "").strip()
    return text, latency_ms
