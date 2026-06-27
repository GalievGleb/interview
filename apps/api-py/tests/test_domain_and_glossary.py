"""Regression tests for the new glossary corrections and domain answer hints."""

import importlib

from app.services import domain_answer_hints
from app.services.stt import glossary


def _corrected(text: str) -> str:
    importlib.reload(glossary)
    return glossary.correct_transcript(text)[0]


def test_glossary_geomix_variants():
    assert "ГЕОМИКС" in _corrected("Я работал в гейммикс над автотестами")
    assert "ГЕОМИКС" in _corrected("опыт в гей микс был полезный")


def test_glossary_cicd_variants():
    assert "CI/CD" in _corrected("запускал тесты в си-си-ди")
    assert "CI/CD" in _corrected("настраивал ci-cd на проекте")


def test_glossary_tools():
    assert "Docker" in _corrected("настраивал докер для тестов")
    assert "Allure" in _corrected("смотрел отчёты в алюр")
    assert "pytest" in _corrected("писал пятест на проекте")


def test_glossary_api_pytests():
    assert "API-тесты" in _corrected("писал API-пятесты на бэкенд")


def test_domain_hint_automation_types_is_correct():
    hint = domain_answer_hints.resolve_domain_answer_hints("Какие бывают виды автоматизации?")
    assert "UI" in hint and "API" in hint
    # Must steer the model AWAY from the wrong «ручная автоматизация».
    assert "ручн" in hint.lower()  # the explicit "never say it done вручную" guidance


def test_domain_hint_docker_and_cicd():
    assert "контейнер" in domain_answer_hints.resolve_domain_answer_hints("Как ты настраивал Docker?").lower()
    cicd = domain_answer_hints.resolve_domain_answer_hints("Как ты настраивал CI/CD?")
    assert "stages" in cicd.lower()


def test_domain_hint_smoke_vs_regression():
    hint = domain_answer_hints.resolve_domain_answer_hints("В чём разница smoke и regression?")
    assert "smoke" in hint.lower() and "regression" in hint.lower()


def test_domain_hint_none_for_offtopic():
    assert "none" in domain_answer_hints.resolve_domain_answer_hints("Какая сегодня погода?").lower()
