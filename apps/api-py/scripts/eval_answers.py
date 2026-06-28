"""Answer-quality eval harness.

Generates a real live answer for each golden question and scores it structurally
(length, no ChatGPT tails / internal labels, required terms present) with
app.services.answer_quality. Catches answer-quality regressions that unit tests
can't (they don't call the model).

Needs a configured LLM provider (API key / .env). Run on demand, not in CI:

    cd apps/api-py
    python scripts/eval_answers.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.prompts.interview_fast import INTERVIEW_PROMPT_STREAM, LIVE_SYSTEM_PROMPT  # noqa: E402
from app.services import provider_adapter  # noqa: E402
from app.services.answer_quality import score_spoken_answer  # noqa: E402
from app.services.domain_answer_hints import resolve_domain_answer_hints  # noqa: E402
from app.services.knowledge_pack import build_injection, is_python_question  # noqa: E402
from app.services.question_intent import classify_interview_question_intent  # noqa: E402
from app.services.sanitize_live_answer import sanitize_live_answer, trim_spoken_answer  # noqa: E402

GOLDEN = Path(__file__).resolve().parent.parent / "eval" / "answer_golden.json"


async def _generate(question: str) -> str:
    strategy = classify_interview_question_intent(question)
    prompt = INTERVIEW_PROMPT_STREAM.format(
        resume="(нет)",
        vacancy="(нет)",
        question=question,
        raw_question=question,
        glossary_corrected=question,
        ambiguity="(none)",
        resolved_follow_up_question=question,
        previous_topic="(none)",
        question_intent=strategy["question_intent"],
        answer_strategy=strategy["answer_strategy"],
        resume_context_level=strategy["resume_context_level"],
        resume_context_used=str(strategy["resume_context_used"]).lower(),
        resume_context_reason=strategy["resume_context_reason"],
        domain_hints=resolve_domain_answer_hints(question),
    )
    if is_python_question(question):
        block, _ = build_injection(question)
        if block:
            prompt = f"{prompt}\n\n{block}"
    messages = [
        {"role": "system", "content": LIVE_SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]
    parts: list[str] = []
    async for delta in provider_adapter.stream_chat(messages, None, None, live_fast=True):
        parts.append(delta)
    return trim_spoken_answer(sanitize_live_answer("".join(parts)))


async def main() -> int:
    data = json.loads(GOLDEN.read_text(encoding="utf-8"))
    max_words = data.get("maxWords", 90)
    failures = 0
    for case in data["cases"]:
        q = case["question"]
        try:
            answer = await _generate(q)
        except Exception as exc:  # noqa: BLE001
            print(f"⚠ {q}\n   generation failed: {exc}\n")
            failures += 1
            continue
        score = score_spoken_answer(
            answer, max_words=max_words, required_terms=case.get("requiredTerms")
        )
        mark = "✓" if score.ok else "✗"
        print(f"{mark} [{score.word_count}w] {q}")
        if not score.ok:
            failures += 1
            if score.forbidden_phrases:
                print(f"   forbidden: {score.forbidden_phrases}")
            if score.internal_labels:
                print(f"   labels: {score.internal_labels}")
            if score.missing_terms:
                print(f"   missing terms: {score.missing_terms}")
            if not score.within_word_limit:
                print(f"   too long: {score.word_count} > {max_words}")
            if score.starts_with_filler:
                print("   starts with filler opener")
        print(f"   {answer}\n")

    print(f"\n{len(data['cases']) - failures}/{len(data['cases'])} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
