"""Concrete overlay tasks keep complete code while theory stays say-aloud."""

from app.prompts.interview_fast import FAST_CORE_SYSTEM_PROMPT, build_fast_core_user_prompt
from app.routers.chat import SCREEN_ASSIST_PROMPT, _answer_language_block, _finalize_live_spoken
from app.services import domain_answer_hints
from app.services.domain_answer_hints import (
    resolve_domain_answer_hints,
    resolve_fast_domain_answer_hints,
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


def test_fast_implementation_prompt_requires_a_spoken_plan_and_terse_line_comments():
    prompt = build_fast_core_user_prompt(
        "Напиши декоратор, который замеряет время функции с args и kwargs.",
        "technical_task",
    )
    combined = FAST_CORE_SYSTEM_PROMPT + prompt
    assert "one short spoken plan before the code" in combined
    assert "brief inline comment on every meaningful code line" in combined
    assert "imports, decorators, def lines, branches, calls, and returns" in prompt


def test_russian_output_language_also_applies_to_inline_code_comments():
    language_block = _answer_language_block("ru")
    assert "natural-language code comments" in language_block
    assert "same output language" in language_block


def test_report_asr_aliases_are_resolved_locally_without_an_extra_model_call():
    assert domain_answer_hints.resolve_fast_question_alias(
        "Каки ти подадна в Питоните знаеш."
    ) == "Какие типы данных в Python ты знаешь?"
    assert domain_answer_hints.resolve_fast_question_alias(
        "Сорт, точка сорт применяется?"
    ) == "В чём разница между sorted() и list.sort()?"
    assert domain_answer_hints.resolve_fast_question_alias(
        "Расскажи, пожалуйста, в чём разница между sort и sorted."
    ) == "В чём разница между sorted() и list.sort()?"
    ambiguous_design = "Дизайны, которые ты используешь. Я использую на своей работе."
    assert domain_answer_hints.resolve_fast_question_alias(ambiguous_design) == ambiguous_design
    explicit_test_design = (
        "Опиши, пожалуйста, технику тест-дизайна, которую ты используешь на своей работе."
    )
    assert (
        domain_answer_hints.resolve_fast_question_alias(explicit_test_design)
        == explicit_test_design
    )
    assert domain_answer_hints.resolve_fast_question_alias(
        "ОПО, который ты используешь на своей работе."
    ) == "ООП, который ты используешь на своей работе."
    assert domain_answer_hints.resolve_fast_question_alias(
        "Можешь сказать, вот... Написать, можешь сказать, вот... Написать, точнее, "
        "мне функцию сейчас, декоратор, который принимает аргсы, кварксы и считает, "
        "сколько времени выполняется сама функция."
    ) == (
        "Напиши декоратор на Python, который принимает функцию с args и kwargs, "
        "замеряет время выполнения и возвращает результат."
    )


def test_spoken_sorted_alias_gets_verified_python_facts():
    hint = resolve_fast_domain_answer_hints("Сорт, точка сорт применяется?")
    assert "sorted(iterable) returns a new list" in hint
    assert "list.sort() mutates that list in place and returns None" in hint


def test_fast_cicd_hint_does_not_supply_unconfirmed_ci_vendor_names():
    hint = resolve_fast_domain_answer_hints(
        "Как ты настраивал YAML-файл? Как ты настраивал CI/CD у себя на работе?"
    )
    assert "GitLab CI" not in hint
    assert "Jenkins" not in hint


def test_russian_live_answer_removes_english_prompt_scaffolding_labels():
    answer = (
        "Decisive difference: sort меняет список на месте, sorted возвращает новый. "
        "Enforced: Docker Compose создаёт сети. Convention: имена сервисов задаются в YAML. "
        "Mechanism: конфигурация применяется декларативно."
    )
    finalized = _finalize_live_spoken(answer, "technical_definition")
    for leaked_label in ("Decisive difference", "Enforced:", "Convention:", "Mechanism:"):
        assert leaked_label not in finalized
    assert "Главное отличие:" in finalized


def test_fast_oop_usage_hint_is_grounded_in_python_ui_test_automation():
    hint = resolve_fast_domain_answer_hints("ООП, который ты используешь на своей работе.")
    for expected in ("Python", "Page Object", "локатор", "UI"):
        assert expected in hint
    assert "Singleton" not in hint
    assert "Observer" not in hint


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


def test_screen_code_contract_is_copyable_and_say_aloud_in_russian():
    for required in (
        "одним fenced Markdown-блоком",
        "После КАЖДОЙ непустой содержательной строки кода",
        "короткий комментарий на русском",
        "ОТДЕЛЬНОЙ СТРОКОЙ сразу под ней",
        "Никогда не ставь пояснение справа",
        "без пустых строк между",
        "полное обновлённое решение, а не diff",
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
