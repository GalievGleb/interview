"""Тесты парсинга Deepgram-событий."""

from app.services.stt_service import _extract_transcript


def test_results_dict_channel():
    evt = {
        "type": "Results",
        "is_final": True,
        "channel": {"alternatives": [{"transcript": "привет"}]},
    }
    assert _extract_transcript(evt) == ("привет", True)


def test_results_list_channel():
    evt = {
        "type": "Results",
        "is_final": False,
        "channel": [{"alternatives": [{"transcript": "hello"}]}],
    }
    assert _extract_transcript(evt) == ("hello", False)


def test_vad_events_skipped():
    assert _extract_transcript({"type": "SpeechStarted"}) is None
    assert _extract_transcript({"type": "UtteranceEnd"}) is None


def test_empty_transcript_skipped():
    evt = {"type": "Results", "channel": {"alternatives": [{"transcript": "  "}]}}
    assert _extract_transcript(evt) is None
