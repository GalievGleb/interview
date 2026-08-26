"""Tests for the Python Knowledge Pack retrieval + QA-vs-Python gating."""

import json

from app.services import knowledge_pack as kp

PYTHON_QUESTIONS = [
    "Чем список отличается от кортежа?",
    "Почему плохо использовать изменяемый объект как значение по умолчанию?",
    "Чем генератор отличается от итератора?",
    "Что делает yield?",
    "Что такое декоратор?",
    "Что такое контекстный менеджер?",
    "Что такое MRO?",
    "Чем staticmethod отличается от classmethod?",
    "Что такое args и kwargs?",
    "Как Python ищет модули при импорте?",
]

QA_QUESTIONS = [
    "Как ты настраивал CI/CD?",
    "Расскажи про pytest fixtures",
    "Как ты тестировал API?",
    "Что такое Page Object Model?",
    "Какие ошибки бывают в Page Object Model?",
    "Что вы делали с flaky-тестами в пайплайне?",
]


def test_python_questions_are_detected():
    for q in PYTHON_QUESTIONS:
        assert kp.is_python_question(q), q


def test_qa_questions_do_not_use_pack():
    for q in QA_QUESTIONS:
        assert not kp.is_python_question(q), q


def test_retrieval_returns_1_to_3_relevant_records():
    for q in PYTHON_QUESTIONS:
        block, meta = kp.build_injection(q)
        assert meta["knowledgePackUsed"] is True, q
        assert 1 <= meta["retrievedItemsCount"] <= 3, q
        assert block.startswith(("PYTHON KNOWLEDGE PACK", "PYTHON VERIFIED FACTUAL CONTRACT"))
        assert "Q:" in block and "A:" in block


def test_injection_is_token_capped_never_whole_file():
    # The whole source is ~5600 lines; an injection must stay tiny.
    for q in PYTHON_QUESTIONS:
        _, meta = kp.build_injection(q)
        assert meta["injectedContextTokens"] <= 1200, q


def test_metrics_shape():
    _, meta = kp.build_injection("Что такое декоратор?")
    for key in (
        "knowledgePackUsed",
        "knowledgePackName",
        "knowledgeRetrievalMs",
        "retrievedItemsCount",
        "injectedContextTokens",
    ):
        assert key in meta
    assert meta["knowledgePackName"] == "python_interview_questions"


def test_empty_for_blank_or_non_python():
    assert kp.is_python_question("") is False
    assert kp.is_python_question("Какая сегодня погода?") is False


def test_named_pytest_fixtures_never_route_to_python_pack():
    assert not kp.is_python_question(
        "Как определить порядок session_fixture, fixture_1 и fixture_4 после yield?"
    )


def test_git_hash_and_rebase_never_route_to_python_pack():
    assert (
        kp.is_python_question(
            "Как работает git rebase, что происходит с хешами и как разрешить конфликт?"
        )
        is False
    )


def test_corpus_factual_traps_use_verified_entries():
    cases = {
        "range в Python 3 — это генератор? Что было в Python 2?": "не генератор",
        "Как реализована инкапсуляция в Python?": "соглашениях",
        "Что вернёт a == b для двух разных экземпляров пустого класса?": "False",
        "Что вернёт a == b для a=C(); b=C(), если class C: pass?": "False",
        "Что произойдёт при присваивании элементу строки?": "TypeError",
        "Когда использовать наследование, а когда композицию?": "is-a",
    }
    for question, expected in cases.items():
        block, meta = kp.build_injection(question)
        assert meta["knowledgeSource"] == "curated", question
        assert meta["retrievedItemsCount"] == 1, question
        assert "non-negotiable" in block, question
        assert expected.lower() in block.lower(), question


def test_metadata_is_well_formed():
    meta = json.loads((kp.PACK_DIR / "metadata.json").read_text(encoding="utf-8"))
    assert meta["sourceName"] == "yakimka/python_interview_questions"
    assert meta["license"] == "MIT"
    assert meta["sourceQuality"] == "community_unverified"
    assert meta["useOnlyWhenIntent"] == "python_question"
    assert meta["recordCount"] > 50


def test_high_priority_records_exist():
    index = json.loads((kp.PACK_DIR / "index.json").read_text(encoding="utf-8"))
    priorities = {r["priority"] for r in index}
    assert "high_for_aqa" in priorities
    assert "low_rare_python_developer" in priorities


CURATED_QUESTIONS = [
    "Чем список отличается от кортежа?",
    "Что делает yield?",
    "Что такое декоратор?",
    "Что такое MRO?",
    "Что такое GIL?",
    "Чем staticmethod отличается от classmethod?",
]


def test_curated_overrides_lead_and_are_marked_verified():
    for q in CURATED_QUESTIONS:
        block, meta = kp.build_injection(q)
        assert meta["knowledgeSource"].startswith("curated"), q
        assert "VERIFIED" in block, q


def test_curated_entries_are_say_aloud_length():
    # Both curated packs must stay in the say-aloud budget (SQL entries may run
    # slightly longer: enumerations like JOIN types need a few extra words).
    for pack_dir, cap in ((kp.PACK_DIR, 95), (kp.SQL_PACK_DIR, 130)):
        for entry in kp._load_curated_for(pack_dir):
            words = len(entry["answer"].split())
            assert 20 <= words <= cap, f"{pack_dir.name}/{entry['id']}: {words} words"


def test_community_only_when_no_curated_match():
    # A Python question with no curated entry still works from the community pack.
    _, meta = kp.build_injection("Что такое list comprehension?")
    assert meta["knowledgePackUsed"] is True
    assert meta["knowledgeSource"] in ("community", "curated+community", "curated")
