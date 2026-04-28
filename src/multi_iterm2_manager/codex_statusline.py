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


def find_codex_statusline(text: str, *, last_n_lines: int = 20) -> CodexStatusLine | None:
    lines = (text or "").splitlines()
    for line in reversed(lines[-last_n_lines:]):
        statusline = parse_codex_statusline(line)
        if statusline is not None:
            return statusline
    return None


def _strip_ansi(value: str) -> str:
    return _ANSI_RE.sub("", value or "")
