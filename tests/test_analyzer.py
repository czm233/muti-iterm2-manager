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


def test_analyze_screen_text_matches_codex_ctrl_c_working_indicator() -> None:
    config = _load_config()
    text = "\n".join([
        "Working (9s • Ctrl+C to interrupt)",
        "gpt-5.5 xhigh",
        "Context 27% left",
    ])

    status, markers, summary = analyze_screen_text(text, 0.0, config)

    assert status == TerminalStatus.running
    assert markers == ["codex-working-indicator"]
    assert "Ctrl+C" in summary


def test_analyze_screen_text_maps_codex_ready_statusline_to_done() -> None:
    config = _load_config()
    text = (
        "gpt-5.5 xhigh · ~/githubProject/muti-iterm2-manager · Context 27% used · "
        "0.125.0 · Fast on · 380K window · Ready · "
        "019dc9b8-a26d-7ac0-9730-f17c57727b91"
    )

    status, markers, summary = analyze_screen_text(text, 0.0, config)

    assert status == TerminalStatus.done
    assert markers == ["codex-statusline-ready"]
    assert "Ready" in summary


def test_analyze_screen_text_maps_codex_active_statuslines_to_running() -> None:
    config = _load_config()

    for raw_status in ("Starting", "Working"):
        text = (
            "gpt-5.5 xhigh · ~/githubProject/muti-iterm2-manager · Context 27% used · "
            f"0.125.0 · Fast on · 380K window · {raw_status} · "
            "019dc9b8-a26d-7ac0-9730-f17c57727b91"
        )

        status, markers, _ = analyze_screen_text(text, 0.0, config)

        assert status == TerminalStatus.running
        assert markers == [f"codex-statusline-{raw_status.casefold()}"]


def test_analyze_screen_text_prefers_latest_codex_statusline() -> None:
    config = _load_config()
    text = "\n".join([
        "gpt-5.5 xhigh · ~/repo · Context 27% used · 0.125.0 · Fast on · 380K window · Working · 019dc9b8-a26d-7ac0-9730-f17c57727b91",
        "gpt-5.5 xhigh · ~/repo · Context 27% used · 0.125.0 · Fast on · 380K window · Ready · 019dc9b8-a26d-7ac0-9730-f17c57727b91",
    ])

    status, markers, _ = analyze_screen_text(text, 0.0, config)

    assert status == TerminalStatus.done
    assert markers == ["codex-statusline-ready"]


def test_analyze_screen_text_does_not_tag_generic_working_text_as_codex() -> None:
    config = _load_config()

    status, markers, _ = analyze_screen_text("working directory initialized\n$ ", 0.0, config)

    assert status == TerminalStatus.running
    assert markers == []
