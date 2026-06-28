"""Prompts for Vacancy Smoke Review (analysis + answer evaluation).

Both return STRICT JSON whose shape matches the desktop types
(InterviewTopic / SmokeAnswerEvaluation). The desktop falls back to a
deterministic mock if the model is unavailable or the JSON can't be parsed.
"""

VACANCY_ANALYZE_PROMPT = """You analyze a real job vacancy to prepare a candidate for THIS specific interview.

Output STRICT JSON ONLY (no markdown, no prose, no code fences) with exactly this shape:
{{
  "targetRole": "string",
  "seniorityLevel": "intern|junior|middle|senior|lead|unknown",
  "extractedRequirements": ["must-have hard skill", "..."],
  "optionalSkills": ["nice-to-have", "..."],
  "interviewTopics": [
    {{
      "title": "short topic name",
      "category": "Language|Testing|Data|Infrastructure|Tools|Engineering|Soft skills|Experience",
      "importance": "high|medium|low",
      "expectedKnowledge": "one sentence: what a candidate must be able to explain",
      "sampleQuestions": ["question 1", "question 2"],
      "vacancyEvidence": "the exact phrase from the vacancy this topic comes from"
    }}
  ],
  "projectQuestions": ["question about real project experience"],
  "riskAreas": ["short warning"]
}}

Rules:
- Topics MUST be derived from THIS vacancy. Use real phrases from the vacancy as vacancyEvidence. NEVER output generic skills like "System design", "Algorithms", "Frontend" unless the vacancy explicitly requires them.
- 5–10 topics, ordered by importance (high first). 2–4 sampleQuestions per topic.
- Always include a "Project experience" topic and (if a real role) a "Behavioral questions" topic.
- All generated text (titles, questions, knowledge, warnings) MUST be in {language}.
- If resume/legend are missing or thin, add a riskArea about missing grounding.

VACANCY:
{vacancy}

RESUME (optional, may be empty):
{resume}

INTERVIEW LEGEND (optional, may be empty):
{legend}

Return ONLY the JSON object."""


VACANCY_EVALUATE_PROMPT = """You evaluate a candidate's interview answer for one topic of a specific vacancy.

Output STRICT JSON ONLY (no markdown, no code fences) with exactly this shape:
{{
  "score": 0,
  "clarityScore": 0,
  "technicalAccuracyScore": 0,
  "specificityScore": 0,
  "confidenceScore": 0,
  "feedback": "1-2 sentences, direct",
  "missingPoints": ["what was missing"],
  "goodPoints": ["what was good"],
  "suggestedBetterAnswer": "a short, say-aloud stronger answer",
  "overclaimed": false
}}

Scoring (0–100 each, score = overall):
- technicalAccuracy: correctness for the topic.
- specificity: concrete tools, actions, real project examples (not generic).
- clarity: structured, easy to follow.
- confidence: assured but honest (hedging like "не знаю/наверное" lowers it).
Rules:
- "overclaimed" = true ONLY if the answer claims hands-on production experience NOT supported by the resume. hasResume={has_resume}.
- NEVER invent experience for the candidate. If they lack direct experience, "suggestedBetterAnswer" MUST use an honest bridging answer, e.g. "В продакшене глубоко с этим не работал, но понимаю идею и могу объяснить, как бы подошёл".
- All generated text MUST be in {language}.

TOPIC: {topic}
EXPECTED SIGNALS: {signals}
QUESTION: {question}
CANDIDATE ANSWER: {answer}

Return ONLY the JSON object."""
