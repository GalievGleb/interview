import pytest
from pathlib import Path
from app.services import screen_task_pipeline as pipeline

from app.services.screen_task_pipeline import _generate_code_answer, ScreenTaskPipelineError
from app.services.screen_task_state import (
    ScreenCodeLanguage, ScreenResponseKind, ScreenTaskRequirements, ScreenTaskState,
    ScreenTaskTtl, SqlStatementKind, TaskKind,
)

def owner_state():
    return ScreenTaskState(
        task_kind=TaskKind.CODE, response_kind=ScreenResponseKind.CODE_SOLUTION,
        requirements=ScreenTaskRequirements(
            objective='Вывести всех владельцев комнат и заработок.',
            code_language=ScreenCodeLanguage.SQL, expected_sql_statement_kind=SqlStatementKind.SELECT,
            required_sql_identifiers=('owner_id', 'total_earn'), allow_join=True,
        ),
        ttl=ScreenTaskTtl(created_at_ms=1000, updated_at_ms=1000, expires_at_ms=61000),
    )

def test_answer_prompt_requests_russian_explanation_after_each_code_line():
    prompt = pipeline._answer_prompt(owner_state(), '')
    assert 'After every executable code line' in prompt
    assert 'Russian comment on a separate line' in prompt

def test_extractor_preserves_literal_alphabet_and_uses_visible_data():
    prompt = pipeline._observation_prompt(state=None, latest_correction='', context='')
    assert 'Latin B and Cyrillic В' in prompt
    assert 'visible table data' in prompt

def test_solver_handles_visually_ambiguous_class_label_without_guessing_alphabet():
    state = owner_state().model_copy(update={'requirements': owner_state().requirements.model_copy(
        update={'objective': 'Сколько учеников в 10 В классе?', 'required_literals': ('10 В',)})})
    prompt = pipeline._answer_prompt(state, '')
    assert '10 B' in prompt
    assert '10 В' in prompt
    assert 'IN' in prompt

def test_sql_inline_explanations_are_moved_without_changing_strings():
    draft = "Текст\n```sql\nSELECT '-- не комментарий' AS value -- возвращаем строку\nFROM Rooms; -- выбираем комнаты\n```"
    assert pipeline._format_sql_line_comments(draft) == (
        "Текст\n```sql\nSELECT '-- не комментарий' AS value\n-- возвращаем строку\nFROM Rooms;\n-- выбираем комнаты\n```"
    )

def test_sql_formatter_preserves_multiline_literals():
    draft = "```sql\nSELECT 'первая\n-- вторая' AS value;\n```"
    assert pipeline._format_sql_line_comments(draft) == draft

@pytest.mark.asyncio
async def test_sql_extraction_does_not_promote_invented_filters_to_requirements():
    raw = Path(__file__).with_name('fixtures').joinpath('screen_owner_observation.json').read_text('utf-8')
    async def complete(*args, **kwargs):
        return raw
    observation = await pipeline._extract_observation(image='data:image/png;base64,QUJD', state=None,
        latest_correction='', context='', provider='openrouter', model='test', reasoning=None, complete=complete)
    assert 'всех владельцев' in observation.objective
    assert not observation.constraints
    assert observation.required_sql_clauses == []
    assert observation.required_sql_identifiers == ['owner_id', 'total_earn']
    assert all(finding.claim == finding.evidence for finding in observation.findings)

@pytest.mark.asyncio
@pytest.mark.parametrize('intro', ['Суммируем заработок каждого владельца.\n\n', ''])
async def test_correct_owner_query_is_not_discarded_for_missing_presentation(intro):
    draft = intro + '''```sql
SELECT r.owner_id AS owner_id, COALESCE(SUM(res.total), 0) AS total_earn
FROM Rooms r
LEFT JOIN Reservations res ON res.room_id = r.id
GROUP BY r.owner_id;
```'''
    calls = 0
    async def complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        return draft
    result = await _generate_code_answer(state=owner_state(), latest_correction='', provider='openrouter',
        model='test', max_tokens=1000, reasoning=None, complete=complete)
    assert result == draft
    assert calls == 1  # No paid regeneration for a presentation preference.

@pytest.mark.asyncio
async def test_missing_required_output_still_fails_with_issue_diagnostics():
    async def complete(*args, **kwargs):
        return '```sql\nSELECT 1;\n```'
    with pytest.raises(ScreenTaskPipelineError) as error:
        await _generate_code_answer(state=owner_state(), latest_correction='', provider='openrouter',
            model='test', max_tokens=1000, reasoning=None, complete=complete)
    assert 'sql_identifier_missing' in error.value.issue_codes
