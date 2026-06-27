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

# "Если хотите, могу подробнее рассказать/разложить…" — ChatGPT offers-to-continue
# (anchored to a trailing closing sentence).
_CHATGPT_TAIL_RES = [
    re.compile(
        r"(?:^|\s)Если\s+(?:хотите|хочешь|нужно|интересно)[^.?!]*"
        r"(?:рассказ\w*|разлож\w*|расскаж\w*|подробн\w*|объясн\w*|пример\w*)[^.?!]*[.?!]\s*$",
        re.IGNORECASE | re.UNICODE,
    ),
    re.compile(
        r"(?:^|\s)Могу\s+(?:также\s+)?(?:подробнее|ещё|еще|дополнительно)[^.?!]*[.?!]\s*$",
        re.IGNORECASE | re.UNICODE,
    ),
    re.compile(
        r"(?:^|\s)Хотите,\s+(?:я\s+)?(?:расскаж\w*|разлож\w*|покаж\w*)[^.?!]*[.?!]\s*$",
        re.IGNORECASE | re.UNICODE,
    ),
]

# Whole filler sentences with no information.
_FILLER_SENTENCE_RES = [
    re.compile(
        r"(?:^|\s)В\s+разных\s+контекстах\s+могут\s+быть\s+разные\s+подходы[^.?!]*[.?!]\s*",
        re.IGNORECASE | re.UNICODE,
    ),
    re.compile(
        r"(?:^|\s)Это\s+позволило\s+мне\s+углубить\s+(?:свои\s+)?знания[^.?!]*[.?!]\s*",
        re.IGNORECASE | re.UNICODE,
    ),
    re.compile(
        r"(?:^|\s)Существуют\s+различные\s+инструменты\s+и\s+методы[^.?!]*[.?!]\s*",
        re.IGNORECASE | re.UNICODE,
    ),
]

# Filler openers — strip the opener, keep the sentence body.
_FILLER_OPENER_RES = [
    re.compile(
        r"(?:^|(?<=[.?!]\s))(?:Важно\s+отметить|Стоит\s+отметить|Хочу\s+отметить),?\s*(?:что\s+)?",
        re.IGNORECASE | re.UNICODE,
    ),
    re.compile(r"(?:^|(?<=[.?!]\s))В\s+заключение,?\s*", re.IGNORECASE | re.UNICODE),
    re.compile(r"(?:^|(?<=[.?!]\s))Давайте\s+рассмотрим,?\s*", re.IGNORECASE | re.UNICODE),
]

# Internal section labels the model sometimes leaks (incl. as markdown headers).
_LABELS = (
    r"Main\s+answer|Short\s+answer|Key\s+points?|Detailed|Risks?|"
    r"Краткий\s+ответ|Основной\s+ответ|Ключевые\s+(?:моменты|пункты)"
)
_INTERNAL_LABEL_RES = [
    # A label alone on its own line (optional #/** wrappers, optional colon).
    re.compile(
        rf"(?:^|\n)[ \t]*#{{0,6}}[ \t]*\*{{0,2}}[ \t]*(?:{_LABELS})[ \t]*\*{{0,2}}[ \t]*:?[ \t]*(?=\n|$)",
        re.IGNORECASE | re.UNICODE,
    ),
    # Label at the start of a line with inline content after a colon.
    re.compile(
        rf"(?:^|\n)[ \t]*\*{{0,2}}[ \t]*(?:{_LABELS})[ \t]*\*{{0,2}}[ \t]*:[ \t]*",
        re.IGNORECASE | re.UNICODE,
    ),
    # Label inline after sentence punctuation, with a colon.
    re.compile(
        rf"(?<=[.?!])[ \t]*\*{{0,2}}[ \t]*(?:{_LABELS})[ \t]*\*{{0,2}}[ \t]*:[ \t]*",
        re.IGNORECASE | re.UNICODE,
    ),
    # Any remaining markdown header markers -> drop the # but keep heading text.
    re.compile(r"(?:^|\n)[ \t]*#{1,6}[ \t]*", re.UNICODE),
]


def sanitize_live_answer(answer: str) -> str:
    """Strip diagnostic intros, internal labels, ChatGPT tails and filler from a
    live answer before it reaches the user. Keeps technical terms and short lists.
    Idempotent — safe to run on streaming partials."""
    text = (answer or "").strip()
    if not text:
        return text

    for pattern in _INTERNAL_LABEL_RES + _FILLER_OPENER_RES:
        text = pattern.sub(" ", text)

    changed = True
    while changed:
        changed = False
        for pattern in (
            _DIAGNOSTIC_PREFIX_RES
            + _CALL_CENTER_PHRASE_RES
            + _CHATGPT_TAIL_RES
            + _FILLER_SENTENCE_RES
        ):
            next_text = pattern.sub(" ", text).strip()
            if next_text != text:
                text = next_text
                changed = True

    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def trim_spoken_answer(answer: str, max_words: int = 90) -> str:
    """Trim a Say-aloud answer to the last complete sentence at/under max_words."""
    text = (answer or "").strip()
    if not text:
        return text
    words = text.split()
    if len(words) <= max_words:
        return text
    sentences = re.findall(r"[^.?!\n]+[.?!]?(?:\n+|$|\s)", text) or [text]
    acc = ""
    count = 0
    for sentence in sentences:
        w = len(sentence.split())
        if count + w > max_words:
            break
        acc += sentence
        count += w
    acc = acc.strip()
    if not acc:
        return " ".join(words[:max_words]).rstrip(" ,;:–-") + "…"
    return acc
