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
