from __future__ import annotations

import os
import re
from typing import Iterable

from multi_iterm2_manager.codex_statusline import find_codex_statusline
from multi_iterm2_manager.models import TerminalProgramInfo, TerminalRuntimeInfo

try:
    import psutil
except Exception:
    psutil = None


_PRODUCT_PATTERNS: tuple[tuple[str, str, tuple[re.Pattern[str], ...]], ...] = (
    (
        "claude-code",
        "Claude Code",
        (
            re.compile(r"(^|[\\/\s])claude(?:$|[\s])", re.IGNORECASE),
            re.compile(r"claude-code", re.IGNORECASE),
        ),
    ),
    (
        "codex",
        "Codex",
        (
            re.compile(r"(^|[\\/\s])codex(?:$|[\s])", re.IGNORECASE),
            re.compile(r"openai[\s\-_]?codex", re.IGNORECASE),
        ),
    ),
)

_SHELL_NAMES = frozenset({
    "bash",
    "dash",
    "fish",
    "ksh",
    "nu",
    "sh",
    "tmux",
    "zsh",
})

_CLAUDE_SCREEN_PATTERNS = (
    re.compile(r"allow this action\?", re.IGNORECASE),
    re.compile(r"askuserquestion", re.IGNORECASE),
    re.compile(r"teammates running", re.IGNORECASE),
    re.compile(r"yes.*no.*always", re.IGNORECASE | re.DOTALL),
)

_CODEX_SCREEN_PATTERNS = (
    re.compile(r"\bcodex\b", re.IGNORECASE),
    re.compile(r"openai[\s\-_]?codex", re.IGNORECASE),
)

_CODEX_WORKING_SCREEN_PATTERN = re.compile(
    r"\bWorking\s*\([^\n)]*esc\s+to\s+interrupt\)",
    re.IGNORECASE,
)
_CODEX_MODEL_SCREEN_PATTERN = re.compile(
    r"\bgpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)?\b[^\n]*\b(?:low|medium|high|xhigh)\b",
    re.IGNORECASE,
)
_CODEX_CONTEXT_SCREEN_PATTERN = re.compile(
    r"\bContext\s+\d+%\s+(?:used|left)\b",
    re.IGNORECASE,
)


def _is_process_alive(pid: int | None) -> bool:
    """检查给定 PID 的进程是否仍在运行。保守策略：无法判断时返回 True。"""
    if pid is None or psutil is None:
        return True
    try:
        return psutil.pid_exists(pid) and psutil.Process(pid).is_running()
    except Exception:
        return True


def detect_terminal_program(runtime_info: TerminalRuntimeInfo, screen_text: str) -> TerminalProgramInfo:
    direct_match = _match_product_values(
        values=(runtime_info.job_name, runtime_info.command_line, runtime_info.process_title),
        source="direct",
        pid=runtime_info.job_pid or runtime_info.session_pid,
        command_line=runtime_info.command_line,
    )
    # 直接匹配成功后，验证对应进程是否仍存活
    if direct_match is not None and _is_process_alive(direct_match.pid):
        return direct_match

    process_tree_match = _detect_from_process_tree(runtime_info.job_pid or runtime_info.session_pid)
    if process_tree_match is not None:
        return process_tree_match

    screen_match = _detect_from_screen(screen_text)
    if screen_match is not None:
        if screen_match.pid is None:
            screen_match.pid = runtime_info.job_pid or runtime_info.session_pid
        if not screen_match.command_line:
            screen_match.command_line = runtime_info.command_line
        # 屏幕文本匹配成功后，验证对应进程是否仍存活
        if _is_process_alive(screen_match.pid):
            return screen_match

    if _looks_like_shell(runtime_info):
        return TerminalProgramInfo(
            key="shell",
            label="Shell",
            source="fallback",
            pid=runtime_info.job_pid or runtime_info.session_pid,
            command_line=runtime_info.command_line,
        )

    return TerminalProgramInfo(
        key="unknown",
        label="Unknown",
        source="fallback",
        pid=runtime_info.job_pid or runtime_info.session_pid,
        command_line=runtime_info.command_line,
    )


def _match_product_values(
    values: Iterable[str | None],
    *,
    source: str,
    pid: int | None,
    command_line: str | None,
) -> TerminalProgramInfo | None:
    for value in values:
        matched = _match_product(value)
        if matched is None:
            continue
        key, label = matched
        return TerminalProgramInfo(
            key=key,
            label=label,
            source=source,
            pid=pid,
            command_line=command_line or value,
        )
    return None


def _match_product(value: str | None) -> tuple[str, str] | None:
    if not value:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    for key, label, patterns in _PRODUCT_PATTERNS:
        if any(pattern.search(normalized) for pattern in patterns):
            return key, label
    return None


def _detect_from_process_tree(root_pid: int | None) -> TerminalProgramInfo | None:
    if root_pid is None or psutil is None:
        return None
    try:
        root = psutil.Process(root_pid)
    except Exception:
        return None

    seen: set[int] = set()
    related: list = []

    def _append_process(proc) -> None:
        try:
            pid = int(proc.pid)
        except Exception:
            return
        if pid in seen:
            return
        seen.add(pid)
        related.append(proc)

    _append_process(root)
    try:
        for child in root.children(recursive=True):
            _append_process(child)
            if len(related) >= 20:
                break
    except Exception:
        pass

    try:
        for parent in root.parents():
            _append_process(parent)
            if len(related) >= 24:
                break
    except Exception:
        pass

    for proc in related:
        command_line = _safe_process_command_line(proc)
        matched = _match_product_values(
            values=(_safe_process_name(proc), command_line),
            source="process-tree",
            pid=_safe_process_pid(proc),
            command_line=command_line,
        )
        if matched is not None:
            return matched
    return None


def _detect_from_screen(screen_text: str) -> TerminalProgramInfo | None:
    text = (screen_text or "").strip()
    if not text:
        return None
    window = text[-3000:]
    if any(pattern.search(window) for pattern in _CLAUDE_SCREEN_PATTERNS):
        return TerminalProgramInfo(key="claude-code", label="Claude Code", source="screen-heuristic")
    if _looks_like_codex_screen(window):
        return TerminalProgramInfo(key="codex", label="Codex", source="screen-heuristic")
    return None


def _looks_like_codex_screen(text: str) -> bool:
    if find_codex_statusline(text) is not None:
        return True

    if any(pattern.search(text) for pattern in _CODEX_SCREEN_PATTERNS):
        return True

    score = 0
    if _CODEX_WORKING_SCREEN_PATTERN.search(text):
        score += 2
    if _CODEX_MODEL_SCREEN_PATTERN.search(text):
        score += 1
    if _CODEX_CONTEXT_SCREEN_PATTERN.search(text):
        score += 1
    return score >= 2


def _looks_like_shell(runtime_info: TerminalRuntimeInfo) -> bool:
    candidates = [
        runtime_info.job_name,
        runtime_info.process_title,
        runtime_info.terminal_title,
        runtime_info.session_name,
    ]
    if runtime_info.command_line:
        candidates.append(runtime_info.command_line.split()[0])

    for candidate in candidates:
        if not candidate:
            continue
        executable = _normalize_shell_candidate(candidate)
        if executable in _SHELL_NAMES:
            return True
    return False


def _normalize_shell_candidate(candidate: str) -> str:
    executable = os.path.basename(candidate.strip()).lower()
    # iTerm2/macOS often exposes login shells as "-zsh" in titles/process names.
    return executable.lstrip("-")


def _safe_process_name(proc) -> str | None:
    try:
        name = proc.name()
    except Exception:
        return None
    return name or None


def _safe_process_command_line(proc) -> str | None:
    try:
        parts = proc.cmdline()
    except Exception:
        return None
    if not parts:
        return None
    return " ".join(part for part in parts if part)


def _safe_process_pid(proc) -> int | None:
    try:
        return int(proc.pid)
    except Exception:
        return None
