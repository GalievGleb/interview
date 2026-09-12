"""Ten actual STT -> answer turns on ONE installed-Alpha backend/WebSocket.

Uses repository WAV fixtures only. Report omits audio, transcript and answers.
This checks packaged backend/provider continuity, not Electron hotkey delivery;
run the installed Electron smoke and deterministic UI lifecycle tests as well.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from pathlib import Path

import websockets

import verify_dev_voice_overlay as voice
from voice_sequence import VoiceSequenceError, run_voice_sequence


async def verify(port: int, token: str) -> dict:
    fixtures = json.loads((voice._repo_root() / 'tests/voice/cases.json').read_text('utf-8'))
    # Six distinct existing WAV fixtures; repeat four to exercise another cycle.
    cases = []
    for index in range(10):
        case = dict(fixtures[index % len(fixtures)])
        rate, pcm = voice._read_pcm(voice._repo_root() / case['audioFile'])
        case['pcm'] = voice._resample_pcm16_mono(pcm, rate, voice.LIVE_SAMPLE_RATE)
        cases.append(case)
    query = urllib.parse.urlencode({'language': 'ru', 'sample_rate': voice.LIVE_SAMPLE_RATE, 'token': token})
    async with websockets.connect(f'ws://127.0.0.1:{port}/stt/stream?{query}', open_timeout=10, close_timeout=2) as ws:
        deadline = time.monotonic() + 12
        while True:
            event = await voice._next_event(ws, deadline)
            if event.get('type') == 'error':
                raise VoiceSequenceError('STT startup failed')
            if event.get('type') == 'ready':
                break

        async def answer(question, case, recent_turns):
            matches = voice._matches(question, case['requiredTranscriptKeywords'])
            if len(matches) < 3:
                raise VoiceSequenceError('transcript semantic check failed')
            try:
                text, first_ms, total_ms, _ = await asyncio.to_thread(
                    voice._ask_overlay, port, token, question, case, recent_turns=recent_turns,
                )
            except Exception:
                # Legacy verifier exceptions may embed raw content. Do not surface it.
                raise VoiceSequenceError('answer provider or semantic check failed') from None
            return {'answer': text, 'firstChunkMs': first_ms, 'totalMs': total_ms}

        return await run_voice_sequence(ws, cases, answer)


def main() -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    backend = Path(os.environ['LOCALAPPDATA']) / 'Programs/skillcue-alpha/resources/backend/skillcue-backend.exe'
    if not backend.is_file():
        raise VoiceSequenceError('Installed Alpha backend not found')
    token = uuid.uuid4().hex
    port = voice._free_port()
    with tempfile.TemporaryDirectory(prefix='skillcue-alpha-sequence-') as directory:
        db = Path(directory) / 'test.sqlite'
        voice.seed_installed_gateway_identity(db)
        env = {
            **os.environ, 'SKILLCUE_PORT': str(port), 'SKILLCUE_API_TOKEN': token,
            'SKILLCUE_BUILD_CHANNEL': 'alpha', 'SKILLCUE_GATEWAY_URL': 'https://skill-cue.ru/v1',
            'DATABASE_URL': f'sqlite:///{db.as_posix()}',
        }
        process = subprocess.Popen([str(backend)], env=env, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            voice._wait_for_health(port, time.monotonic() + 20)
            result = asyncio.run(verify(port, token))
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result['passed'] and result['completed'] == 10 else 1
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except VoiceSequenceError as error:
        print(f'Alpha voice sequence FAILED: {error}')
        raise SystemExit(1) from None
    except Exception as error:
        # Transport/provider exceptions may contain token-bearing URLs.
        print(f'Alpha voice sequence FAILED: {type(error).__name__}; no private content logged')
        raise SystemExit(1) from None
