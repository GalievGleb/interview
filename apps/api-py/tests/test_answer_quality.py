"""Tests for the deterministic Say-aloud answer scorer (used by the eval harness)."""

from app.services.answer_quality import score_spoken_answer


def test_clean_answer_scores_ok():
    good = (
        "CI/CD я настраивал в GitLab: отдельные stages для smoke и regression, "
        "Docker для одинакового окружения, запуск pytest и Allure-отчёты с артефактами."
    )
    q = score_spoken_answer(good, max_words=90, required_terms=["docker", "allure"])
    assert q.ok
    assert q.forbidden_phrases == []
    assert q.missing_terms == []


def test_flags_forbidden_tail():
    q = score_spoken_answer("POM — это паттерн. Если хотите, могу подробнее рассказать.")
    assert q.forbidden_phrases
    assert not q.ok


def test_flags_internal_label():
    q = score_spoken_answer("Main answer: POM — это паттерн.")
    assert q.internal_labels
    assert not q.ok


def test_flags_filler_opening():
    q = score_spoken_answer("Похоже, вопрос про POM. POM — это паттерн.")
    assert q.starts_with_filler
    assert not q.ok


def test_flags_over_length():
    long = " ".join(f"слово{i}" for i in range(130))
    q = score_spoken_answer(long, max_words=90)
    assert not q.within_word_limit
    assert not q.ok


def test_flags_missing_required_terms():
    q = score_spoken_answer("Это просто общий ответ без нужных слов.", required_terms=["docker"])
    assert q.missing_terms == ["docker"]
    assert not q.ok


def test_markdown_header_flagged():
    q = score_spoken_answer("## Заголовок\nтекст ответа")
    assert q.has_markdown_header
    assert not q.ok
