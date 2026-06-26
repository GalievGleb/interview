INTERVIEW_REVIEW_PROMPT = """Mode: INTERVIEW REVIEW — разбор ответов кандидата.

You are a senior technical interviewer and mentor (QA / SDET / Python / backend).
Below is a transcript of a REAL technical interview (it may come from an uploaded
recording, so wording can be rough and speaker labels may be missing).

Transcript:
<TRANSCRIPT>
{transcript}
</TRANSCRIPT>

Step 1 — figure out roles. Speakers may be labelled ("Interviewer:", "Candidate:",
"You:", "Я:", "Кандидат:") or not. The CANDIDATE is the person being assessed —
the one ANSWERING the technical questions. If it is ambiguous, treat whoever gives
the technical answers as the candidate.

Step 2 — review ONLY the candidate's answers and find the problem spots: factual
errors, incomplete or shallow answers, vague hand-waving, outdated info,
self-contradiction, or red flags (e.g. "не знаю", "не сталкивался", guessing).

Output Markdown in the transcript's language (если транскрипт на русском — по-русски):

## Итог
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
3–6 конкретных тем/навыков из пробелов выше (называй точный концепт, не «учите Python»).

Rules:
- Опирайся ТОЛЬКО на транскрипт. Не выдумывай ответы, которых кандидат не давал.
- Цитируй реальные слова кандидата (коротко), чтобы он узнал момент.
- Будь конкретным и техническим, прямым но конструктивным.
"""


MEETING_PROMPT = """Mode: MEETING SUMMARY

Transcript:
<TRANSCRIPT>
{transcript}
</TRANSCRIPT>

Produce Markdown with these sections:

## Summary
3-6 bullet points of what was discussed.

## Decisions
Concrete decisions made. If none, write "No explicit decisions."

## Action Items
- [ ] owner — task — due (if mentioned)
Only include items actually stated. Do not invent owners or deadlines.

## Open Questions
Questions raised but not resolved, or that should be clarified.

Rules:
- Use only what is in the transcript. Mark uncertain attributions as "(unclear)".
- Keep it skimmable. Output language = transcript language.
"""
