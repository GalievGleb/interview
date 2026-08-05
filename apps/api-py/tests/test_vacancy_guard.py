import json

from app.services import provider_adapter


def test_vacancy_evaluate_removes_unsupported_claims_and_reports_asr_noise(client, monkeypatch):
    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        return json.dumps(
            {
                "score": 70,
                "technicalContentScore": 75,
                "projectSpecificityScore": 65,
                "leadershipScore": 80,
                "structureScore": 70,
                "speechClarityScore": 60,
                "technicalAccuracyScore": 75,
                "specificityScore": 65,
                "clarityScore": 70,
                "confidenceScore": 70,
                "levelEstimate": "lead",
                "verdict": "Нормальный ответ.",
                "feedback": "Нужно конкретнее.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": ["GitLab CI", "Docker", "Allure"],
                "goodPoints": ["Есть CI/CD контекст"],
                "weakPoints": [],
                "missingPoints": [],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "suggestedBetterAnswer": (
                    "Я руководил командой из 6 человек, менторил QA и проводил code review. "
                    "На проекте внедрил Cypress и JMeter, повысил стабильность на 40%. "
                    "Также настраивал GitLab CI, Docker и Allure."
                ),
                "followUpQuestions": [],
                "nextTrainingFocus": "",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Как вы выстраивали автоматизацию на lead роли?",
            "answer": "Настраивал GitLab CI, Docker, Allure. www.patreon.com случайно попало в запись.",
            "topic": "CI/CD и автоматизация",
            "level": "lead",
            "expectedSignals": ["GitLab CI", "Docker", "Allure"],
            "relatedResumeEvidence": ["GitLab CI", "Docker", "Allure"],
            "resumeText": "Ведущий AQA: настраивал GitLab CI, Docker, Allure и pytest.",
            "vacancyText": "Lead QA Automation: GitLab CI, Docker, Allure, pytest.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    stronger = body["suggestedBetterAnswer"].lower()

    assert "40%" not in stronger
    assert "6 человек" not in stronger
    assert "ментор" not in stronger
    assert "code review" not in stronger
    assert "cypress" not in stronger
    assert "jmeter" not in stronger
    assert "точных цифр сейчас не приведу" in stronger
    assert any("patreon" in item.lower() for item in body["detectedNoiseOrAsrErrors"])
    assert any(
        "people" in item.lower() or "management" in item.lower()
        for item in body["hallucinationGuard"]
    )
    assert any(
        "метрик" in item.lower() or "цифр" in item.lower() for item in body["hallucinationGuard"]
    )


def test_vacancy_evaluate_prompt_contains_strict_allowed_sources(client, monkeypatch):
    captured = {}

    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        captured["prompt"] = messages[-1]["content"]
        captured["model"] = model
        captured["max_tokens"] = max_tokens
        captured["reasoning"] = reasoning
        captured["response_format"] = response_format
        return json.dumps(
            {
                "score": 80,
                "technicalContentScore": 80,
                "projectSpecificityScore": 70,
                "leadershipScore": 0,
                "structureScore": 80,
                "speechClarityScore": 80,
                "technicalAccuracyScore": 80,
                "specificityScore": 70,
                "clarityScore": 80,
                "confidenceScore": 80,
                "levelEstimate": "middle",
                "verdict": "Ок.",
                "feedback": "Ок.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": [],
                "goodPoints": [],
                "weakPoints": [],
                "missingPoints": [],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "answerStrategy": "Сначала дать прямой вывод, затем доказать его проверками.",
                "whyThisAnswerWorks": [
                    "Ответ сразу раскрывает подход к контрактам.",
                    "Негативные проверки показывают практическую глубину.",
                ],
                "deliveryTips": ["Произнести вывод одной фразой без вводной воды."],
                "suggestedBetterAnswer": "Я тестировал API через контракты и негативные проверки.",
                "followUpQuestions": [],
                "nextTrainingFocus": "",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Как тестировали API?",
            "answer": "Проверял контракты и негативные payload.",
            "topic": "API",
            "expectedSignals": ["API"],
            "resumeText": "API tests, pytest.",
            "vacancyText": "API testing.",
            "legendText": "Эта легенда не должна быть источником фактов.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    prompt = captured["prompt"]
    assert "facts from resume_text" in prompt
    assert "facts from vacancy_text" in prompt
    assert "facts from candidate_answer" in prompt
    assert "INTERVIEW LEGEND" not in prompt
    assert captured["model"].endswith("gpt-5.6-sol")
    assert captured["max_tokens"] >= 6000
    assert captured["reasoning"] == {"effort": "high", "exclude": True}
    assert captured["response_format"] == {"type": "json_object"}
    body = res.json()
    assert body["answerStrategy"].startswith("Сначала дать прямой вывод")
    assert len(body["whyThisAnswerWorks"]) == 2
    assert body["deliveryTips"] == ["Произнести вывод одной фразой без вводной воды."]


def test_vacancy_evaluate_preserves_raw_voice_answer_in_prompt(client, monkeypatch):
    captured = {}

    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        captured["prompt"] = messages[-1]["content"]
        return json.dumps(
            {
                "score": 70,
                "technicalContentScore": 70,
                "projectSpecificityScore": 60,
                "leadershipScore": 40,
                "structureScore": 70,
                "speechClarityScore": 45,
                "technicalAccuracyScore": 70,
                "specificityScore": 60,
                "clarityScore": 70,
                "confidenceScore": 70,
                "levelEstimate": "middle",
                "verdict": "Ок.",
                "feedback": "Ок.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": [],
                "goodPoints": [],
                "weakPoints": [],
                "missingPoints": [],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "suggestedBetterAnswer": "Я работал со стеком Python, API, CI/CD, Docker и Allure.",
                "followUpQuestions": [],
                "nextTrainingFocus": "",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "С каким стеком ты работал и за что отвечал?",
            "answer": (
                "CI-CD GitLab, Docker, контейнеры, Linux, SQL. "
                "Блин, меня не записывает нифига. Всем проблема. Раз, раз, раз-раз-раз. "
                "Также для вызова запросов использовал Requests, HTTPX. "
                "Для отчетов я смотрел Allure отчеты. Ммммммммммммммммммммммммммммммм"
            ),
            "topic": "Project experience",
            "expectedSignals": ["stack", "role", "ownership"],
            "resumeText": "QA Automation: GitLab CI, Docker, Linux, SQL, Requests, HTTPX, Allure.",
            "vacancyText": "Project experience, stack, impact, ownership.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    prompt = captured["prompt"]
    assert "CI-CD GitLab" in prompt
    assert "Requests, HTTPX" in prompt
    assert "Allure" in prompt
    assert "меня не записывает" in prompt
    assert "Раз, раз" in prompt
    assert "Ммммм" in prompt
    assert any(
        "записывает" in item or "Раз, раз" in item
        for item in res.json()["detectedNoiseOrAsrErrors"]
    )


def test_vacancy_evaluate_rejects_empty_answer_before_calling_model(client, monkeypatch):
    called = False

    async def fake_complete(*_args, **_kwargs):
        nonlocal called
        called = True
        return "{}"

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)
    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Что проверяете в API?",
            "answer": "   \n  ",
            "topic": "API",
            "language": "ru",
            "hasResume": False,
        },
    )

    assert res.status_code == 400
    assert res.json()["detail"] == "Answer is empty"
    assert called is False


def test_vacancy_evaluate_hardens_semantic_matching_and_consistency(client, monkeypatch):
    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        return json.dumps(
            {
                "score": 48,
                "technicalContentScore": 0,
                "projectSpecificityScore": 87,
                "leadershipScore": 0,
                "structureScore": 100,
                "speechClarityScore": 80,
                "technicalAccuracyScore": 0,
                "specificityScore": 87,
                "clarityScore": 100,
                "confidenceScore": 85,
                "levelEstimate": "senior",
                "verdict": "Звучит как Senior",
                "feedback": "Нет структуры.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": ["Упомянул Pydantic и схему ответа"],
                "goodPoints": ["Есть корректные API проверки"],
                "weakPoints": ["Нет структуры"],
                "missingPoints": ["schema/body checks", "auth", "negative cases"],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "suggestedBetterAnswer": (
                    "Я бы начал с короткого ответа и потом добавил бы schema/body checks, auth и negative cases."
                ),
                "followUpQuestions": ["Уточни schema/body checks"],
                "nextTrainingFocus": "Проработай schema/body checks.",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Что проверяете в API кроме статус-кода 200?",
            "answer": (
                "Я проверяю схему ответа через Pydantic, модель ответа, типы полей, "
                "обязательные поля, headers, token, права доступа и негативные 400/401/403."
            ),
            "topic": "API testing",
            "level": "middle",
            "expectedSignals": [
                "schema/body checks",
                "auth",
                "negative cases",
                "state verification",
            ],
            "resumeText": "API tests with pytest, HTTPX, Pydantic, auth checks.",
            "vacancyText": "QA Automation: API testing, pytest, HTTPX.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["technicalAccuracyScore"] > 0
    assert body["technicalContentScore"] > 0
    assert body["levelEstimate"] != "senior"
    assert "Нет структуры" not in " ".join(body["weakPoints"])
    assert "schema/body checks" not in body["missingPoints"]
    assert "auth" not in body["missingPoints"]
    assert "negative cases" not in body["missingPoints"]
    forbidden = (
        "Я бы начал",
        "Я отвечаю через практический пример",
        "Сначала коротко называю подход",
        "Потом объясняю",
        "Отдельно раскрываю",
    )
    assert not any(phrase in body["suggestedBetterAnswer"] for phrase in forbidden)
    assert "schema/body checks" not in " ".join(body["followUpQuestions"])


def test_vacancy_evaluate_generic_technical_fallback_is_ready_answer(client, monkeypatch):
    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        return json.dumps(
            {
                "score": 61,
                "technicalContentScore": 60,
                "projectSpecificityScore": 55,
                "leadershipScore": 40,
                "structureScore": 70,
                "speechClarityScore": 80,
                "technicalAccuracyScore": 60,
                "specificityScore": 55,
                "clarityScore": 70,
                "confidenceScore": 75,
                "levelEstimate": "middle",
                "verdict": "Есть база, но нужен более готовый ответ.",
                "feedback": "Нужно говорить конкретнее.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": ["Playwright", "Allure"],
                "goodPoints": ["Есть инструменты"],
                "weakPoints": ["Нужно закрыть практический пример"],
                "missingPoints": ["risk analysis"],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "suggestedBetterAnswer": (
                    "Я отвечаю через практический пример: сначала коротко называю подход, потом объясняю, где применял."
                ),
                "followUpQuestions": [],
                "nextTrainingFocus": "Практический пример",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Какие инструменты вы использовали для поддержки автотестовой платформы?",
            "answer": "Использовал Playwright для UI, Allure для отчётов и смотрел падения по логам.",
            "topic": "Автотестовая платформа",
            "level": "middle",
            "expectedSignals": ["risk analysis", "reports", "stability"],
            "resumeText": "QA Automation experience with Playwright, pytest and Allure reports.",
            "vacancyText": "QA Automation: test platform support and reporting.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    answer = res.json()["suggestedBetterAnswer"]

    assert answer.startswith("Я ")
    assert "Я отвечаю через практический пример" not in answer
    assert "сначала коротко" not in answer.lower()
    assert "потом объясняю" not in answer.lower()
    assert "Нужно закрыть" not in answer


def test_vacancy_evaluate_hardens_behavioral_star_semantics(client, monkeypatch):
    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        return json.dumps(
            {
                "score": 52,
                "technicalContentScore": 20,
                "projectSpecificityScore": 40,
                "leadershipScore": 35,
                "structureScore": 60,
                "speechClarityScore": 80,
                "technicalAccuracyScore": 20,
                "specificityScore": 40,
                "clarityScore": 60,
                "confidenceScore": 75,
                "levelEstimate": "middle",
                "verdict": "Нужно добавить teamwork/conflict/ownership/real example.",
                "feedback": "Ответ слишком общий.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": [],
                "goodPoints": [],
                "weakPoints": [
                    "Add Teamwork",
                    "Add conflict",
                    "Add ownership",
                    "Add real examples",
                ],
                "missingPoints": ["Teamwork", "Conflict", "Ownership", "Real example", "Result"],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "suggestedBetterAnswer": (
                    "По теме behavioral questions я отвечаю через практический пример: сначала контекст, потом действия."
                ),
                "followUpQuestions": [
                    "Уточни Teamwork",
                    "Уточни Conflict",
                    "Уточни Ownership",
                    "Уточни Real example",
                ],
                "nextTrainingFocus": "Добавь Teamwork, Conflict, Ownership и Real example.",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    answer = (
        "На проекте личного кабинета я работал вместе с manual QA, разработчиками и аналитиком. "
        "Был спор по приоритетам: разработчики хотели быстрее закрыть релиз, а тестировщики видели риск "
        "в нестабильных API проверках. Я взял на себя анализ падений, предложил отделить smoke от полного "
        "regression и договорился сначала стабилизировать критичные сценарии. В результате релиз не блокировали, "
        "а спорные проверки вынесли в отдельный план."
    )
    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Расскажите про сложную ситуацию в команде и как вы ее решили.",
            "answer": answer,
            "topic": "Behavioral questions",
            "level": "senior",
            "expectedSignals": ["Teamwork", "Conflict", "Ownership", "Real example", "Result"],
            "resumeText": "QA Automation, API tests, regression, communication with QA and developers.",
            "vacancyText": "QA Automation role: teamwork, ownership, conflict resolution.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()

    joined_missing = " ".join(body["missingPoints"])
    assert "Teamwork" not in joined_missing
    assert "Conflict" not in joined_missing
    assert "Ownership" not in joined_missing
    assert "Real example" not in joined_missing
    assert "Result" not in joined_missing
    joined_weak = " ".join(body["weakPoints"])
    assert "Teamwork is present" in joined_weak
    assert "Conflict is present" in joined_weak
    assert "Ownership is present" in joined_weak
    assert "Real example is present" in joined_weak
    assert body["suggestedBetterAnswer"].startswith("Одна из сложных ситуаций была на проекте")
    assert "По теме behavioral questions" not in body["suggestedBetterAnswer"]
    assert "я отвечаю через практический пример" not in body["suggestedBetterAnswer"].lower()
    assert "отдельно раскрываю" not in body["suggestedBetterAnswer"].lower()
    assert "Teamwork" not in " ".join(body["followUpQuestions"])


def test_vacancy_evaluate_hardens_project_experience_question(client, monkeypatch):
    """GeoMix-style short project answer: real project + real stack + light
    ownership, but no team/CI-CD/explicit result. Must not be scored near-zero,
    must not lose the named project/stack/ownership as "missing", and must not
    get the behavioral conflict-story opening or any invented specifics.
    """

    async def fake_complete(
        messages,
        provider=None,
        model=None,
        max_tokens=800,
        temperature=0.4,
        reasoning=None,
        response_format=None,
    ):
        return json.dumps(
            {
                "score": 20,
                "technicalContentScore": 0,
                "projectSpecificityScore": 0,
                "leadershipScore": 0,
                "ownershipScore": 0,
                "structureScore": 40,
                "speechClarityScore": 80,
                "technicalAccuracyScore": 0,
                "specificityScore": 0,
                "confidenceScore": 60,
                "levelEstimate": "junior",
                "verdict": "Слабый ответ без реального проекта.",
                "feedback": "Нет конкретики.",
                "detectedNoiseOrAsrErrors": [],
                "extractedValidPoints": [],
                "goodPoints": [],
                "weakPoints": [],
                "missingPoints": [
                    "Concrete real project",
                    "stack",
                    "ownership",
                    "team size",
                    "CI/CD experience",
                ],
                "technicalCorrections": [],
                "hallucinationGuard": [],
                "betterStructure": [],
                "suggestedBetterAnswer": (
                    "Одна из сложных ситуаций была на проекте, где я работал с командой. "
                    "Я руководил командой из 8 человек. "
                    "Мы внедрили JMeter и Cypress и повысили стабильность на 35%. "
                    "Я проводил code review и менторил джунов."
                ),
                "followUpQuestions": [],
                "nextTrainingFocus": "",
                "overclaimed": False,
            },
            ensure_ascii=False,
        )

    monkeypatch.setattr(provider_adapter, "complete", fake_complete)

    answer = (
        "На проекте Геомикс в горнодобывающей отрасли я занимался автоматизацией как ведущий инженер AQA. "
        "Использовали Allure для отчётов и делали screenshot-based тестирование сложных сцен через Pillow. "
        "Я сам выбирал, какие тест-кейсы автоматизировать."
    )
    res = client.post(
        "/vacancy/evaluate",
        json={
            "question": "Расскажите о проекте, где вы участвовали как лидер автоматизации тестирования",
            "answer": answer,
            "topic": "Project experience",
            "level": "lead",
            "expectedSignals": ["team size", "CI/CD", "stability result"],
            "resumeText": "Ведущий инженер AQA, Геомикс: Allure, screenshot-based тесты, Pillow.",
            "vacancyText": "Team Lead QA Automation: Allure, screenshot testing, test case selection.",
            "language": "ru",
            "hasResume": True,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # Never near-zero when a real project + real tool were named.
    assert body["technicalAccuracyScore"] >= 50
    assert body["technicalContentScore"] >= 50
    assert body["score"] >= 45
    assert body["ownershipScore"] >= 30

    # Named project/stack/ownership must not survive as hard "missing".
    joined_missing = " ".join(body["missingPoints"])
    assert "Concrete real project" not in joined_missing
    assert "stack" not in joined_missing.lower().split()  # allow substring safety, check as token
    assert "ownership" not in joined_missing.lower()
    # Genuinely absent signals are untouched.
    assert "team size" in joined_missing
    assert "CI/CD experience" in joined_missing

    # Never the behavioral conflict-story opening, and never invented specifics.
    stronger = body["suggestedBetterAnswer"]
    assert not stronger.startswith("Одна из сложных ситуаций")
    assert "8 человек" not in stronger
    assert "35%" not in stronger
    assert "cypress" not in stronger.lower()
    assert "jmeter" not in stronger.lower()
    assert "ментор" not in stronger.lower()
    assert "code review" not in stronger.lower()
