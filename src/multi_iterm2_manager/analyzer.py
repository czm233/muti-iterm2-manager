from __future__ import annotations

import re

from multi_iterm2_manager.models import TerminalStatus

DONE_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in [
        r"任务完成",
        r"已完成",
        r"完成啦",
        r"\bdone\b",
        r"\bsuccess\b",
        r"\bcompleted\b",
        r"\bfinished\b",
    ]
]

ERROR_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in [
        r"错误",
        r"失败",
        r"异常",
        r"traceback",
        r"\berror\b",
        r"\bfatal\b",
        r"\bpanic\b",
    ]
]

WAITING_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in [
        r"等待输入",
        r"请输入",
        r"waiting for input",
        r"press any key",
        r"confirm",
    ]
]


def analyze_screen_text(text: str) -> tuple[TerminalStatus, list[str], str]:
    normalized = text.strip()
    if not normalized:
        return TerminalStatus.idle, [], "暂无输出"

    markers: list[str] = []

    for pattern in ERROR_PATTERNS:
        if pattern.search(normalized):
            markers.append(pattern.pattern)
    if markers:
        return TerminalStatus.error, markers, summarize_text(normalized)

    for pattern in DONE_PATTERNS:
        if pattern.search(normalized):
            markers.append(pattern.pattern)
    if markers:
        return TerminalStatus.done, markers, summarize_text(normalized)

    for pattern in WAITING_PATTERNS:
        if pattern.search(normalized):
            markers.append(pattern.pattern)
    if markers:
        return TerminalStatus.waiting, markers, summarize_text(normalized)

    return TerminalStatus.running, [], summarize_text(normalized)


def summarize_text(text: str, max_lines: int = 3, max_chars: int = 240) -> str:
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "暂无输出"

    summary = " | ".join(lines[-max_lines:])
    if len(summary) > max_chars:
        return summary[-max_chars:]
    return summary
