# Python Knowledge Pack

Auxiliary reference knowledge base for **pure-Python** interview questions.

- **Source:** [yakimka/python_interview_questions](https://github.com/yakimka/python_interview_questions)
- **License:** MIT
- **Quality:** `community_unverified` — answers may contain inaccuracies.

## How it is used

This pack is **not** the primary source of answers. Skillcue is a QA Automation /
Python assistant; this pack is consulted **only** when the current question is a
pure-Python language question (not a QA-Automation topic like Pytest, Playwright,
API, CI/CD, Docker). At answer time only the **top 1–3 matched records** are
injected (capped to ~800–1200 tokens) — the full `source/questions.md` is never
put into a prompt. On any conflict, QA Automation context and the candidate
resume take precedence, and answers are normalized to the Skillcue say-aloud
format rather than copied verbatim.

## Files

- `source/questions.md` — original source (committed for provenance; not injected).
- `index.json` — lightweight retrieval index (id, question, topic, tags, priority, keywords).
- `answers.json` — per-record question + answer.
- `metadata.json` — pack metadata.

Regenerate after updating the source:

```
python scripts/build_python_pack.py
```
