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
