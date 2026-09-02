"""Фиксированная продуктовая маршрутизация моделей по режиму."""

from __future__ import annotations

from app.services.preferences import AiPreferencesModel, load_preferences

AUTO = "auto"
# gpt-4o (не gpt-5.5): разбор вакансии — структурированный JSON-анализ, где gpt-5.5
# избыточен, а стоит в ~2.5× дороже. Ключевое для экономики гейтвея: gpt-5.5
# заблокирован в GATEWAY_BLOCKED_MODELS (защита от разорения на дорогих моделях),
# поэтому дефолт должен быть из разрешённых, иначе разбор у покупателей упрётся в 403.
VACANCY_DEFAULT_MODEL = "openai/gpt-4o"
# Per-answer coaching is interactive. The installed six-case corpus showed Qwen
# returning stronger factual corrections in roughly 2.1–2.7 s versus GPT-4o
# mini's 3.2–4.1 s. Invalid JSON is retried once with the stable GPT fallback.
FEEDBACK_DEFAULT_MODEL = "qwen/qwen3.5-flash-02-23"
FAST_CORE_DEFAULT_MODEL = "qwen/qwen3.5-flash-02-23"
# Comparisons and classifications need reliable category/guarantee handling.
# Gemini won the repeated general-reasoning corpus without adding a second call;
# Qwen remains the lower-latency default for all other live intents.
FAST_ACCURACY_MODEL = "google/gemini-3.5-flash"
# Vision needs exact literals as well as OCR. The previous model read Female/F
# correctly but sometimes normalized them to lowercase while writing SQL.
# GPT-5.6 Sol won the installed exact-literal regression with lower TTFT too.
SCREEN_DEFAULT_MODEL = "openai/gpt-5.6-sol"

MODE_SETTING: dict[str, str] = {
    "general": "default_copilot_model",
    "coding": "coding_assistant_model",
    "fast": "fast_live_model",
    "deep": "deep_reasoning_model",
    # Offline vacancy analysis/evaluation can spend more reasoning than live
    # answers, so vacancy review has its own explicit heavy-model setting.
    "vacancy": "vacancy_review_model",
    "feedback": "vacancy_review_model",
}

# Паттерны id — проверяются по substring в lower(id). Без gemini-2.5/3 — thinking тормозит live.
LIVE_PATTERNS = [
    # Measured against the real SkillCue voice fixtures: Qwen wins on median
    # and tail latency while staying honest on missing resume experience.
    "qwen3.5-flash-02-23",
    "gpt-4o-mini",
    "gemini-2.0-flash-lite",
    "gpt-4.1-nano",
    "gemini-2.0-flash",
    "claude-3.5-haiku",
    "claude-haiku",
    "deepseek-chat",
    "deepseek-v3",
    "qwen",
    "llama-3.3",
    "mistral-small",
]

FAST_SKIP_MODELS = ("gemini-2.5", "gemini-3", "gemini-3.")

CODING_PATTERNS = [
    "gpt-4o",
    "gpt-4.1",
    "claude-sonnet",
    "claude-3.5-sonnet",
    "deepseek-coder",
    "deepseek-chat",
    "qwen-coder",
    "qwen2.5-coder",
    "codestral",
]

DEEP_PATTERNS = [
    "o1",
    "o3",
    "claude-opus",
    "claude-3-opus",
    "gemini-pro",
    "gpt-4o",
    "gpt-4.1",
    "deepseek-reasoner",
]

# Приоритет — БЫСТРЫЕ модели высокого качества. Тяжёлые reasoning-модели
# (gpt-5.x, o3, claude-sonnet-4/3.7 thinking, gemini-2.5-pro) убраны: они давали
# ответ по 20–30 с при разборе ответа на вакансию (пользователь ждёт вживую) и
# часть из них заблокирована на гейтвейе (→ 502 → откат в локальный разбор).
# gpt-4o/gpt-4.1/claude-3.5-sonnet пишут ответ уровня senior за ~5–8 с.
VACANCY_PATTERNS = [
    "gpt-4o",
    "gpt-4.1",
    "claude-3.5-sonnet",
    "claude-sonnet",
    "gemini-2.5-flash",
    "gpt-4o-mini",
    "gpt-4.1-mini",
]

# Low-latency ordering for per-answer coaching. Avoid reasoning models here:
# the UI promises a result (or its deterministic fallback) within a few seconds.
FEEDBACK_PATTERNS = [
    "qwen3.5-flash-02-23",
    "gpt-4o-mini",
    "gpt-4.1-mini",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "claude-3.5-haiku",
]

FALLBACK_IDS = [
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001",
    "deepseek/deepseek-chat",
    "anthropic/claude-3.5-haiku",
    "meta-llama/llama-3.3-70b-instruct",
]


def _match_patterns(model_id: str, patterns: list[str]) -> bool:
    low = model_id.lower()
    return any(p in low for p in patterns)


def _first_available(candidates: list[str], available: set[str]) -> str | None:
    for cid in candidates:
        if cid in available:
            return cid
    return None


def _pattern_pick(
    patterns: list[str], available: set[str], *, skip_reasoning: bool = False
) -> str | None:
    reasoning_kw = ("reasoner", "/o1", "/o3", "thinking", "r1")

    def allowed(model_id: str) -> bool:
        low = model_id.lower()
        if skip_reasoning and any(k in low for k in reasoning_kw):
            return False
        if skip_reasoning and any(k in low for k in FAST_SKIP_MODELS):
            return False
        return True

    # Honour the priority ORDER of `patterns`: try each pattern in turn and
    # return the first available model that matches it. (Previously this looped
    # over models first, so a lower-priority pattern could win purely on
    # alphabetical order — e.g. gemini-2.0-flash beating gpt-4o-mini for "fast".)
    for pattern in patterns:
        for model_id in sorted(available):
            if allowed(model_id) and pattern in model_id.lower():
                return model_id
    return None


def pick_auto_model(mode: str, available: set[str]) -> str:
    """Выбор модели при Auto Select."""
    if not available:
        if mode == "feedback":
            return FEEDBACK_DEFAULT_MODEL
        if mode == "vacancy":
            return VACANCY_DEFAULT_MODEL
        if mode == "fast":
            return FAST_CORE_DEFAULT_MODEL
        return "openai/gpt-4o-mini"

    if mode == "fast":
        found = _pattern_pick(LIVE_PATTERNS, available, skip_reasoning=True)
        if found:
            return found
    elif mode == "feedback":
        found = _pattern_pick(FEEDBACK_PATTERNS, available)
        if found:
            return found
        return FEEDBACK_DEFAULT_MODEL
    elif mode == "vacancy":
        found = _pattern_pick(VACANCY_PATTERNS, available)
        if found:
            return found
    elif mode == "coding":
        found = _pattern_pick(CODING_PATTERNS, available)
        if found:
            return found
    elif mode == "deep":
        found = _pattern_pick(DEEP_PATTERNS, available)
        if found:
            return found
    else:
        found = _pattern_pick(LIVE_PATTERNS, available) or _pattern_pick(CODING_PATTERNS, available)
        if found:
            return found

    fallback = _first_available(FALLBACK_IDS, available)
    if fallback:
        return fallback
    return sorted(available)[0]


def resolve_model(
    mode: str,
    *,
    model_override: str | None = None,
    prefs: AiPreferencesModel | None = None,
    available: set[str] | None = None,
) -> tuple[str, str]:
    """Возвращает выбранную пользователем модель или безопасный Auto-подбор."""
    prefs = prefs or load_preferences()
    available = available if available is not None else {m.id for m in prefs.models_cache}
    mode = mode if mode in MODE_SETTING else "general"

    # The UI exposes model selection, so an explicit request must not silently
    # turn into another model. This is also needed for preview models such as
    # stealth/ox-alpha that may not be present in an old local catalog cache.
    explicit = (model_override or "").strip()
    if explicit and explicit != AUTO:
        return explicit, "manual"

    setting_name = MODE_SETTING[mode]
    configured = (getattr(prefs, setting_name, AUTO) or AUTO).strip()
    if configured != AUTO and configured:
        return configured, "manual"

    return pick_auto_model(mode, available), "auto"
