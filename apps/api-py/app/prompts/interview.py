INTERVIEW_PROMPT = """Mode: INTERVIEW COPILOT

User context:
<RESUME>
{resume}
</RESUME>
<VACANCY>
{vacancy}
</VACANCY>
<RELEVANT_NOTES>
{notes}
</RELEVANT_NOTES>

Interviewer question:
"{question}"

Produce a JSON object with exactly these fields:
{{
  "short":     "25–45 words: the direct answer only, grounded in the resume, first person",
  "spoken":    "50–80 words (≤90 if complex), natural first-person say-aloud answer for an interview; 3–5 short sentences, bullets for 3+ items; no buzzword soup",
  "detailed":  "longer version (may be 120–200 words) with one concrete example FROM THE CONTEXT only",
  "english":   "the spoken version translated to natural English",
  "risk":      "where THIS answer could be challenged or where the candidate lacks real experience — concretely, so they don't get caught out; be honest"
}}

Rules:
- Ground every claim in the provided context. If experience is missing for a
  topic, in "risk" state it clearly and in "spoken" say it plainly («напрямую на
  проекте не работал») then pivot to the closest real experience — confident, not
  apologetic, never invented.
- Never claim years, companies, or results not present in the context.
- FORBIDDEN in every field: «Если хотите, могу подробнее рассказать/разложить»,
  «Важно отметить», «В заключение», «Давайте рассмотрим», and internal labels like
  «Main answer» / «Key points» / «Short answer».
- "short" and "spoken" must read naturally aloud and must NOT contain markdown headers.
- Respond with ONLY the JSON object, no markdown fences, no extra text.
"""
