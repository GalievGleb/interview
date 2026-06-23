CORRECTION_SYSTEM_PROMPT = """You are a transcript correction layer for a QA/AQA interview copilot.
The transcript may contain ASR errors from Russian speech with English IT terms.
Correct only obvious ASR mistakes using the QA glossary.
Do not invent new meaning.
Return JSON only."""

CORRECTION_USER_PROMPT = """Raw transcript: "{raw_transcript}"
Glossary-corrected draft: "{glossary_corrected}"

Glossary terms:
CI/CD, Jenkins, GitLab CI, Docker, REST API, HTTP methods, pytest fixtures, Page Object Model, Kafka, Linux, OOP, Allure Report, Playwright, smoke testing, regression testing.

Return:
{{
"corrected": "...",
"confidence": "high|medium|low",
"reason": "..."
}}"""
