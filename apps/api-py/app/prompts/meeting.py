import re


def _effective_language(transcript: str, answer_language: str | None) -> str:
    if answer_language in {"ru", "en"}:
        return answer_language
    cyrillic = len(re.findall(r"[А-Яа-яЁё]", transcript))
    latin = len(re.findall(r"[A-Za-z]", transcript))
    return "ru" if cyrillic >= latin else "en"


def _language_contract(answer_language: str | None) -> str:
    if answer_language == "ru":
        return (
            "Пиши весь обычный текст по-русски. Названия API, библиотек, команд и "
            "фрагменты кода оставляй в общепринятом техническом написании."
        )
    if answer_language == "en":
        return "Write all prose and headings in English."
    return "Use the dominant language of the transcript."


def build_meeting_prompt(transcript: str, answer_language: str | None) -> str:
    answer_language = _effective_language(transcript, answer_language)
    if answer_language == "ru":
        sections = """## Кратко
3–6 коротких пунктов о том, что обсуждали.

## Что решили
Только явно принятые решения. Если решений нет: «Явных решений не было».

## Что сделать
- [ ] исполнитель — задача — срок, только если это прозвучало

## Открытые вопросы
Что осталось без ответа или требует уточнения."""
    else:
        sections = """## Summary
3–6 concise bullets.

## Decisions
Only explicit decisions.

## Action Items
- [ ] owner — task — due, only when stated

## Open Questions
Unresolved questions."""
    return f"""Mode: MEETING SUMMARY

Transcript:
<TRANSCRIPT>
{transcript}
</TRANSCRIPT>

{_language_contract(answer_language)}

{sections}

Use only the transcript. Never invent owners, deadlines, decisions, or facts.
"""


def build_interview_review_prompt(transcript: str, answer_language: str | None) -> str:
    answer_language = _effective_language(transcript, answer_language)
    if answer_language == "en":
        sections = """## Conclusion
2–4 bullets describing the candidate's overall level and main problems.

## Problem Areas
For every weak answer, provide the question, what the candidate said, the exact
problem, and a concrete stronger answer in 2–4 sentences.

## Strengths
1–3 moments where the candidate answered well, if any.

## What to Improve
3–6 precise topics or skills derived from the gaps above."""
    else:
        sections = """## Итог
2–4 пункта: общий уровень кандидата и главные проблемы.

## Проблемные места
Для КАЖДОГО слабого ответа кандидата — блок (от самого серьёзного к менее):
- **Вопрос:** какой вопрос задали (перефразируй, если нужно)
- **Что сказал кандидат:** короткая цитата/пересказ его реальных слов
- **Проблема:** что именно не так (ошибка / неполнота / расплывчато / устарело / противоречие / red flag)
- **Как лучше:** правильный/сильный ответ в 2–4 предложениях, конкретно и технически

## Сильные стороны
1–3 момента, где кандидат ответил хорошо (если есть).

## Что подтянуть
3–6 конкретных тем/навыков из пробелов выше (называй точный концепт, не «учите Python»)."""

    return f"""Mode: INTERVIEW REVIEW — разбор ответов кандидата.

You are a senior technical interviewer and mentor (QA / SDET / Python / backend).
Below is a transcript of a REAL technical interview. Wording can be rough and
speaker labels may be missing.

Transcript:
<TRANSCRIPT>
{transcript}
</TRANSCRIPT>

{_language_contract(answer_language)}

Identify the candidate as the person answering the technical questions. Review
only that person's answers for factual errors, incompleteness, vague claims,
outdated information, contradictions, and explicit knowledge gaps.

{sections}

Use only the transcript. Never invent answers or evidence. Quote the candidate
briefly so the reviewed moment is recognizable. Be direct, constructive, and
technically specific.
"""
