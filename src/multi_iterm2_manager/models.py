from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4


class TerminalStatus(str, Enum):
    idle = "idle"
    running = "running"
    done = "done"
    error = "error"
    waiting = "waiting"
    closed = "closed"


@dataclass
class TerminalFrame:
    x: float
    y: float
    width: float
    height: float

    def to_dict(self) -> dict[str, float]:
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


@dataclass
class TerminalHandle:
    window_id: str
    session_id: str
    tab_id: str | None = None
    adopted_name: str | None = None  # 接管时从 iTerm2 读取的原始名字
    adopted_id: str | None = None  # 接管时从 iTerm2 读取的持久化终端 ID
    adopted_muted: bool = False  # 接管时从 iTerm2 读取的静默状态
    adopted_hidden: bool = False  # 接管时从 iTerm2 读取的隐藏状态
    adopted_tags: list[str] = field(default_factory=list)  # 接管时从 iTerm2 读取的标签


@dataclass
class TerminalRecord:
    id: str
    name: str
    handle: TerminalHandle
    command: str | None = None
    profile: str | None = None
    status: TerminalStatus = TerminalStatus.idle
    summary: str = ""
    screen_text: str = ""
    screen_html: str = ""
    frame: TerminalFrame | None = None
    markers: list[str] = field(default_factory=list)
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    is_live: bool = False
    last_error: str | None = None
    cwd: str | None = None
    hidden: bool = False
    muted: bool = False  # 静默状态，不进入通知队列
    tags: list[str] = field(default_factory=list)  # 终端标签列表
    content_hash: str = ""
    content_stable_since: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "windowId": self.handle.window_id,
            "sessionId": self.handle.session_id,
            "tabId": self.handle.tab_id,
            "command": self.command,
            "profile": self.profile,
            "status": self.status.value,
            "summary": self.summary,
            "screenText": self.screen_text,
            "screenHtml": self.screen_html,
            "frame": self.frame.to_dict() if self.frame else None,
            "markers": self.markers,
            "updatedAt": self.updated_at,
            "isLive": self.is_live,
            "lastError": self.last_error,
            "cwd": self.cwd,
            "hidden": self.hidden,
            "muted": self.muted,
            "tags": self.tags,
        }


@dataclass
class CreateTerminalParams:
    name: str
    command: str | None = None
    profile: str | None = None
    frame: TerminalFrame | None = None


@dataclass
class SendTextParams:
    text: str


@dataclass
class GridLayoutParams:
    columns: int
    rows: int
    task_ids: list[str] | None = None
    gap: float = 12.0
    padding: float = 36.0


def new_terminal_id() -> str:
    return f"task-{uuid4().hex[:8]}"
