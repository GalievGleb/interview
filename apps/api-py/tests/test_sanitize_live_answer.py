"""Regression tests for the live-answer output sanitizer."""

from app.services.sanitize_live_answer import sanitize_live_answer, trim_spoken_answer

FORBIDDEN = [
    "если хотите, могу подробнее",
    "если хотите, могу разложить",
    "важно отметить",
    "в заключение",
    "давайте рассмотрим",
    "main answer",
    "key points",
    "short answer",
    "в разных контекстах могут быть разные подходы",
    "это позволило мне углубить",
]


def _has_forbidden(text: str) -> list[str]:
    low = text.lower()
    return [p for p in FORBIDDEN if p in low]


def test_strips_internal_labels():
    out = sanitize_live_answer("Main answer: Это паттерн. Key points: scope и conftest.")
    assert "Main answer" not in out
    assert "Key points" not in out
    assert "паттерн" in out
    assert "conftest" in out


def test_strips_markdown_headers_keeps_text():
    out = sanitize_live_answer("## Виды тестирования\nФункциональное и нефункциональное.")
    assert "#" not in out
    assert "Виды тестирования" in out
    assert "Функциональное" in out


def test_strips_chatgpt_tail():
    out = sanitize_live_answer("POM разделяет логику. Если хотите, могу подробнее рассказать.")
    assert "POM разделяет логику" in out
    assert not _has_forbidden(out)


def test_strips_filler_opener_keeps_body():
    out = sanitize_live_answer("Важно отметить, что scope бывает function и session.")
    assert "scope бывает function и session" in out
    assert "Важно отметить" not in out


def test_removes_empty_filler_sentence():
    out = sanitize_live_answer(
        "Я проверял status code и schema. В разных контекстах могут быть разные подходы."
    )
    assert "status code" in out
    assert not _has_forbidden(out)


def test_keeps_technical_answer_untouched():
    text = "CI/CD я настраивал в GitLab: stages, Docker, запуск pytest, Allure-отчёты и артефакты."
    assert sanitize_live_answer(text) == text


def test_trim_caps_word_count_on_sentence_boundary():
    long = " ".join(f"слово{i}" for i in range(120)) + ". Хвост."
    trimmed = trim_spoken_answer(long, 90)
    assert len(trimmed.split()) <= 90


def test_trim_keeps_short_answer():
    text = "Page Object Model — это паттерн для UI-автотестов."
    assert trim_spoken_answer(text, 90) == text
