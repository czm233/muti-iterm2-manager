from __future__ import annotations

from pathlib import Path

from multi_iterm2_manager.analyzer import analyze_screen_text, load_rules
from multi_iterm2_manager.models import TerminalStatus


RULES_PATH = Path(__file__).resolve().parents[1] / "rules.yaml"


def _load_config():
    return load_rules(str(RULES_PATH))


def test_analyze_screen_text_matches_codex_working_indicator() -> None:
    config = _load_config()
    text = "\n".join([
        "│ Working (9s • esc to interrupt)",
        "gpt-5.4 xhigh · ~/repo",
        "Context 91% left",
    ])

    status, markers, summary = analyze_screen_text(text, 0.0, config)

    assert status == TerminalStatus.running
    assert markers == ["codex-working-indicator"]
    assert "Working" in summary


def test_analyze_screen_text_does_not_tag_generic_working_text_as_codex() -> None:
    config = _load_config()

    status, markers, _ = analyze_screen_text("working directory initialized\n$ ", 0.0, config)

    assert status == TerminalStatus.running
    assert markers == []
