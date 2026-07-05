"""Per-candidate profile pack: build, cache, and serve.

The live prompt used to ship with a hardcoded candidate biography; this module
replaces it. The pack is distilled from the user's own resume/legend/vacancy by
one LLM call, cached in AppMeta keyed by a hash of the source texts, and
injected into live prompts as plain text.

Latency contract: the live path only READS the cache (get_profile_block never
calls the LLM). Generation runs after document uploads (background) or via the
manual refresh endpoint.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time

from sqlalchemy.orm import Session

from app.db.models import ApiUsage, AppMeta
from app.prompts.candidate_profile import (
    PROFILE_BUILD_PROMPT,
    PROFILE_PACK_FALLBACK,
    PROFILE_PACK_HEADER,
)
from app.services import model_router, provider_adapter, rag_service
from app.services.preferences import load_preferences

logger = logging.getLogger("candidate_profile")

META_KEY = "candidate_profile_pack"

# Generation inputs are generous (one-off call); the cached pack itself is
# capped so a runaway model can't bloat every live prompt.
RESUME_SOURCE_LIMIT = 6000
LEGEND_SOURCE_LIMIT = 2000
VACANCY_SOURCE_LIMIT = 4000
PACK_MAX_CHARS = 4000


def _source_texts(db: Session) -> tuple[str, str, str]:
    resume = rag_service.get_context_text(db, "resume").strip()
    legend = rag_service.get_context_text(db, "legend").strip()
    vacancy = rag_service.get_context_text(db, "vacancy").strip()
    return resume, legend, vacancy


def _source_hash(resume: str, legend: str, vacancy: str) -> str:
    joined = "\x1f".join((resume, legend, vacancy))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def _load_cached(db: Session) -> dict | None:
    row = db.get(AppMeta, META_KEY)
    if row is None or not row.value:
        return None
    try:
        data = json.loads(row.value)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def get_profile_block(db: Session) -> str:
    """Cache-only read for the live path: pack text or a conservative fallback.

    A stale pack (documents changed since generation) is still better than none —
    it's the user's own facts — so it is served with staleness noted in the log.
    """
    cached = _load_cached(db)
    content = (cached or {}).get("content", "")
    if not isinstance(content, str) or not content.strip():
        return PROFILE_PACK_FALLBACK
    resume, legend, vacancy = _source_texts(db)
    if cached.get("hash") != _source_hash(resume, legend, vacancy):
        logger.info("Profile pack is stale (documents changed); serving cached pack anyway")
    return f"{PROFILE_PACK_HEADER}\n{content.strip()}"


def pack_status(db: Session) -> dict:
    cached = _load_cached(db)
    resume, legend, vacancy = _source_texts(db)
    current_hash = _source_hash(resume, legend, vacancy)
    return {
        "exists": bool(cached and cached.get("content")),
        "stale": bool(cached and cached.get("hash") != current_hash),
        "userEdited": bool((cached or {}).get("user_edited")),
        "hasResume": bool(resume),
        "hasLegend": bool(legend),
        "hasVacancy": bool(vacancy),
        "generatedAt": (cached or {}).get("generated_at"),
        "model": (cached or {}).get("model"),
    }


def get_pack_content(db: Session) -> str:
    """Сырой текст пака для UI (без служебного заголовка live-промпта)."""
    cached = _load_cached(db)
    content = (cached or {}).get("content", "")
    return content.strip() if isinstance(content, str) else ""


def save_user_pack(db: Session, content: str) -> dict:
    """Ручная правка пака пользователем — становится источником истины.

    Помечаем user_edited: фоновая регенерация после загрузки документов больше
    не затирает правки; сбросить их можно только явным «Пересобрать» (force).
    """
    resume, legend, vacancy = _source_texts(db)
    payload = json.dumps(
        {
            "hash": _source_hash(resume, legend, vacancy),
            "content": content.strip()[:PACK_MAX_CHARS],
            "model": "user",
            "user_edited": True,
            "generated_at": int(time.time()),
        },
        ensure_ascii=False,
    )
    row = db.get(AppMeta, META_KEY)
    if row is None:
        db.add(AppMeta(key=META_KEY, value=payload))
    else:
        row.value = payload
    db.commit()
    return pack_status(db)


async def refresh_profile_pack(db: Session, *, force: bool = False) -> dict:
    """Generate the pack from current documents and cache it in AppMeta.

    Returns pack_status() afterwards. Raises AppError from quota/provider when
    called from the endpoint; background callers should catch and log.
    """
    from app.services import quota

    resume, legend, vacancy = _source_texts(db)
    cached = _load_cached(db)
    # Ручные правки пользователя — источник истины: фоновая регенерация их не
    # трогает, сбросить можно только явным «Пересобрать из документов» (force).
    if not force and cached and cached.get("user_edited"):
        return pack_status(db)

    if not resume and not legend:
        # Nothing personal to distill — drop any previous pack so the live
        # prompt falls back to the conservative no-claims instruction.
        # (user_edited сюда доходит только при force — явном сбросе.)
        row = db.get(AppMeta, META_KEY)
        if row is not None:
            db.delete(row)
            db.commit()
        return pack_status(db)

    current_hash = _source_hash(resume, legend, vacancy)
    if not force and cached and cached.get("hash") == current_hash and cached.get("content"):
        return pack_status(db)

    quota.check_token_quota(db)

    prefs = load_preferences()
    available = {m.id for m in prefs.models_cache}
    provider = prefs.provider or "openrouter"
    model, _ = model_router.resolve_model("general", prefs=prefs, available=available)

    language = "Russian" if _looks_russian(resume or legend) else "English"
    prompt = PROFILE_BUILD_PROMPT.format(
        resume=resume[:RESUME_SOURCE_LIMIT] or "(none)",
        legend=legend[:LEGEND_SOURCE_LIMIT] or "(none)",
        vacancy=vacancy[:VACANCY_SOURCE_LIMIT] or "(none)",
        language=language,
    )
    raw = await provider_adapter.complete(
        [{"role": "user", "content": prompt}],
        provider,
        model,
        max_tokens=900,
        temperature=0.2,
    )
    content = (raw or "").strip()[:PACK_MAX_CHARS]
    if not content:
        raise ValueError("Model returned an empty profile pack")

    payload = json.dumps(
        {
            "hash": current_hash,
            "content": content,
            "model": model,
            "generated_at": int(time.time()),
        },
        ensure_ascii=False,
    )
    row = db.get(AppMeta, META_KEY)
    if row is None:
        db.add(AppMeta(key=META_KEY, value=payload))
    else:
        row.value = payload

    usage = provider_adapter.pop_last_usage() or {}
    db.add(
        ApiUsage(
            provider=provider,
            kind="chat",
            tokens_in=int(usage.get("prompt_tokens") or 0) or len(prompt) // 4,
            tokens_out=int(usage.get("completion_tokens") or 0) or len(content) // 4,
        )
    )
    db.commit()
    return pack_status(db)


async def refresh_profile_pack_background() -> None:
    """Fire-and-forget wrapper for document uploads: own session, errors logged."""
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        await refresh_profile_pack(db)
        logger.info("Profile pack refreshed after document change")
    except Exception as exc:  # noqa: BLE001 — uploads must never fail on this
        logger.warning("Profile pack background refresh failed: %s", exc)
    finally:
        db.close()


def _looks_russian(text: str) -> bool:
    sample = text[:2000]
    cyr = sum(1 for ch in sample if "а" <= ch.lower() <= "я" or ch.lower() == "ё")
    return cyr > len(sample) * 0.2
