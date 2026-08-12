import json
from datetime import UTC, datetime, timedelta

from app.db.models import InterviewSession, SessionAssessment


def _assessment(
    db_session,
    *,
    kind: str,
    score: int,
    confidence: float,
    topic: str,
    topic_score: int,
    title: str,
    started_at: datetime,
):
    session = InterviewSession(
        mode="interview",
        title=title,
        started_at=started_at.replace(tzinfo=None),
        ended_at=(started_at + timedelta(minutes=20)).replace(tzinfo=None),
    )
    db_session.add(session)
    db_session.flush()
    payload = {
        "analysisVersion": 2,
        "interviewType": kind,
        "overallLevel": "Middle" if kind == "technical" else "Уверенная подача",
        "overallScore": score,
        "overallConfidence": confidence,
        "conclusion": "Вывод по сохранённой сессии.",
        "strengths": [{"topic": topic, "evidence": "Есть прямое подтверждение."}],
        "weaknesses": [
            {
                "topic": topic,
                "evidence": "Ответ можно сделать точнее.",
                "learningAction": "Потренировать ответ на конкретном примере.",
            }
        ],
        "topicAssessments": [{"topic": topic, "score": topic_score, "confidence": confidence}],
        "answerReviews": [
            {
                "question": f"Что вы знаете по теме {topic}?",
                "candidateAnswer": "Фактический ответ кандидата из транскрипта.",
                "topic": topic,
                "score": topic_score,
                "confidence": confidence,
                "whatWasGood": ["Есть релевантный пример."],
                "problems": ["Не раскрыта причина выбора подхода."],
                "missingPoints": ["Не хватило конкретных ограничений."],
                "betterAnswer": "Более структурированный ответ на основе тех же фактов.",
            }
        ],
        "markdown": "## Итог\nСохранённый разбор.",
    }
    db_session.add(
        SessionAssessment(
            session_id=session.id,
            language="ru",
            analysis_json=json.dumps(payload, ensure_ascii=False),
            markdown=payload["markdown"],
        )
    )
    db_session.commit()
    return session.id


def test_development_profile_separates_technical_and_hr_growth(client, db_session):
    now = datetime.now(UTC)
    technical_id = _assessment(
        db_session,
        kind="technical",
        score=58,
        confidence=0.8,
        topic="Техники тест-дизайна",
        topic_score=42,
        title="Техническое интервью",
        started_at=now - timedelta(days=2),
    )
    hr_id = _assessment(
        db_session,
        kind="hr",
        score=76,
        confidence=0.9,
        topic="Самопрезентация",
        topic_score=76,
        title="Разговор с HR",
        started_at=now - timedelta(days=1),
    )

    response = client.get("/sessions/development-profile")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["analyzedSessions"] == 2
    assert payload["technical"]["score"] == 58
    assert payload["technical"]["focusAreas"][0]["topic"] == "Техники тест-дизайна"
    assert payload["hr"]["score"] == 76
    assert payload["hr"]["strengths"][0]["topic"] == "Самопрезентация"
    assert [item["sessionId"] for item in payload["recentSessions"]] == [hr_id, technical_id]
    assert payload["recentAnswers"][0]["sessionId"] == hr_id
    assert payload["recentAnswers"][0]["candidateAnswer"].startswith("Фактический ответ")


def test_development_profile_handles_old_saved_analysis(client, db_session):
    session = InterviewSession(mode="interview", title="Старый технический разбор")
    db_session.add(session)
    db_session.flush()
    old_payload = {
        "overallLevel": "Middle",
        "conclusion": "Старый формат.",
        "strengths": [],
        "weaknesses": [],
        "topicAssessments": [
            {"topic": "API", "score": 70, "confidence": 0.8},
            {"topic": "Python", "score": 50, "confidence": 0.8},
        ],
        "markdown": "## Итог",
    }
    db_session.add(
        SessionAssessment(
            session_id=session.id,
            language="ru",
            analysis_json=json.dumps(old_payload, ensure_ascii=False),
            markdown=old_payload["markdown"],
        )
    )
    db_session.commit()

    payload = client.get("/sessions/development-profile").json()

    assert payload["technical"]["score"] == 60
    assert payload["technical"]["evidenceCount"] == 1
    assert payload["hr"]["evidenceCount"] == 0
