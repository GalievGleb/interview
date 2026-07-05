"""Prompt for building the per-candidate profile pack.

The pack replaces what used to be a hardcoded candidate biography inside the
live system prompt: a compact, reusable block distilled from the user's OWN
resume / legend / vacancy. It is generated once per document change (cached in
AppMeta by source hash) and injected into every live answer prompt, so it must
be dense, factual, and safe to follow verbatim under live-interview latency.
"""

PROFILE_BUILD_PROMPT = """You are preparing a compact CANDIDATE PROFILE PACK for a live interview copilot.
The copilot answers interview questions AS the candidate, so the pack must contain only facts the candidate can safely say out loud.

Sources (the ONLY allowed facts — never invent tools, companies, dates, metrics, team sizes):
<RESUME>
{resume}
</RESUME>

<LEGEND>
{legend}
</LEGEND>
LEGEND = the candidate's agreed self-presentation (framing, emphasis). It supplements the resume and must never contradict it. If "(none)", skip legend-related lines.

<VACANCY>
{vacancy}
</VACANCY>
VACANCY is context for what will be asked. If "(none)", skip vacancy-related lines.

Write the pack in {language}. Output PLAIN TEXT ONLY (no markdown headers, no code fences) with EXACTLY these sections in this order:

CANDIDATE PROFILE:
- One line: role, seniority, domain, years of experience (only if stated).
- Core stack: the tools/technologies the resume actually confirms, most-used first.
- For each job/project in the resume (newest first, max 4): «Company/project — role — 1-2 concrete duties — key tools». Keep each to one line.

STRICT FACTS (never violate, never move facts between companies):
- List every number, metric, headcount, or scope claim that appears in the resume/legend EXACTLY as stated, each with the company it belongs to.
- For shared/inherited artifacts (an existing test suite, infrastructure someone else built, a team's codebase) add: «say 'поддерживал/развивал', never claim sole authorship».
- If the resume gives NO numbers, write: «No exact metrics in resume — never invent percentages, counts, or team sizes».

LIKELY GAPS (tools/topics the vacancy needs that the resume does NOT confirm):
- Up to 6 items. For each: «X — no confirmed experience; closest real experience: Y» (Y from the resume). If no vacancy given, derive gaps from what's adjacent to the candidate's stack.

LEGEND NOTES (only if a legend is provided):
- 2-4 lines: how the candidate frames their experience (emphasis, transitions, how to present career moves), consistent with the resume.

DOMAIN ANSWER EXAMPLES:
- Exactly 2 short examples of spoken answers in the candidate's real domain and stack, each 40-70 words, first person, natural spoken style:
  1) «Расскажи про свой опыт» — role + stack + 1-2 concrete duties from the resume.
  2) A missing-experience answer for the most likely gap: honest «напрямую с этим не работал» + closest real experience + willingness to learn. Confident, not apologetic.

Hard rules:
- Total length under 450 words. No filler, no advice, no commentary — only the pack.
- Every fact must be traceable to the resume or legend. When unsure, leave it out.
- Do not include the vacancy's requirements as the candidate's experience."""

PROFILE_PACK_HEADER = (
    "CANDIDATE PROFILE PACK (distilled from the candidate's own documents — "
    "the authoritative source of personal facts; follow STRICT FACTS exactly):"
)

# Injected instead of the pack when generation hasn't happened yet: the model
# must lean on the raw RESUME/LEGEND blocks and stay conservative about facts.
PROFILE_PACK_FALLBACK = (
    "CANDIDATE PROFILE PACK: (not generated yet — rely ONLY on the RESUME and "
    "LEGEND blocks above for personal facts; if they are empty, answer theory "
    "confidently but make NO personal-experience claims at all)"
)
