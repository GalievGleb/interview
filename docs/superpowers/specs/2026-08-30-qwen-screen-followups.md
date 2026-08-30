# Qwen live answers and reliable screen follow-ups

## Goal

Make the live overlay use Qwen for automatic fast answers, including resume and practical-experience questions, while making screen tasks explicit and repeatable during a real interview.

## Product contract

- Auto live answers use `qwen/qwen3.5-flash-02-23` for every intent. `openai/gpt-4.1-mini` is not an automatic live primary or hedge. Explicit user-selected models remain untouched.
- Resume context is attached only to experience/practical questions. Common Russian forms such as «расскажите о вашем опыте» must classify as experience.
- `Ctrl+Enter` keeps its current meaning: answer from the conversation. It captures the screen only when the transcript explicitly requests visible context.
- `Ctrl+Shift+Enter` is a global, dedicated «answer from screen» shortcut and works while Zoom, Teams, a browser, or an editor owns focus.
- The natural spoken cue «покажу решение» (including «сейчас покажу решение») followed by `Ctrl+Enter` routes the current turn to the screen without requiring an unnatural phrase.
- A request to improve/change/keep part of the previous screen task is treated as a continuation. The current screenshot remains authoritative, while a bounded previous task/answer block is passed as continuity context. No second model call is added.
- For screen tasks that require writing or modifying code, the answer starts with one fenced code block. Every meaningful non-empty code line contains a short Russian language-valid inline comment, and code lines are not separated by decorative blank lines.
- Questions about output/errors retain the existing behavior: exact output/error first, without rewriting the solution.

## Safety and latency

- Do not route ordinary candidate speech to the screen merely because a prior screen task exists; follow-up detection must require an explicit modification/reference cue.
- Do not add an intent-classifier or formatter LLM call. All routing/continuity decisions are local and deterministic.
- `openai/gpt-4o-mini` may remain only as the existing reliability fallback when Qwen fails or stalls.

