"""Same-connection voice acceptance; reports contain timings, never content."""

from __future__ import annotations

import asyncio
import json
import time
import uuid


class VoiceSequenceError(RuntimeError):
    pass


async def run_voice_sequence(ws, cases, answer_question):
    reports = []
    history = []
    for index, case in enumerate(cases, start=1):
        try:
            pcm = case['pcm']
            # Desktop PCM contract: mono, 16 kHz, 16-bit, 100 ms frames.
            for offset in range(0, len(pcm), 3200):
                await ws.send(pcm[offset:offset + 3200])
                await asyncio.sleep(0)
            # Exercise a force request while the automatic STT job is active.
            await asyncio.sleep(0.1)
            request_id = f'alpha-sequence-{uuid.uuid4().hex}'
            started = time.monotonic()
            await ws.send(json.dumps({'type': 'finalize', 'request_id': request_id}))
            question = await wait_for_current_final(ws, request_id)
            stt_ms = round((time.monotonic() - started) * 1000)
            result = await asyncio.wait_for(answer_question(question, case, list(history)), 45)
            answer = str(result.get('answer') or '').strip()
            if not answer:
                raise VoiceSequenceError('empty answer')
            reports.append({
                'turn': index, 'caseId': case['id'], 'completed': True,
                'sttMs': stt_ms, 'firstChunkMs': result.get('firstChunkMs'),
                'answerMs': result.get('totalMs'),
                'triggerToFirstAnswerMs': stt_ms + int(result.get('firstChunkMs') or 0),
            })
            history.append({'question': question[:800], 'answer': answer[:1800]})
            history = history[-2:]
        except VoiceSequenceError as exc:
            raise VoiceSequenceError(f'turn {index}: {exc}') from None
        except TimeoutError:
            raise VoiceSequenceError(f'turn {index}: answer deadline exceeded') from None
    return {'completed': len(reports), 'passed': bool(reports), 'turns': reports}


async def wait_for_current_final(ws, request_id, *, timeout_s=12):
    deadline = time.monotonic() + timeout_s
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise VoiceSequenceError('finalization deadline exceeded')
        try:
            event = json.loads(await asyncio.wait_for(ws.recv(), remaining))
        except TimeoutError:
            raise VoiceSequenceError('finalization deadline exceeded') from None
        if event.get('type') == 'error':
            raise VoiceSequenceError('STT connection error')
        if event.get('force_request_id') != request_id:
            continue
        kind = event.get('type')
        if kind in {'force_empty', 'low_quality', 'transcription_error'}:
            raise VoiceSequenceError(f'current final rejected ({kind})')
        if kind == 'transcript':
            text = str(event.get('text') or '').strip()
            if not text:
                raise VoiceSequenceError('empty transcript')
            return text
