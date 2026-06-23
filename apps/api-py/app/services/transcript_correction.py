import json
import logging
import re

from app.prompts.transcript_correction import CORRECTION_SYSTEM_PROMPT, CORRECTION_USER_PROMPT
from app.services import model_router, provider_adapter
from app.services.preferences import load_preferences

logger = logging.getLogger("transcript_correction")

SHORT_TRANSCRIPT_MAX = 120


def _parse_correction_json(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    match = re.search(r'"corrected"\s*:\s*"((?:[^"\\]|\\.)*)"', text, re.DOTALL)
    if match:
        corrected = match.group(1).replace("\\n", "\n").replace('\\"', '"')
        return {"corrected": corrected, "confidence": "medium", "reason": "extracted"}
    return {}


async def llm_correct_transcript(
    raw_transcript: str,
    glossary_corrected: str,
) -> dict:
    """Lightweight LLM pass for medium/low confidence glossary fixes."""
    prefs = load_preferences()
    available = {m.id for m in prefs.models_cache}
    model, _ = model_router.resolve_model("fast", prefs=prefs, available=available)

    prompt = CORRECTION_USER_PROMPT.format(
        raw_transcript=raw_transcript,
        glossary_corrected=glossary_corrected,
    )
    messages = [
        {"role": "system", "content": CORRECTION_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    try:
        raw = await provider_adapter.complete(
            messages,
            prefs.provider or "openrouter",
            model,
            max_tokens=220,
            temperature=0.1,
        )
        parsed = _parse_correction_json(raw)
        corrected = str(parsed.get("corrected") or "").strip()
        if corrected:
            return {
                "corrected": corrected,
                "confidence": str(parsed.get("confidence") or "medium"),
                "reason": str(parsed.get("reason") or ""),
            }
    except Exception as exc:  # noqa: BLE001
        logger.warning("LLM transcript correction failed: %s", exc)
    return {"corrected": glossary_corrected, "confidence": "low", "reason": "fallback"}


def should_llm_correct(
    *,
    raw_question: str,
    glossary_corrected: str,
    corrections: list[dict] | None,
    needs_llm_correction: bool | None,
) -> bool:
    if needs_llm_correction is not None:
        return needs_llm_correction
    if not raw_question.strip():
        return False
    if glossary_corrected.strip() != raw_question.strip():
        confidences = {str(c.get("confidence", "medium")) for c in (corrections or [])}
        if confidences & {"medium", "low"}:
            return True
    return False
