import pytest

from app.services.screen_task_pipeline import _generate_code_answer
from app.services.screen_task_state import (
    ScreenCodeLanguage,
    ScreenResponseKind,
    ScreenTaskRequirements,
    ScreenTaskState,
    ScreenTaskTtl,
    SqlStatementKind,
    TaskKind,
)


@pytest.mark.asyncio
async def test_sql_repair_preserves_sql_profile():
    state = ScreenTaskState(
        task_kind=TaskKind.CODE,
        response_kind=ScreenResponseKind.CODE_SOLUTION,
        requirements=ScreenTaskRequirements(
            objective="Вывести название страны",
            code_language=ScreenCodeLanguage.SQL,
            expected_sql_statement_kind=SqlStatementKind.SELECT,
            required_sql_identifiers=("Countries", "name"),
            required_sql_clauses=("select", "from"),
        ),
        ttl=ScreenTaskTtl(created_at_ms=1000, updated_at_ms=1000, expires_at_ms=61000),
    )
    calls = []

    async def complete(messages, *args, **kwargs):
        calls.append(messages)
        if len(calls) == 1:
            return "Некорректный ответ без SQL"
        prompt = messages[-1]["content"]
        assert "Emit exactly one SQL statement" in prompt
        assert "Emit exactly one target function" not in prompt
        return "Выведем название страны.\n\n```sql\nSELECT name FROM Countries;\n-- Выводим название страны.\n```"

    answer = await _generate_code_answer(
        state=state,
        latest_correction="",
        provider="openrouter",
        model="test",
        max_tokens=1000,
        reasoning=None,
        complete=complete,
    )
    assert "SELECT name FROM Countries" in answer
    assert len(calls) == 2
