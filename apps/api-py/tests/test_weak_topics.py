"""Tests for the mock-report → live prompt bridge (_weak_topics_block)."""

from app.routers.chat import _weak_topics_block


def test_empty_and_none_produce_nothing():
    assert _weak_topics_block(None) == ""
    assert _weak_topics_block([]) == ""
    assert _weak_topics_block(["  ", ""]) == ""


def test_topics_injected_and_capped_to_five():
    block = _weak_topics_block(["SQL", "Fixtures", "CI/CD", "Docker", "REST", "Git"])
    assert "WEAK TOPICS" in block
    assert "SQL" in block and "REST" in block
    assert "Git" not in block  # capped to 5
    assert "do NOT mention" in block  # никогда не палим слабость вслух


def test_whitespace_topics_trimmed():
    block = _weak_topics_block(["  SQL  "])
    assert "SQL" in block
    assert "  SQL  " not in block
