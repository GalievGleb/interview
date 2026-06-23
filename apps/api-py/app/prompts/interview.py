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
  "short":     "1-2 sentence direct answer, grounded in the resume",
  "spoken":    "natural 30-60 second spoken answer, first person, no buzzword soup",
  "detailed":  "deeper version with a concrete example FROM THE CONTEXT only",
  "english":   "the spoken version translated to natural English",
  "risk":      "where this answer could be challenged or where the user lacks real experience; be honest"
}}

Rules:
- Ground every claim in the provided context. If experience is missing for a
  topic, in "risk" state it clearly and in "spoken" use transferable-skill framing
  ("I haven't worked with X directly, but my experience with Y maps to it because...").
- Never claim years, companies, or results not present in the context.
- Respond with ONLY the JSON object, no markdown fences, no extra text.
"""
