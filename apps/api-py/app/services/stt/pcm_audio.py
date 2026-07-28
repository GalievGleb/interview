"""PCM helpers shared by streaming STT providers."""

from __future__ import annotations

import asyncio
import io
import sys
import time
import wave
from array import array
from collections.abc import Awaitable, Callable


def wav_pcm16_mono(audio: bytes) -> tuple[bytes, int]:
    """Return raw little-endian PCM16 frames and their sample rate."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise ValueError("Expected mono PCM16 WAV")
            return wav.readframes(wav.getnframes()), wav.getframerate()
    except (wave.Error, EOFError) as exc:
        raise ValueError("Expected a valid PCM WAV file") from exc


def pcm16_mono_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap little-endian mono PCM16 frames in a WAV container."""
    if sample_rate <= 0:
        raise ValueError("Sample rate must be positive")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def resample_pcm16_mono(pcm: bytes, source_rate: int, target_rate: int) -> bytes:
    """Resample mono PCM16 using linear interpolation without native dependencies."""
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("Sample rates must be positive")
    if source_rate == target_rate or not pcm:
        return pcm

    source = array("h")
    source.frombytes(pcm)
    if sys.byteorder != "little":
        source.byteswap()
    if len(source) < 2:
        return pcm

    output_count = max(1, round(len(source) * target_rate / source_rate))
    rate_ratio = source_rate / target_rate
    output = array("h")
    append = output.append
    last_index = len(source) - 1

    for output_index in range(output_count):
        source_position = output_index * rate_ratio
        left = min(int(source_position), last_index)
        right = min(left + 1, last_index)
        fraction = source_position - left
        sample = round(source[left] + (source[right] - source[left]) * fraction)
        append(max(-32768, min(32767, sample)))

    if sys.byteorder != "little":
        output.byteswap()
    return output.tobytes()


def chunk_pcm(pcm: bytes, chunk_size: int = 12_000):
    """Yield even-sized raw PCM chunks."""
    safe_size = max(2, chunk_size - (chunk_size % 2))
    for offset in range(0, len(pcm), safe_size):
        yield pcm[offset : offset + safe_size]


async def stream_pcm_realtime(
    pcm: bytes,
    *,
    sample_rate: int,
    send_chunk: Callable[[bytes], Awaitable[None]],
    chunk_ms: int = 100,
) -> int:
    """Replay PCM at its original pace and return the audio duration in ms."""
    if sample_rate <= 0:
        raise ValueError("Sample rate must be positive")
    bytes_per_second = sample_rate * 2
    chunk_size = max(2, round(bytes_per_second * chunk_ms / 1000))
    started = time.perf_counter()
    sent_bytes = 0

    for chunk in chunk_pcm(pcm, chunk_size=chunk_size):
        await send_chunk(chunk)
        sent_bytes += len(chunk)
        target_elapsed = sent_bytes / bytes_per_second
        delay = target_elapsed - (time.perf_counter() - started)
        if delay > 0:
            await asyncio.sleep(delay)

    return round(sent_bytes / bytes_per_second * 1000)


__all__ = [
    "chunk_pcm",
    "pcm16_mono_wav",
    "resample_pcm16_mono",
    "stream_pcm_realtime",
    "wav_pcm16_mono",
]
