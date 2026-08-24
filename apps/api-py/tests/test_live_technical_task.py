"""Concrete overlay tasks keep complete code while theory stays say-aloud."""

from app.prompts.interview_fast import FAST_CORE_SYSTEM_PROMPT, build_fast_core_user_prompt
from app.routers.chat import SCREEN_ASSIST_PROMPT, _finalize_live_spoken
from app.services.domain_answer_hints import (
    resolve_domain_answer_hints,
    resolve_required_output_contract,
)


def test_fast_core_prompt_is_small_and_question_only():
    prompt = build_fast_core_user_prompt(
        "Что такое генератор?",
        "technical_definition",
        "\nOUTPUT LANGUAGE: Russian",
    )
    combined = FAST_CORE_SYSTEM_PROMPT + prompt
    assert "Что такое генератор?" in prompt
    assert len(combined) < 1800
    for forbidden in ("DOMAIN-SPECIFIC", "KNOWLEDGE PACK", "CANDIDATE PROFILE", "RESUME"):
        assert forbidden not in combined


def test_fast_core_theory_cap_is_70_words():
    answer = " ".join(f"слово{i}." for i in range(120))
    finalized = _finalize_live_spoken(answer, "technical_definition", spoken_cap=70)
    assert len(finalized.split()) <= 70


def test_technical_task_is_not_cut_and_keeps_code_indentation():
    code_lines = [f"value_{i} = {i}  # line {i}" for i in range(60)]
    code_lines += ["def result():", "    if True:", "        return value_59"]
    answer = "```python\n" + "\n".join(code_lines) + "\n```\nКод создаёт значения по порядку."
    finalized = _finalize_live_spoken(answer, "technical_task")
    assert "value_59 = 59" in finalized
    assert "def result():\n    if True:\n        return value_59" in finalized
    assert finalized.endswith("Код создаёт значения по порядку.")


def test_theory_code_example_also_keeps_indentation_and_comments():
    answer = "Правильный вариант:\n```python\ndef f(items=None):\n    if items is None:\n        items = []  # новый список\n    return items\n```"
    finalized = _finalize_live_spoken(answer, "technical_definition")
    assert "    if items is None:" in finalized
    assert "        items = []  # новый список" in finalized


def test_theory_answer_keeps_spoken_cap():
    answer = " ".join(f"слово{i}." for i in range(130))
    finalized = _finalize_live_spoken(answer, "technical_definition")
    assert len(finalized.split()) <= 90


def test_screen_output_task_preserves_python_semantics():
    for required in (
        "НЕ переписывай",
        "весь stdout, который успел появиться ДО исключения",
        "первого необработанного исключения",
        "строка '7' не равна числу 7",
        "s[0] = 'H' вызывает TypeError",
    ):
        assert required in SCREEN_ASSIST_PROMPT


def test_named_fixture_example_gets_complete_verified_order():
    hint = resolve_domain_answer_hints(
        "Как определить порядок session_fixture и fixture_1, которая зависит от fixture_3?"
    )
    sequence = (
        "session_fixture → module_fixture → autouse_fixture → fixture_3 → "
        "fixture_4 setup (up to yield) → fixture_1 → fixture_2 → test_order → "
        "fixture_4 teardown"
    )
    assert sequence in hint


def test_concrete_last_order_hint_demands_contract_specific_checks():
    hint = resolve_domain_answer_hints("Как протестировать API endpoint last_order?")
    for expected in ("200", "404", "400/422", "401", "403", "order_price", "latest"):
        assert expected in hint
    final_contract = resolve_required_output_contract("GET /client/last_order")
    assert "non-negotiable" in final_contract
    assert "include ALL" in final_contract
