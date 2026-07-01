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
_QUESTION_LEVEL = {"junior", "middle", "senior", "lead"}
_COMPETENCY_LEVEL = {"basic", "practical", "advanced", "lead"}
_RESUME_MATCH = {"strong", "partial", "gap"}


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
    level: str = ""
    expectedSignals: list[str] = []
    relatedResumeEvidence: list[str] = []
    resumeText: str | None = None
    legendText: str | None = None
    language: str = "ru"
    hasResume: bool = False


@router.post("/analyze")
async def analyze(payload: AnalyzePayload) -> dict:
    text = (payload.vacancyText or "").strip()
    if len(text) < 20:
        raise HTTPException(status_code=400, detail="Vacancy text is too short")

    provider, model = _resolve("vacancy")
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
        level = str(t.get("level", "")).lower()
        topics.append(
            {
                "id": _slug(str(t.get("title")), used),
                "title": str(t.get("title")).strip()[:80],
                "category": str(t.get("category", "General")).strip()[:40] or "General",
                "importance": importance if importance in _IMPORTANCE else "medium",
                "level": level if level in _QUESTION_LEVEL else "",
                "expectedKnowledge": str(t.get("expectedKnowledge", "")).strip()[:240],
                "sampleQuestions": _as_list(t.get("sampleQuestions"), 4)
                or ["Расскажи про эту тему."],
                "whyAsked": str(t.get("whyAsked", "")).strip()[:240],
                "expectedAnswerPoints": _as_list(t.get("expectedAnswerPoints"), 7),
                "relatedVacancyTopics": _as_list(t.get("relatedVacancyTopics"), 6),
                "relatedResumeEvidence": _as_list(t.get("relatedResumeEvidence"), 6),
                "vacancyEvidence": str(t.get("vacancyEvidence", "")).strip()[:160],
            }
        )

    competencies = []
    for c in data.get("competencies", []) or []:
        if not isinstance(c, dict) or not str(c.get("name", "")).strip():
            continue
        priority = str(c.get("priority", "medium")).lower()
        expected = str(c.get("expectedLevel", "practical")).lower()
        match = str(c.get("resumeMatch", "gap")).lower()
        competencies.append(
            {
                "name": str(c.get("name")).strip()[:80],
                "priority": priority if priority in _IMPORTANCE else "medium",
                "expectedLevel": expected if expected in _COMPETENCY_LEVEL else "practical",
                "resumeMatch": match if match in _RESUME_MATCH else "gap",
                "note": str(c.get("note", "")).strip()[:200],
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
        "competencies": competencies,
        "interviewTopics": topics,
        "projectQuestions": _as_list(data.get("projectQuestions"), 6),
        "riskAreas": _as_list(data.get("riskAreas"), 6),
        "model": model,
    }


@router.post("/evaluate")
async def evaluate(payload: EvaluatePayload) -> dict:
    provider, model = _resolve("vacancy")
    prompt = VACANCY_EVALUATE_PROMPT.format(
        topic=payload.topic or "(unspecified)",
        level=payload.level or "(unspecified)",
        signals=", ".join(payload.expectedSignals) or "(none)",
        resume_evidence=", ".join(payload.relatedResumeEvidence) or "(none)",
        resume=(payload.resumeText or "")[:4000] or "(none)",
        legend=(payload.legendText or "")[:2000] or "(none)",
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

    level = str(data.get("levelEstimate", "")).lower()

    return {
        "score": _score("score"),
        "clarityScore": _score("clarityScore"),
        "technicalAccuracyScore": _score("technicalAccuracyScore"),
        "specificityScore": _score("specificityScore"),
        "confidenceScore": _score("confidenceScore"),
        "levelEstimate": level if level in _QUESTION_LEVEL else "",
        "verdict": str(data.get("verdict", "")).strip()[:200],
        "feedback": str(data.get("feedback", "")).strip()[:400],
        "goodPoints": _as_list(data.get("goodPoints"), 6),
        "weakPoints": _as_list(data.get("weakPoints"), 6),
        "missingPoints": _as_list(data.get("missingPoints"), 6),
        "technicalCorrections": _as_list(data.get("technicalCorrections"), 6),
        "betterStructure": _as_list(data.get("betterStructure"), 8),
        "suggestedBetterAnswer": str(data.get("suggestedBetterAnswer", "")).strip()[:900],
        "followUpQuestions": _as_list(data.get("followUpQuestions"), 4),
        "nextTrainingFocus": str(data.get("nextTrainingFocus", "")).strip()[:240],
        "overclaimed": bool(data.get("overclaimed", False)),
        "model": model,
    }
