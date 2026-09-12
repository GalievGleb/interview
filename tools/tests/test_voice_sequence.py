from __future__ import annotations

import asyncio
import json
import io
from pathlib import Path

import pytest

from tools import voice_sequence


class InterviewSocket:
    """Transport double: completes the turn addressed by each real finalize."""

    def __init__(self, *, empty_at: int | None = None):
        self.turn = 0
        self.events: list[str] = []
        self.requests: list[str] = []
        self.empty_at = empty_at

    async def send(self, data):
        if isinstance(data, bytes):
            return
        request = json.loads(data)
        self.turn += 1
        request_id = request['request_id']
        self.requests.append(request_id)
        self.events.append(json.dumps({
            'type': 'transcript', 'force_request_id': 'previous-turn',
            'text': 'STALE QUESTION',
        }))
        self.events.append(json.dumps({
            'type': 'force_empty' if self.turn == self.empty_at else 'transcript',
            'force_request_id': request_id,
            'text': f'Question {self.turn}',
        }))

    async def recv(self):
        if self.events:
            return self.events.pop(0)
        await asyncio.Event().wait()


def test_ten_turns_keep_same_transport_and_answer_the_current_question():
    socket = InterviewSocket()
    questions = []

    async def answer(question, case, recent_turns):
        questions.append((question, list(recent_turns)))
        return {'answer': f'Answer to {question}', 'firstChunkMs': 3, 'totalMs': 5}

    result = asyncio.run(voice_sequence.run_voice_sequence(
        socket, [{'id': f'case-{i}', 'pcm': b'\0\0'} for i in range(10)], answer,
    ))
    assert result['completed'] == 10
    assert result['passed'] is True
    assert [question for question, _ in questions] == [f'Question {i}' for i in range(1, 11)]
    assert len(set(socket.requests)) == 10
    assert questions[0][1] == []
    assert questions[-1][1] == [
        {'question': 'Question 8', 'answer': 'Answer to Question 8'},
        {'question': 'Question 9', 'answer': 'Answer to Question 9'},
    ]
    assert 'Question' not in json.dumps(result)
    assert 'Answer to' not in json.dumps(result)


def test_lost_second_final_fails_without_answering_previous_text_or_continuing():
    socket = InterviewSocket(empty_at=2)
    accepted = []

    async def answer(question, case, recent_turns):
        accepted.append(question)
        return {'answer': 'Answer', 'firstChunkMs': 3, 'totalMs': 5}

    with pytest.raises(voice_sequence.VoiceSequenceError, match='turn 2.*empty'):
        asyncio.run(voice_sequence.run_voice_sequence(
            socket, [{'id': 'case', 'pcm': b'\0\0'}] * 10, answer,
        ))
    assert accepted == ['Question 1']


def test_empty_completed_answer_cannot_pass_acceptance():
    async def answer(question, case, recent_turns):
        return {'answer': ' ', 'firstChunkMs': 3, 'totalMs': 5}

    with pytest.raises(voice_sequence.VoiceSequenceError, match='empty answer'):
        asyncio.run(voice_sequence.run_voice_sequence(
            InterviewSocket(), [{'id': 'case', 'pcm': b'\0\0'}] * 10, answer,
        ))


def test_missing_final_has_a_real_timeout():
    class SilentSocket:
        async def recv(self):
            await asyncio.Event().wait()

    with pytest.raises(voice_sequence.VoiceSequenceError, match='deadline'):
        asyncio.run(voice_sequence.wait_for_current_final(SilentSocket(), 'current', timeout_s=0.01))


def test_packaged_answer_request_carries_recent_completed_turns(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    import verify_dev_voice_overlay as verifier

    requests = []

    def respond(request, timeout):
        requests.append(json.loads(request.data))
        return io.BytesIO(
            b'data: {"type":"chunk","text":"alpha beta gamma"}\n\n'
            b'data: {"type":"done","spoken":"alpha beta gamma"}\n\n'
        )

    monkeypatch.setattr(verifier.urllib.request, 'urlopen', respond)
    prior = [{'question': 'Previous question', 'answer': 'Previous completed answer'}]
    result = verifier._ask_overlay(1, 'synthetic-token', 'Current question', {
        'requiredAnswerKeywords': [{'key': word, 'aliases': [word]} for word in ['alpha', 'beta', 'gamma']],
    }, recent_turns=prior)
    assert result[0] == 'alpha beta gamma'
    assert requests[0]['recent_turns'] == prior


def test_case04_answer_russian_synonyms_match_isolation_and_retries(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    import verify_dev_voice_overlay as verifier

    cases = json.loads(
        (Path(__file__).resolve().parents[2] / 'tests' / 'voice' / 'cases.json').read_text('utf-8')
    )
    case = next(case for case in cases if case['id'] == '04_flaky_tests')
    answer = (
        'В отчёт добавили логи и Allure. '
        'В пайплайне мы изолировали зависимости между запусками, '
        'а повторный запуск служил лишь временной диагностикой.'
    )

    matched = verifier._matches(answer, case['requiredAnswerKeywords'])

    assert {'логи', 'Allure', 'retries', 'изоляция'} <= set(matched)
    assert 'sleep' not in matched

    unrelated = 'Для диагностики приложили только скриншоты и локаторы.'
    unrelated_matches = verifier._matches(unrelated, case['requiredAnswerKeywords'])
    assert {'retries', 'изоляция'}.isdisjoint(unrelated_matches)
