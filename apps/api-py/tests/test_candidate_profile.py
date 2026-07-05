"""Candidate profile pack: cache behaviour + live prompt formatting.

The live path may only READ the cache (never call the LLM), and the rewritten
INTERVIEW_PROMPT_STREAM must accept every kwarg chat.py passes — a placeholder
mismatch would crash every live answer at runtime.
"""

import asyncio
import json

from app.db.models import AppMeta, Document
from app.prompts.candidate_profile import PROFILE_PACK_FALLBACK, PROFILE_PACK_HEADER
from app.prompts.interview_fast import INTERVIEW_PROMPT_STREAM, LIVE_SYSTEM_PROMPT
from app.services import candidate_profile


def test_get_profile_block_without_cache_returns_fallback(db_session):
    assert candidate_profile.get_profile_block(db_session) == PROFILE_PACK_FALLBACK


def test_get_profile_block_serves_cached_pack_with_header(db_session):
    db_session.add(Document(kind="resume", title="r", raw_text="Python developer"))
    db_session.commit()
    resume, legend, vacancy = candidate_profile._source_texts(db_session)
    db_session.add(
        AppMeta(
            key=candidate_profile.META_KEY,
            value=json.dumps(
                {
                    "hash": candidate_profile._source_hash(resume, legend, vacancy),
                    "content": "CANDIDATE PROFILE:\n- Python developer",
                    "model": "test",
                    "generated_at": 1,
                }
            ),
        )
    )
    db_session.commit()

    block = candidate_profile.get_profile_block(db_session)
    assert block.startswith(PROFILE_PACK_HEADER)
    assert "Python developer" in block


def test_stale_pack_still_served(db_session):
    """Documents changed after generation → the old pack is still the user's own
    facts, so it must be served (generation catches up in the background)."""
    db_session.add(
        AppMeta(
            key=candidate_profile.META_KEY,
            value=json.dumps({"hash": "outdated", "content": "OLD PACK", "generated_at": 1}),
        )
    )
    db_session.add(Document(kind="resume", title="r", raw_text="new resume text"))
    db_session.commit()

    assert "OLD PACK" in candidate_profile.get_profile_block(db_session)
    status = candidate_profile.pack_status(db_session)
    assert status["exists"] is True
    assert status["stale"] is True


def test_corrupt_cache_falls_back(db_session):
    db_session.add(AppMeta(key=candidate_profile.META_KEY, value="not json"))
    db_session.commit()
    assert candidate_profile.get_profile_block(db_session) == PROFILE_PACK_FALLBACK


def test_refresh_without_documents_clears_pack(db_session):
    db_session.add(
        AppMeta(
            key=candidate_profile.META_KEY,
            value=json.dumps({"hash": "h", "content": "OLD", "generated_at": 1}),
        )
    )
    db_session.commit()

    status = asyncio.run(candidate_profile.refresh_profile_pack(db_session))
    assert status["exists"] is False
    assert candidate_profile.get_profile_block(db_session) == PROFILE_PACK_FALLBACK


def test_user_edited_pack_survives_background_refresh(db_session):
    """Правка пользователя — источник истины: фоновый refresh её не затирает."""
    db_session.add(Document(kind="resume", title="r", raw_text="Python developer"))
    db_session.commit()

    status = candidate_profile.save_user_pack(db_session, "МОЙ ПРОФИЛЬ: senior Python.")
    assert status["exists"] is True
    assert status["userEdited"] is True

    # Фоновая регенерация (не force) должна выйти, не тронув правки —
    # LLM здесь не замокан, так что дойди она до генерации, тест бы упал.
    status = asyncio.run(candidate_profile.refresh_profile_pack(db_session))
    assert status["userEdited"] is True
    assert "МОЙ ПРОФИЛЬ" in candidate_profile.get_pack_content(db_session)


def test_profile_pack_http_roundtrip(client):
    res = client.put(
        "/documents/profile-pack",
        json={"content": "CANDIDATE PROFILE: QA engineer, Python, pytest."},
    )
    assert res.status_code == 200, res.text
    assert res.json()["userEdited"] is True

    got = client.get("/documents/profile-pack")
    assert got.status_code == 200
    assert "QA engineer" in got.json()["content"]

    too_short = client.put("/documents/profile-pack", json={"content": "hi"})
    assert too_short.status_code == 400


def test_live_prompt_formats_with_all_chat_kwargs():
    """Mirror of the kwargs chat.py passes — KeyError here means live is broken."""
    prompt = INTERVIEW_PROMPT_STREAM.format(
        resume="(нет)",
        vacancy="(нет)",
        legend="(нет)",
        candidate_profile=PROFILE_PACK_FALLBACK,
        question="Что такое ООП?",
        raw_question="что такое ооп",
        glossary_corrected="Что такое ООП?",
        ambiguity="(none)",
        resolved_follow_up_question="Что такое ООП?",
        previous_topic="(none)",
        question_intent="technical_definition",
        answer_strategy="answer the theory directly",
        resume_context_level="none",
        resume_context_used="false",
        resume_context_reason="theory question",
        domain_hints="(none)",
    )
    assert "Что такое ООП?" in prompt
    assert PROFILE_PACK_FALLBACK in prompt


def test_live_system_prompt_is_depersonalized():
    """The system prompt must not carry any concrete candidate's biography."""
    for marker in ("Сбер", "ГЕОМИКС", "600", "QA Automation Engineer (Python)"):
        assert marker not in LIVE_SYSTEM_PROMPT
