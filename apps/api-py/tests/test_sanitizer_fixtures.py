"""Cross-language drift guard for the live-answer sanitizer.

Asserts the SAME fixtures as the TS suite
(packages/shared/src/sanitizerFixtures.test.ts). If the Python and TS sanitizers
diverge, one of the two suites fails.
"""

import json

import pytest

from app.config import BASE_DIR
from app.services.sanitize_live_answer import sanitize_live_answer

_FIXTURES = BASE_DIR.parent.parent / "packages" / "shared" / "fixtures" / "sanitizer-cases.json"


def _load_cases() -> list[dict]:
    return json.loads(_FIXTURES.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_sanitizer_fixture(case: dict) -> None:
    out = sanitize_live_answer(case["input"])
    if "equals" in case:
        assert out == case["equals"], f"{case['name']}: {out!r}"
    for s in case.get("mustContain", []):
        assert s in out, f"{case['name']}: must contain {s!r}, got {out!r}"
    for s in case.get("mustNotContain", []):
        assert s.lower() not in out.lower(), f"{case['name']}: must NOT contain {s!r}, got {out!r}"
