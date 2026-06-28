"""Deterministic quality scoring for a live Say-aloud answer (Python side).

Mirrors packages/shared/src/answerQuality.ts. Used by the offline answer-quality
eval harness (scripts/eval_answers.py) to score real LLM answers, and unit-tested
on crafted good/bad answers. It judges structure/say-aloud-ness, not factual
correctness — required-term presence is the caller's job via `required_terms`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Phrases that must never appear in a live / Say-aloud answer.
FORBIDDEN_LIVE_PHRASES = [
    "если хотите, могу подробнее",
    "если хотите, могу разложить",
    "важно отметить",
    "в заключение",
    "давайте рассмотрим",
    "main answer",
    "key points",
    "short answer",
    "я не совсем понял вопрос. если говорить в общем",
    "в разных контекстах могут быть разные подходы",
    "это позволило мне углубить",
    "существуют различные инструменты и методы",
]

INTERNAL_LABELS = ["main answer", "key points", "short answer", "detailed"]

_FILLER_OPENINGS = [
    re.compile(r"^похоже,", re.IGNORECASE),
    re.compile(r"^вероятно,", re.IGNORECASE),
    re.compile(r"^судя\s+по\s+всему,", re.IGNORECASE),
    re.compile(r"^я\s+понял\s+вопрос\s+как", re.IGNORECASE),
    re.compile(r"^вопрос\s+(?:про|касается)", re.IGNORECASE),
    re.compile(r"^можно\s+сказать,", re.IGNORECASE),
    re.compile(r"^в\s+целом,", re.IGNORECASE),
    re.compile(r"^давайте\s+разберём", re.IGNORECASE),
    re.compile(r"^важно\s+отметить", re.IGNORECASE),
    re.compile(r"^я\s+не\s+совсем\s+понял", re.IGNORECASE),
]


@dataclass
class SpokenAnswerQuality:
    word_count: int
    within_word_limit: bool
    forbidden_phrases: list[str] = field(default_factory=list)
    internal_labels: list[str] = field(default_factory=list)
    missing_terms: list[str] = field(default_factory=list)
    starts_with_filler: bool = False
    has_markdown_header: bool = False
    ok: bool = False


def count_words(text: str) -> int:
    t = (text or "").strip()
    return len(t.split()) if t else 0


def score_spoken_answer(
    answer: str,
    *,
    max_words: int = 90,
    required_terms: list[str] | None = None,
) -> SpokenAnswerQuality:
    text = (answer or "").strip()
    low = text.lower()

    forbidden = [p for p in FORBIDDEN_LIVE_PHRASES if p in low]
    labels = [
        label
        for label in INTERNAL_LABELS
        if re.search(rf"(?:^|\n|[.?!]\s)\s*\*{{0,2}}\s*{re.escape(label)}\s*\*{{0,2}}\s*:", low)
    ]
    word_count = count_words(text)
    within = word_count <= max_words
    starts_filler = any(p.search(text) for p in _FILLER_OPENINGS)
    has_header = bool(re.search(r"(?:^|\n)\s*#{1,6}\s", text))
    missing = [t for t in (required_terms or []) if t.lower() not in low]

    ok = (
        word_count > 0
        and within
        and not forbidden
        and not labels
        and not starts_filler
        and not has_header
        and not missing
    )
    return SpokenAnswerQuality(
        word_count=word_count,
        within_word_limit=within,
        forbidden_phrases=forbidden,
        internal_labels=labels,
        missing_terms=missing,
        starts_with_filler=starts_filler,
        has_markdown_header=has_header,
        ok=ok,
    )
