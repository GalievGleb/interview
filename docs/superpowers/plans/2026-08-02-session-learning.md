# Russian Recap and Session Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce Russian session results, add an explicit AI assessment after live sessions, persist evidence-based topic scores, and feed weak topics into later live prompts.

**Architecture:** Language-aware prompt builders replace English-shaped recap prompts. A validated `SessionAssessment` record stores one structured analysis per backend session; a backend aggregate and synchronous desktop cache expose weak topics without adding latency to live answer generation.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy/SQLite, pytest, React 19, TypeScript, Vitest, SSE/JSON LLM calls.

## Global Constraints

- Russian answer language means Russian headings and prose; conventional technical identifiers may remain English.
- Analysis is started only by the user's `Разобрать сессию` action.
- The model may use only persisted session transcript evidence.
- Invalid structured output gets one repair attempt and never overwrites a valid saved assessment.
- A full standalone knowledge-map page is outside this release.
- Preserve unrelated dirty-worktree changes and stage only task files.

---

### Task 1: Language-aware meeting summary and review prompts

**Files:**
- Modify: `apps/api-py/app/prompts/meeting.py`
- Modify: `apps/api-py/app/routers/chat.py:110-135,683-790`
- Modify: `apps/api-py/tests/test_chat_review.py`
- Modify: `apps/desktop/src/lib/api.ts:874-925`

**Interfaces:**
- Consumes: `answer_language` (`ru`, `en`, or absent) and transcript text.
- Produces: `build_meeting_prompt(transcript, answer_language)` and `build_interview_review_prompt(transcript, answer_language)`.

- [ ] **Step 1: Add failing Russian-language prompt tests**

```py
def test_meeting_summary_russian_language_uses_russian_headings(client, monkeypatch):
    captured = {}

    async def fake_stream(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        yield "## Кратко\n- Обсудили API."

    monkeypatch.setattr(provider_adapter, "stream_chat", fake_stream)
    response = client.post(
        "/chat/meeting-summary/stream",
        json={"transcript": "Интервьюер: Что такое API?", "answer_language": "ru"},
    )
    assert response.status_code == 200
    assert "## Кратко" in captured["prompt"]
    assert "## Summary" not in captured["prompt"]
    assert "Пиши весь обычный текст по-русски" in captured["prompt"]


def test_interview_review_russian_language_is_explicit(client, monkeypatch):
    captured = {}

    async def fake_complete(messages, provider=None, model=None, **kwargs):
        captured["prompt"] = messages[-1]["content"]
        return "## Итог\nОтвет поверхностный."

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    response = client.post(
        "/chat/interview-review",
        json={"transcript": "Кандидат: Не знаю.", "answer_language": "ru"},
    )
    assert response.status_code == 200
    assert "Пиши весь обычный текст по-русски" in captured["prompt"]
```

- [ ] **Step 2: Run the focused backend tests and verify failure**

Run: `apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_chat_review.py -q`

Expected: the new assertions FAIL because `MeetingPayload` ignores `answer_language` and the meeting prompt contains English headings.

- [ ] **Step 3: Implement localized prompt builders**

```py
def _language_contract(answer_language: str | None) -> str:
    if answer_language == "ru":
        return (
            "Пиши весь обычный текст по-русски. Названия API, библиотек, команд и "
            "фрагменты кода оставляй в общепринятом техническом написании."
        )
    if answer_language == "en":
        return "Write all prose and headings in English."
    return "Use the dominant language of the transcript."


def build_meeting_prompt(transcript: str, answer_language: str | None) -> str:
    if answer_language == "ru":
        sections = """## Кратко
3–6 коротких пунктов о том, что обсуждали.

## Что решили
Только явно принятые решения. Если решений нет: «Явных решений не было».

## Что сделать
- [ ] исполнитель — задача — срок, только если это прозвучало

## Открытые вопросы
Что осталось без ответа или требует уточнения."""
    else:
        sections = """## Summary
3–6 concise bullets.

## Decisions
Only explicit decisions.

## Action Items
- [ ] owner — task — due, only when stated

## Open Questions
Unresolved questions."""
    return f"""Mode: MEETING SUMMARY

Transcript:
<TRANSCRIPT>
{transcript}
</TRANSCRIPT>

{_language_contract(answer_language)}

{sections}

Use only the transcript. Never invent owners, deadlines, decisions, or facts.
"""
```

Apply the same language contract to `build_interview_review_prompt`. Add
`answer_language: str | None = None` to `MeetingPayload` and call the builders in all
four summary/review endpoints.

In desktop `streamMeetingSummary` and `streamInterviewReview`, include
`answer_language: answerLanguageParam()` in the request body.

- [ ] **Step 4: Run backend tests and desktop typecheck**

Run:

```powershell
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_chat_review.py -q
pnpm --filter @interview/desktop typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit localized recap prompts**

```powershell
git add apps/api-py/app/prompts/meeting.py apps/api-py/app/routers/chat.py apps/api-py/tests/test_chat_review.py apps/desktop/src/lib/api.ts
git commit -m "fix: keep session results in the answer language"
```

### Task 2: Structured session-assessment persistence

**Files:**
- Modify: `apps/api-py/app/db/models.py`
- Create: `apps/api-py/app/services/session_analysis.py`
- Modify: `apps/api-py/app/routers/sessions.py`
- Create: `apps/api-py/tests/test_session_analysis.py`

**Interfaces:**
- Consumes: persisted `InterviewSession.transcripts`, `answer_language`, automatic deep model routing.
- Produces: `SessionAssessmentPayload`, `analyze_session(db, session, language)`, `POST /sessions/{id}/analysis`, and `GET /sessions/{id}/analysis`.

- [ ] **Step 1: Write failing persistence and validation tests**

```py
import json

from app.services import provider_adapter


VALID_ANALYSIS = {
    "overallLevel": "Middle",
    "conclusion": "Хорошо понимает API, но ответ по тест-дизайну неполный.",
    "strengths": [
        {"topic": "API-тестирование", "evidence": "Проверяю JSON и схему ответа."}
    ],
    "weaknesses": [
        {
            "topic": "Техники тест-дизайна",
            "evidence": "Кандидат назвал только классы эквивалентности.",
            "learningAction": "Повторить граничные значения, таблицы решений и pairwise.",
        }
    ],
    "topicAssessments": [
        {"topic": "Техники тест-дизайна", "score": 42, "confidence": 0.9}
    ],
    "markdown": "## Итог\nНужно усилить техники тест-дизайна.",
}


def _completed_session(client):
    session_id = client.post("/sessions", json={"mode": "interview"}).json()["id"]
    client.post(
        f"/sessions/{session_id}/transcript",
        json={"speaker": "other", "text": "Какие техники тест-дизайна?"},
    )
    client.post(
        f"/sessions/{session_id}/transcript",
        json={"speaker": "me", "text": "Классы эквивалентности."},
    )
    client.post(f"/sessions/{session_id}/end", json={})
    return session_id


def test_session_analysis_is_validated_persisted_and_reused(client, monkeypatch):
    calls = 0

    async def fake_complete(*args, **kwargs):
        nonlocal calls
        calls += 1
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    first = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
    second = client.get(f"/sessions/{session_id}/analysis")

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["weaknesses"][0]["topic"] == "Техники тест-дизайна"
    assert calls == 1


def test_invalid_analysis_gets_one_repair_attempt(client, monkeypatch):
    replies = iter(["not json", json.dumps(VALID_ANALYSIS, ensure_ascii=False)])

    async def fake_complete(*args, **kwargs):
        return next(replies)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    response = client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
    assert response.status_code == 200
```

- [ ] **Step 2: Run the new backend test and verify failure**

Run: `apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_session_analysis.py -q`

Expected: FAIL with 404 for the missing endpoints.

- [ ] **Step 3: Add the database record and Pydantic schema**

```py
class SessionAssessment(Base):
    __tablename__ = "session_assessments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), unique=True, index=True
    )
    language: Mapped[str] = mapped_column(String, default="ru")
    analysis_json: Mapped[str] = mapped_column(Text)
    markdown: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
```

```py
class TopicEvidence(BaseModel):
    topic: str = Field(min_length=2, max_length=120)
    evidence: str = Field(min_length=2, max_length=500)


class WeakTopicEvidence(TopicEvidence):
    learningAction: str = Field(min_length=2, max_length=500)


class TopicAssessment(BaseModel):
    topic: str = Field(min_length=2, max_length=120)
    score: int = Field(ge=0, le=100)
    confidence: float = Field(ge=0, le=1)


class SessionAssessmentPayload(BaseModel):
    overallLevel: str = Field(min_length=2, max_length=40)
    conclusion: str = Field(min_length=2, max_length=800)
    strengths: list[TopicEvidence] = Field(max_length=8)
    weaknesses: list[WeakTopicEvidence] = Field(max_length=8)
    topicAssessments: list[TopicAssessment] = Field(min_length=1, max_length=16)
    markdown: str = Field(min_length=2, max_length=12_000)
```

- [ ] **Step 4: Implement analysis generation, repair, and endpoints**

`analyze_session` serializes transcripts in timestamp order with explicit `Интервьюер` and
`Кандидат` labels, calls `provider_adapter.complete` through the automatic deep router,
extracts the first JSON object, and validates it with `SessionAssessmentPayload.model_validate`.
On the first validation failure, make exactly one second completion with the invalid text,
validation error, and the same JSON schema. Persist only after successful validation.

```py
class AnalyzeSessionRequest(BaseModel):
    language: str = "ru"


@router.post("/{session_id}/analysis")
async def create_session_analysis(
    session_id: str,
    payload: AnalyzeSessionRequest,
    db: Session = Depends(get_db),
) -> dict:
    session = db.get(InterviewSession, session_id)
    if not session:
        raise AppError("Session not found", 404, "not_found")
    existing = db.query(SessionAssessment).filter_by(session_id=session_id).first()
    if existing:
        return json.loads(existing.analysis_json)
    result = await analyze_session(db, session, payload.language)
    row = SessionAssessment(
        session_id=session_id,
        language=payload.language,
        analysis_json=result.model_dump_json(),
        markdown=result.markdown,
    )
    db.add(row)
    db.commit()
    return result.model_dump()


@router.get("/{session_id}/analysis")
def get_session_analysis(session_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.query(SessionAssessment).filter_by(session_id=session_id).first()
    if not row:
        raise AppError("Session analysis not found", 404, "not_found")
    return json.loads(row.analysis_json)
```

- [ ] **Step 5: Run focused and session regression tests**

Run:

```powershell
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_session_analysis.py apps/api-py/tests/test_sessions.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit session-assessment persistence**

```powershell
git add apps/api-py/app/db/models.py apps/api-py/app/services/session_analysis.py apps/api-py/app/routers/sessions.py apps/api-py/tests/test_session_analysis.py
git commit -m "feat: persist live session assessments"
```

### Task 3: Knowledge aggregate and synchronous weak-topic cache

**Files:**
- Modify: `apps/api-py/app/routers/sessions.py`
- Modify: `apps/api-py/tests/test_session_analysis.py`
- Create: `apps/desktop/src/lib/sessionKnowledge.ts`
- Create: `apps/desktop/src/lib/sessionKnowledge.test.ts`
- Modify: `apps/desktop/src/lib/vacancyReview/weakTopics.ts`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/context/AppContext.tsx`

**Interfaces:**
- Consumes: all persisted `SessionAssessment.topicAssessments` and existing completed mock scores.
- Produces: `GET /sessions/knowledge-map`, `refreshSessionKnowledge()`, and merged `getWeakTopicTitles(limit)`.

- [ ] **Step 1: Add failing aggregate and cache tests**

```py
def test_knowledge_map_aggregates_low_scores(client, monkeypatch):
    async def fake_complete(*args, **kwargs):
        return json.dumps(VALID_ANALYSIS, ensure_ascii=False)

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    session_id = _completed_session(client)
    client.post(f"/sessions/{session_id}/analysis", json={"language": "ru"})
    response = client.get("/sessions/knowledge-map")
    assert response.status_code == 200
    assert response.json()["weakTopics"][0]["topic"] == "Техники тест-дизайна"
    assert response.json()["weakTopics"][0]["score"] == 42
```

```ts
import { describe, expect, it } from 'vitest';
import { mergeKnowledgeTopics } from './sessionKnowledge';

it('merges repeated topics by normalized name and keeps evidence count', () => {
  expect(mergeKnowledgeTopics([
    { topic: 'Тест-дизайн', score: 40, confidence: 0.8 },
    { topic: 'тест-дизайн', score: 60, confidence: 1 },
  ])).toEqual([
    { topic: 'Тест-дизайн', score: 51, confidence: 0.9, evidenceCount: 2 },
  ]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_session_analysis.py -q
pnpm --filter @interview/desktop test -- src/lib/sessionKnowledge.test.ts
```

Expected: FAIL because the aggregate endpoint and client module are missing.

- [ ] **Step 3: Implement backend aggregation**

Declare `@router.get("/knowledge-map")` before `@router.get("/{session_id}")`. Parse every
assessment, normalize topic names with Unicode casefold/trim, compute a confidence-weighted
mean score, mean confidence, and evidence count, then return topics sorted by score ascending.

```py
return {
    "weakTopics": [topic for topic in topics if topic["score"] < 70][:12],
    "strongTopics": [topic for topic in reversed(topics) if topic["score"] >= 70][:12],
    "updatedAt": _naive_utc_now().isoformat(),
}
```

- [ ] **Step 4: Implement cache refresh and merge with mock topics**

```ts
const STORAGE_KEY = 'skillcue:session-knowledge:v1';

export interface SessionKnowledgeTopic {
  topic: string;
  score: number;
  confidence: number;
  evidenceCount: number;
}

export function loadSessionWeakTopics(): SessionKnowledgeTopic[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return Array.isArray(value.weakTopics) ? value.weakTopics : [];
  } catch {
    return [];
  }
}

export async function refreshSessionKnowledge(): Promise<void> {
  const knowledge = await api.getKnowledgeMap();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(knowledge));
}
```

Call `refreshSessionKnowledge()` once after backend readiness in `AppContext` and immediately
after a successful session analysis. Update `getWeakTopicTitles` to deduplicate mock weak topics
and cached session topics, preserving mock critical/weak order followed by lowest session scores.

- [ ] **Step 5: Run aggregate/cache tests and desktop typecheck**

Run:

```powershell
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_session_analysis.py -q
pnpm --filter @interview/desktop test -- src/lib/sessionKnowledge.test.ts src/lib/vacancyReview/vacancyReview.test.ts
pnpm --filter @interview/desktop typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the knowledge bridge**

```powershell
git add apps/api-py/app/routers/sessions.py apps/api-py/tests/test_session_analysis.py apps/desktop/src/lib/sessionKnowledge.ts apps/desktop/src/lib/sessionKnowledge.test.ts apps/desktop/src/lib/vacancyReview/weakTopics.ts apps/desktop/src/lib/api.ts apps/desktop/src/context/AppContext.tsx
git commit -m "feat: reuse weak topics from live sessions"
```

### Task 4: `Разобрать сессию` recap UI

**Files:**
- Modify: `apps/desktop/src/pages/OverlayPage.tsx:200-930`
- Modify: `apps/desktop/src/pages/OverlayPage.behavior.test.ts`
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/i18n/ru.ts`
- Modify: `apps/desktop/src/lib/i18n/en.ts`
- Modify: `apps/desktop/src/styles/overlay-cockpit.css`

**Interfaces:**
- Consumes: ended session ID, `api.createSessionAnalysis(id, language)`, and `SessionAssessmentPayload`.
- Produces: recap tab `analysis`, explicit action, progress/error/retry states, persisted result rendering.

- [ ] **Step 1: Add failing recap behavior assertions**

```ts
it('offers explicit persisted analysis after the session ends', () => {
  expect(source).toContain("['analysis', t('overlay.recap.tab.analysis')]");
  expect(source).toContain('api.createSessionAnalysis(recap.sessionId');
  expect(source).toContain("t('overlay.recap.analyze')");
  expect(source).toContain('refreshSessionKnowledge');
});

it('keeps the ended session id in the recap snapshot', () => {
  expect(source).toContain('sessionId: endedSessionId');
});
```

- [ ] **Step 2: Run the overlay behavior test and verify failure**

Run: `pnpm --filter @interview/desktop test -- src/pages/OverlayPage.behavior.test.ts`

Expected: FAIL because the analysis tab and API call are absent.

- [ ] **Step 3: Add API types and preserve the ended session ID**

```ts
export interface SessionAssessment {
  overallLevel: string;
  conclusion: string;
  strengths: Array<{ topic: string; evidence: string }>;
  weaknesses: Array<{ topic: string; evidence: string; learningAction: string }>;
  topicAssessments: Array<{ topic: string; score: number; confidence: number }>;
  markdown: string;
}
```

Add `createSessionAnalysis(id, language)` and `getSessionAnalysis(id)` to `api`. In
`stopSession`, capture `const endedSessionId = sessionId` before awaiting `stop()`, and store
`{ lines, at, sessionId: endedSessionId }` in recap. Disable analysis with a clear message only
when session persistence failed and the ID is absent.

- [ ] **Step 4: Implement analysis tab states and rendering**

Use states `analysis: SessionAssessment | null`, `analysisLoading`, and `analysisError`.
The action is explicit:

```tsx
{recapTab === 'analysis' && !analysis && !analysisLoading && (
  <button type="button" className="ovl-analysis-action" onClick={analyzeRecap}>
    <Icon d="M12 3v18|M3 12h18" size={14} />
    {t('overlay.recap.analyze')}
  </button>
)}
```

While loading, show a spinner and three short Russian status labels. On success render overall
level, conclusion, strengths, weaknesses, learning actions, and score bars. On error render the
message and a retry button. Call `refreshSessionKnowledge()` after success. Add Russian copy for
all labels and equivalent English fallback strings.

- [ ] **Step 5: Run tests, typecheck, and build**

Run:

```powershell
pnpm --filter @interview/desktop test -- src/pages/OverlayPage.behavior.test.ts src/lib/sessionKnowledge.test.ts
pnpm --filter @interview/desktop typecheck
pnpm --filter @interview/desktop build
```

Expected: PASS.

- [ ] **Step 6: Commit recap analysis UI**

```powershell
git add apps/desktop/src/pages/OverlayPage.tsx apps/desktop/src/pages/OverlayPage.behavior.test.ts apps/desktop/src/lib/api.ts apps/desktop/src/lib/i18n/ru.ts apps/desktop/src/lib/i18n/en.ts apps/desktop/src/styles/overlay-cockpit.css
git commit -m "feat: analyze and retain live session results"
```

## Plan 2 completion checkpoint

Run:

```powershell
apps/api-py/.venv/Scripts/python.exe -m pytest apps/api-py/tests/test_chat_review.py apps/api-py/tests/test_session_analysis.py apps/api-py/tests/test_sessions.py -q
pnpm --filter @interview/desktop test
pnpm --filter @interview/desktop typecheck
```

Expected: PASS. End a Russian live session, verify Russian recap headings, press
`Разобрать сессию`, reopen the saved analysis without another model call, and confirm its weakest
topic appears in the next live request's `weak_topics` payload.
