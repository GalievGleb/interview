"""Tests for the SQL knowledge pack + multi-pack routing."""

from app.services.knowledge_pack import (
    build_injection,
    detect_pack,
    is_sql_question,
)


# --- detection -------------------------------------------------------------
def test_sql_questions_detected():
    assert is_sql_question("Какие виды JOIN бывают?")
    assert is_sql_question("Чем WHERE отличается от HAVING?")
    assert is_sql_question("Что такое транзакция и ACID?")
    assert is_sql_question("Зачем нужны индексы в базе данных?")
    assert is_sql_question("Как найти дубликаты в таблице SQL?")


def test_python_wins_over_sql_on_overlap():
    # «словарь» — питоновский сигнал; вопрос не должен уйти в SQL-пак.
    assert detect_pack("Как устроен словарь в питоне?") == "python"


def test_non_matching_questions_have_no_pack():
    assert detect_pack("Расскажи о своём опыте работы") is None
    assert detect_pack("Как настраивал CI/CD пайплайн?") is None  # QA topic → hints
    assert not is_sql_question("Что такое Page Object Model?")


def test_detect_pack_routes_sql():
    assert detect_pack("Какие виды JOIN бывают?") == "sql"


# --- injection -------------------------------------------------------------
def test_sql_injection_returns_curated_block():
    block, meta = build_injection("Какие виды JOIN бывают?")
    assert meta["knowledgePackUsed"] is True
    assert meta["knowledgePackName"] == "sql_interview_questions"
    assert meta["knowledgeSource"] == "curated"
    assert "SQL KNOWLEDGE PACK" in block
    assert "INNER JOIN" in block


def test_sql_injection_where_having():
    block, meta = build_injection("Чем WHERE отличается от HAVING?")
    assert meta["knowledgePackUsed"] is True
    assert "HAVING" in block
    assert meta["retrievedItemsCount"] >= 1


def test_sql_injection_caps_entries():
    _, meta = build_injection("Что такое индекс и primary key в базе данных?")
    assert meta["retrievedItemsCount"] <= 2  # curated-only pack: max 2 entries


def test_python_injection_still_works():
    block, meta = build_injection("Чем список отличается от кортежа?")
    assert meta["knowledgePackUsed"] is True
    assert meta["knowledgePackName"] == "python_interview_questions"
    assert "PYTHON KNOWLEDGE PACK" in block
