import pytest
from pydantic import ValidationError
from app.routers.chat import InterviewPayload
from app.services.fast_candidate_context import build_candidate_context, build_recent_turns_context, needs_personal_context


def test_independent_source_budgets_keep_projects_with_long_resume():
    context = build_candidate_context('R' * 4000, 'Synthetic project Orion', 'Manual profile')
    assert 'R' * 3200 in context
    assert 'R' * 3201 not in context
    assert 'SELECTED RESUME' in context
    assert 'PROJECT / PROFILE FACTS' in context
    assert 'Synthetic project Orion' in context
    assert 'Manual profile' in context


def test_followup_uses_prior_project_but_unrelated_theory_does_not():
    turns = [{'question': 'Tell me about your last project', 'answer': 'I invented a giant team'}]
    assert needs_personal_context('What did you do there?', 'general', turns)
    assert not needs_personal_context('What is TCP?', 'general', turns)
    context = build_recent_turns_context(turns)
    assert 'not confirmed experience' in context
    assert 'I invented a giant team' in context


@pytest.mark.parametrize('question', [
    'А какие техники тест-дизайна ты там применял?',
    'А почему там выбрали это?',
])
def test_last_project_followup_keeps_facts(question):
    turns = [{'question': 'Расскажи про последний проект', 'answer': 'Synthetic answer'}]
    assert needs_personal_context(question, 'general', turns)
    assert not needs_personal_context('Что такое TCP?', 'general', turns)


@pytest.mark.parametrize('turns', [
    [{'question': 'q', 'answer': 'a'}] * 3,
    [{'question': 'q' * 801, 'answer': 'a'}],
    [{'question': 'q', 'answer': 'a' * 1801}],
])
def test_request_rejects_oversized_history(turns):
    with pytest.raises(ValidationError):
        InterviewPayload(question='next', recent_turns=turns)
