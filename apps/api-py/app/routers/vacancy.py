"""Vacancy Smoke Review — LLM-backed analysis + answer evaluation.

The desktop calls these with a deterministic mock fallback, so the feature works
offline; here we add the real, grounded LLM path.
"""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.prompts.vacancy import VACANCY_ANALYZE_PROMPT, VACANCY_EVALUATE_PROMPT
from app.services import model_router, provider_adapter
from app.services.preferences import load_preferences

logger = logging.getLogger("vacancy")

router = APIRouter(prefix="/vacancy", tags=["vacancy"])

_SENIORITY = {"intern", "junior", "middle", "senior", "lead", "unknown"}
_IMPORTANCE = {"high", "medium", "low"}


def _resolve(mode: str = "general") -> tuple[str, str]:
    prefs = load_preferences()
    available = {m.id for m in prefs.models_cache}
    provider = prefs.provider or "openrouter"
    model, _ = model_router.resolve_model(mode, prefs=prefs, available=available)
    return provider, model


def _parse_json(raw: str) -> dict:
    cleaned = (raw or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip().rstrip("`").strip()
    try:
        data = json.loads(cleaned)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    # Salvage the first {...} block.
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
    raise HTTPException(status_code=502, detail="Model did not return valid JSON")


def _slug(text: str, used: set[str]) -> str:
    base = re.sub(r"[^a-zа-яё0-9]+", "-", (text or "topic").lower()).strip("-")[:48] or "topic"
    slug = base
    i = 2
    while slug in used:
        slug = f"{base}-{i}"
        i += 1
    used.add(slug)
    return slug


def _as_list(value, limit: int = 12) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:limit]


class AnalyzePayload(BaseModel):
    vacancyText: str
    targetRole: str | None = None
    language: str = "ru"
    resumeText: str | None = None
    legendText: str | None = None


class EvaluatePayload(BaseModel):
    question: str
    answer: str
    topic: str = ""
    expectedSignals: list[str] = []
    language: str = "ru"
    hasResume: bool = False


@router.post("/analyze")
async def analyze(payload: AnalyzePayload) -> dict:
    text = (payload.vacancyText or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="Vacancy text is too short")

    provider, model = _resolve("deep")
    prompt = VACANCY_ANALYZE_PROMPT.format(
        vacancy=text[:8000],
        resume=(payload.resumeText or "")[:4000] or "(none)",
        legend=(payload.legendText or "")[:2000] or "(none)",
        language="Russian" if payload.language == "ru" else "English",
    )
    try:
        raw = await provider_adapter.complete(
            [{"role": "user", "content": prompt}],
            provider,
            model,
            max_tokens=1600,
            temperature=0.3,
        )
    except Exception as exc:  # noqa: BLE001 — surface as 502 so desktop falls back
        logger.warning("Vacancy analyze failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)

    used: set[str] = set()
    topics = []
    for t in data.get("interviewTopics", []) or []:
        if not isinstance(t, dict) or not str(t.get("title", "")).strip():
            continue
        importance = str(t.get("importance", "medium")).lower()
        topics.append(
            {
                "id": _slug(str(t.get("title")), used),
                "title": str(t.get("title")).strip()[:80],
                "category": str(t.get("category", "General")).strip()[:40] or "General",
                "importance": importance if importance in _IMPORTANCE else "medium",
                "expectedKnowledge": str(t.get("expectedKnowledge", "")).strip()[:240],
                "sampleQuestions": _as_list(t.get("sampleQuestions"), 4)
                or ["Расскажи про эту тему."],
                "vacancyEvidence": str(t.get("vacancyEvidence", "")).strip()[:160],
            }
        )

    seniority = str(data.get("seniorityLevel", "unknown")).lower()
    target_role = (
        payload.targetRole or str(data.get("targetRole", "")) or "Technical role"
    ).strip()[:80]

    return {
        "targetRole": target_role,
        "seniorityLevel": seniority if seniority in _SENIORITY else "unknown",
        "extractedRequirements": _as_list(data.get("extractedRequirements")),
        "optionalSkills": _as_list(data.get("optionalSkills")),
        "interviewTopics": topics,
        "projectQuestions": _as_list(data.get("projectQuestions"), 6),
        "riskAreas": _as_list(data.get("riskAreas"), 6),
    }


@router.post("/evaluate")
async def evaluate(payload: EvaluatePayload) -> dict:
    provider, model = _resolve("general")
    prompt = VACANCY_EVALUATE_PROMPT.format(
        topic=payload.topic or "(unspecified)",
        signals=", ".join(payload.expectedSignals) or "(none)",
        question=payload.question[:600],
        answer=(payload.answer or "(empty)")[:1500],
        has_resume="true" if payload.hasResume else "false",
        language="Russian" if payload.language == "ru" else "English",
    )
    try:
        raw = await provider_adapter.complete(
            [{"role": "user", "content": prompt}],
            provider,
            model,
            max_tokens=600,
            temperature=0.2,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Vacancy evaluate failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    data = _parse_json(raw)

    def _score(key: str) -> int:
        try:
            return max(0, min(100, round(float(data.get(key, 0)))))
        except (TypeError, ValueError):
            return 0

    return {
        "score": _score("score"),
        "clarityScore": _score("clarityScore"),
        "technicalAccuracyScore": _score("technicalAccuracyScore"),
        "specificityScore": _score("specificityScore"),
        "confidenceScore": _score("confidenceScore"),
        "feedback": str(data.get("feedback", "")).strip()[:400],
        "missingPoints": _as_list(data.get("missingPoints"), 6),
        "goodPoints": _as_list(data.get("goodPoints"), 6),
        "suggestedBetterAnswer": str(data.get("suggestedBetterAnswer", "")).strip()[:600],
        "overclaimed": bool(data.get("overclaimed", False)),
    }
