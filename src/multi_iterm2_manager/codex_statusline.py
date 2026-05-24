from __future__ import annotations

import re
from dataclasses import dataclass

from multi_iterm2_manager.models import TerminalStatus


@dataclass(frozen=True)
class CodexStatusLine:
    raw_status: str
    status: TerminalStatus
    line: str


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_SEGMENT_SPLIT_RE = re.compile(r"\s*[·•]\s*")
_MODEL_SEGMENT_RE = re.compile(
    r"\bgpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)?\b[^\n]*\b(?:low|medium|high|xhigh)\b",
    re.IGNORECASE,
)
_CONTEXT_SEGMENT_RE = re.compile(
    r"\bContext\s+\d+%\s+(?:used|left)\b",
    re.IGNORECASE,
)
_STATUS_TO_TERMINAL = {
    "ready": TerminalStatus.done,
    "starting": TerminalStatus.running,
    "thinking": TerminalStatus.running,
    "waiting": TerminalStatus.waiting,
    "working": TerminalStatus.running,
}


def parse_codex_statusline(line: str) -> CodexStatusLine | None:
    normalized = _strip_ansi(line).strip()
    if not normalized:
        return None

    segments = [segment.strip() for segment in _SEGMENT_SPLIT_RE.split(normalized) if segment.strip()]
    if len(segments) < 3:
        return None

    has_model = any(_MODEL_SEGMENT_RE.search(segment) for segment in segments)
    has_context = any(_CONTEXT_SEGMENT_RE.search(segment) for segment in segments)
    if not has_model or not has_context:
        return None

    for segment in reversed(segments):
        status = _STATUS_TO_TERMINAL.get(segment.casefold())
        if status is not None:
            return CodexStatusLine(raw_status=segment, status=status, line=normalized)
    return None


def find_codex_statusline(
    text: str,
    *,
    last_n_lines: int = 20,
    max_wrapped_lines: int = 6,
) -> CodexStatusLine | None:
    lines = (text or "").splitlines()
    recent_lines = lines[-last_n_lines:]
    for end_index in range(len(recent_lines) - 1, -1, -1):
        statusline = parse_codex_statusline(recent_lines[end_index])
        if statusline is not None:
            return statusline

        start_limit = max(0, end_index - max(1, max_wrapped_lines) + 1)
        for start_index in range(end_index - 1, start_limit - 1, -1):
            candidate = " ".join(
                line.strip()
                for line in recent_lines[start_index:end_index + 1]
                if line.strip()
            )
            statusline = parse_codex_statusline(candidate)
            if statusline is not None:
                return statusline
    return None


def _strip_ansi(value: str) -> str:
    return _ANSI_RE.sub("", value or "")
