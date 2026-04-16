from __future__ import annotations

import multi_iterm2_manager.program_detection as pd
from multi_iterm2_manager.models import TerminalProgramInfo, TerminalRuntimeInfo


def test_detect_terminal_program_direct_claude_code() -> None:
    runtime = TerminalRuntimeInfo(
        job_name="claude",
        command_line="claude",
        job_pid=12345,
    )

    program = pd.detect_terminal_program(runtime, "")

    assert program.key == "claude-code"
    assert program.label == "Claude Code"
    assert program.source == "direct"
    assert program.pid == 12345


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


def test_detect_terminal_program_from_screen_heuristic(monkeypatch) -> None:
    runtime = TerminalRuntimeInfo(
        job_name="tmux",
        command_line="tmux attach",
        job_pid=30001,
    )

    monkeypatch.setattr(pd, "_detect_from_process_tree", lambda pid: None)

    program = pd.detect_terminal_program(runtime, "Allow this action?\n")

    assert program.key == "claude-code"
    assert program.source == "screen-heuristic"


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
