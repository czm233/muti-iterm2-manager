from __future__ import annotations

import multi_iterm2_manager.program_detection as pd
from multi_iterm2_manager.models import TerminalProgramInfo, TerminalRuntimeInfo


def test_detect_terminal_program_direct_claude_code(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="claude",
        command_line="claude",
        job_pid=12345,
    )

    monkeypatch.setattr(pd, "_is_process_alive", lambda pid: True)

    program = pd.detect_terminal_program(runtime, "")

    assert program.key == "claude-code"
    assert program.label == "Claude Code"
    assert program.source == "direct"
    assert program.pid == 12345
    assert program.is_agent is True
    assert program.to_dict()["isAgent"] is True


def test_detect_terminal_program_from_process_tree(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="zsh",
        command_line="/bin/zsh -l",
        job_pid=20001,
    )

    monkeypatch.setattr(
        pd,
        "_detect_from_process_tree",
        lambda pid: TerminalProgramInfo(
            key="codex",
            label="Codex",
            source="process-tree",
            pid=pid,
            command_line="codex",
        ),
    )

    program = pd.detect_terminal_program(runtime, "")

    assert program.key == "codex"
    assert program.source == "process-tree"
    assert program.command_line == "codex"
    assert program.is_agent is True


def test_detect_terminal_program_from_screen_heuristic(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="tmux",
        command_line="tmux attach",
        job_pid=30001,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)
    monkeypatch.setattr(pd, "_is_process_alive", lambda pid: True)

    program = pd.detect_terminal_program(runtime, "Allow this action?\n")

    assert program.key == "claude-code"
    assert program.source == "screen-heuristic"
    assert program.is_agent is True


def test_detect_terminal_program_from_codex_working_screen_heuristic(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="tmux",
        command_line="tmux attach",
        job_pid=31001,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)
    monkeypatch.setattr(pd, "_is_process_alive", lambda pid: True)

    screen = "\n".join([
        "Working (9s • esc to interrupt)",
        "gpt-5.4 xhigh",
        "Context 91% left",
    ])
    program = pd.detect_terminal_program(runtime, screen)

    assert program.key == "codex"
    assert program.source == "screen-heuristic"
    assert program.is_agent is True


def test_detect_terminal_program_from_codex_statusline_screen_heuristic(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="tmux",
        command_line="tmux attach",
        job_pid=31501,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)
    monkeypatch.setattr(pd, "_is_process_alive", lambda pid: True)

    screen = (
        "gpt-5.5 xhigh · ~/githubProject/muti-iterm2-manager · Context 27% used · "
        "0.125.0 · Fast on · 380K window · Ready · "
        "019dc9b8-a26d-7ac0-9730-f17c57727b91"
    )
    program = pd.detect_terminal_program(runtime, screen)

    assert program.key == "codex"
    assert program.source == "screen-heuristic"
    assert program.is_agent is True


def test_detect_terminal_program_does_not_overfit_partial_codex_footer(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="zsh",
        command_line="/bin/zsh -l",
        job_pid=32001,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)

    program = pd.detect_terminal_program(runtime, "Working tree clean\nContext 91% left\n")

    assert program.key == "shell"
    assert program.source == "fallback"


def test_detect_terminal_program_shell_fallback(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="zsh",
        command_line="/bin/zsh -l",
        job_pid=40001,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)

    program = pd.detect_terminal_program(runtime, "")

    assert program.key == "shell"
    assert program.label == "Shell"
    assert program.source == "fallback"
    assert program.is_agent is False
    assert program.to_dict()["isAgent"] is False


def test_detect_terminal_program_shell_from_iterm_title(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        terminal_title="-zsh",
        session_name="启动muti",
        session_pid=41001,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)

    program = pd.detect_terminal_program(runtime, "")

    assert program.key == "shell"
    assert program.label == "Shell"
    assert program.source == "fallback"
    assert program.pid == 41001
