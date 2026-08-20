import pytest

from app.routers import providers


@pytest.mark.asyncio
async def test_readiness_performs_real_completion_and_validates_answer(monkeypatch):
    captured: dict[str, object] = {}

    async def complete(messages, provider, model, **kwargs):
        captured.update(
            messages=messages,
            provider=provider,
            model=model,
            kwargs=kwargs,
        )
        return (
            "Техники тест-дизайна помогают системно выбирать проверки. "
            "Например, классы эквивалентности сокращают набор данных, "
            "а анализ граничных значений проверяет поведение около границ."
        )

    monkeypatch.setattr(providers.provider_adapter, "complete", complete)

    result = await providers.readiness(providers.ReadinessPayload(model="openai/gpt-4o-mini"))

    assert result["ok"] is True
    assert result["model"] == "openai/gpt-4o-mini"
    assert result["question"].startswith("Что такое техники тест-дизайна?")
    assert captured["provider"] == "openrouter"
    assert captured["model"] == "openai/gpt-4o-mini"


@pytest.mark.asyncio
async def test_readiness_rejects_empty_or_irrelevant_provider_answer(monkeypatch):
    async def complete(*_args, **_kwargs):
        return "Всё работает."

    monkeypatch.setattr(providers.provider_adapter, "complete", complete)

    result = await providers.readiness(providers.ReadinessPayload(model="openai/gpt-4o-mini"))

    assert result["ok"] is False
    assert result["matched_concepts"] == []
