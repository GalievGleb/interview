"""Deterministic QA/Python glossary correction (no LLM, no Ollama).

Single source of truth: this loads the **same** data the desktop live pipeline
uses — ``packages/shared/src/qaGlossary.json`` — so there is no drift between
the production correction and the backend STT-benchmark "corrected" transcript.
The matching/gating logic mirrors ``correctTranscriptWithGlossary.ts``:

* multi-word / long / mixed-script aliases apply always (high confidence);
* shorter aliases apply in QA context or short utterances (medium);
* ``contextOnlyAliases`` apply only in QA interview context.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from app.config import BASE_DIR

logger = logging.getLogger("stt.glossary")

REPO_ROOT = BASE_DIR.parent.parent
GLOSSARY_JSON = REPO_ROOT / "packages" / "shared" / "src" / "qaGlossary.json"

SHORT_MAX = 120

# Mirror of QA_CONTEXT_RE in correctTranscriptWithGlossary.ts.
_QA_CONTEXT = re.compile(
    r"(?:что\s+такое|расскаж|объясн|опиш|назов|перечисл|чем\s+.+\s+отлича|принцип|"
    r"тестир|интервью|\bqa\b|\baqa\b|какие|какой|как\s+ты|проверял|настраивал|"
    r"использовал|python|list|tuple|typo|лист|кортеж)",
    re.IGNORECASE | re.UNICODE,
)


@dataclass
class CorrectionItem:
    src: str
    dst: str

    def as_dict(self) -> dict:
        return {"from": self.src, "to": self.dst}


def _has_latin(s: str) -> bool:
    return any("a" <= c <= "z" or "A" <= c <= "Z" for c in s)


def _has_cyrillic(s: str) -> bool:
    return any("Ѐ" <= c <= "ӿ" for c in s)


def _confidence(alias: str, context_only: bool) -> str:
    a = alias.lower().strip()
    if context_only:
        return "low"
    if " " in a or len(a) >= 10:
        return "high"
    if _has_latin(a) and _has_cyrillic(a):
        return "high"
    return "medium"


def _compile(alias: str) -> re.Pattern[str]:
    body = r"\s+".join(re.escape(p) for p in alias.split())
    return re.compile(rf"(?<!\w){body}(?!\w)", re.IGNORECASE | re.UNICODE)


@dataclass
class _Rule:
    pattern: re.Pattern[str]
    alias: str
    canonical: str
    confidence: str
    context_only: bool


def _load_rules() -> list[_Rule]:
    try:
        data = json.loads(GLOSSARY_JSON.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - missing/corrupt file -> no-op corrector
        logger.warning("Could not load glossary JSON (%s): %s", GLOSSARY_JSON, exc)
        return []

    rules: list[_Rule] = []
    for entry in data:
        canonical = entry.get("canonical", "")
        context_set = {a.lower() for a in entry.get("contextOnlyAliases", [])}
        for alias in entry.get("aliases", []):
            ctx = alias.lower() in context_set
            rules.append(
                _Rule(
                    pattern=_compile(alias),
                    alias=alias,
                    canonical=canonical,
                    confidence=_confidence(alias, ctx),
                    context_only=ctx,
                )
            )
    # Longest aliases first so multi-word forms win over their fragments.
    rules.sort(key=lambda r: -len(r.alias))
    return rules


_RULES = _load_rules()


def _has_qa_context(text: str) -> bool:
    return bool(_QA_CONTEXT.search(text))


def _should_apply(rule: _Rule, text: str, is_short: bool) -> bool:
    if rule.context_only:
        return _has_qa_context(text)
    if rule.confidence == "high":
        return True
    if rule.confidence == "medium":
        return is_short or _has_qa_context(text)
    return _has_qa_context(text) or is_short


def correct_transcript(text: str) -> tuple[str, list[CorrectionItem]]:
    """Return (corrected_text, applied_corrections)."""
    corrected = text or ""
    if not corrected.strip():
        return corrected, []
    is_short = len(corrected) <= SHORT_MAX
    applied: list[CorrectionItem] = []
    for rule in _RULES:
        if not _should_apply(rule, corrected, is_short):
            continue
        match = rule.pattern.search(corrected)
        if not match:
            continue
        src = match.group(0)
        window = corrected[match.start() : match.start() + len(rule.canonical)]
        # Already exactly canonical (incl. case) — nothing to do.
        if window == rule.canonical:
            continue
        # A SHORT alias landing inside text a longer alias already corrected
        # ("smoke" inside "smoke testing") — don't re-expand. But a full-length
        # alias differing only by case should be normalized to canonical casing.
        if window.lower() == rule.canonical.lower() and len(src) < len(rule.canonical):
            continue
        corrected = corrected[: match.start()] + rule.canonical + corrected[match.end() :]
        applied.append(CorrectionItem(src=src, dst=rule.canonical))
    return corrected, applied


def glossary_size() -> int:
    """Number of compiled alias rules (for diagnostics/tests)."""
    return len(_RULES)
