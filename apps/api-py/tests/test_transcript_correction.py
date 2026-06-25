from app.services import transcript_correction


def test_should_llm_correct_respects_flag():
    assert (
        transcript_correction.should_llm_correct(
            raw_question="Что такое алло report?",
            glossary_corrected="Что такое Allure Report?",
            corrections=[{"from": "алло report", "to": "Allure Report", "confidence": "high"}],
            needs_llm_correction=False,
        )
        is False
    )


def test_should_llm_correct_medium_confidence():
    assert (
        transcript_correction.should_llm_correct(
            raw_question="Как ты проверял капитал?",
            glossary_corrected="Как ты проверял Kafka?",
            corrections=[{"from": "капитал", "to": "Kafka", "confidence": "medium"}],
            needs_llm_correction=None,
        )
        is True
    )
