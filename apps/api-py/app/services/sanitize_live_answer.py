import re

_DIAGNOSTIC_PREFIX_RES = [
    re.compile(r"^Похоже,\s*вопрос\s*(?:про|о|об)\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Похоже,\s*вопрос\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Похоже,\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Вероятно,\s*вопрос\s*(?:про|о|об)\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Вероятно,\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Судя\s+по\s+всему,\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Я\s+понял\s+вопрос\s+как\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Если\s+вопрос\s*(?:про|о|об)\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"^Вопрос\s+касается\s*[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
]

_CALL_CENTER_PHRASE_RES = [
    re.compile(r"Если у вас есть другие вопросы[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"Можете уточнить[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"Извините,\s*я не совсем понял[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"С радостью отвечу[^.?!]*[.?!]\s*", re.IGNORECASE | re.UNICODE),
]


def sanitize_live_answer(answer: str) -> str:
    text = (answer or "").strip()
    if not text:
        return text
    changed = True
    while changed:
        changed = False
        for pattern in _DIAGNOSTIC_PREFIX_RES + _CALL_CENTER_PHRASE_RES:
            next_text = pattern.sub("", text).lstrip()
            if next_text != text:
                text = next_text
                changed = True
    return text.strip()
