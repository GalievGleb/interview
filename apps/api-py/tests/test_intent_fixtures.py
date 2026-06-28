"""Cross-language drift guard for question-intent classification.

Asserts the SAME fixtures as packages/shared/src/intentFixtures.test.ts. If the
Python and TS classifiers diverge, one of the two suites fails.
"""

import json

import pytest

from app.config import BASE_DIR
from app.services.question_intent import classify_interview_question_intent

_FIXTURES = BASE_DIR.parent.parent / "packages" / "shared" / "fixtures" / "intent-cases.json"


def _load_cases() -> list[dict]:
    return json.loads(_FIXTURES.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "case", _load_cases(), ids=lambda c: c["intent"] + ":" + c["question"][:20]
)
def test_intent_fixture(case: dict) -> None:
    got = classify_interview_question_intent(case["question"])["question_intent"]
    assert got == case["intent"], f"{case['question']!r}: expected {case['intent']}, got {got}"
