from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4


# ============ 屏幕配置相关模型 ============


@dataclass
class ScreenInfo:
    """单个屏幕信息"""
    name: str  # 屏幕名称如 "Color LCD" / "MI"
    width: int
    height: int
    x: int  # 在虚拟坐标系中的位置
    y: int
    is_primary: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "width": self.width,
            "height": self.height,
            "x": self.x,
            "y": self.y,
            "isPrimary": self.is_primary,
        }


@dataclass
class ScreenConfig:
    """屏幕配置快照"""
    fingerprint: str  # 屏幕配置指纹 (8位)
    config_name: str = ""  # 用户友好的配置名称
    primary_screen_name: str = ""
    screens: list[ScreenInfo] = field(default_factory=list)
    created_at: str = ""  # ISO 格式时间戳

    def to_dict(self) -> dict[str, Any]:
        return {
            "fingerprint": self.fingerprint,
            "configName": self.config_name,
            "primaryScreenName": self.primary_screen_name,
            "screens": [s.to_dict() for s in self.screens],
            "createdAt": self.created_at,
        }


@dataclass
class TerminalLayout:
    """单个终端的位置信息"""
    terminal_id: str
    x: int
    y: int
    width: int
    height: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "terminalId": self.terminal_id,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


@dataclass
class ScreenLayoutConfig:
    """完整的屏幕布局配置"""
    screen_name: str = ""  # 关联的屏幕名称（主屏幕名称）
    config_name: str = ""
    created_at: str = ""
    terminals: dict[str, TerminalLayout] = field(default_factory=dict)
    is_preset: bool = False  # 是否为系统预设布局
    is_default: bool = False  # 是否为该屏幕的默认布局
    layout_id: str = ""  # 布局在屏幕组内的唯一ID

    def to_dict(self) -> dict[str, Any]:
        return {
            "screenName": self.screen_name,
            "configName": self.config_name,
            "createdAt": self.created_at,
            "terminals": {k: v.to_dict() for k, v in self.terminals.items()},
            "isPreset": self.is_preset,
            "isDefault": self.is_default,
            "layoutId": self.layout_id,
        }


# ============ 终端相关模型 ============


class TerminalStatus(str, Enum):
    idle = "idle"
    running = "running"
    done = "done"
    error = "error"
    waiting = "waiting"
    closed = "closed"


_AGENT_PROGRAM_KEYS = frozenset({"claude-code", "codex"})


@dataclass
class TerminalRuntimeInfo:
    job_name: str | None = None
    command_line: str | None = None
    job_pid: int | None = None
    process_title: str | None = None
    terminal_title: str | None = None
    session_name: str | None = None
    tty: str | None = None
    session_pid: int | None = None


@dataclass
class TerminalProgramInfo:
    key: str = "unknown"
    label: str = "Unknown"
    source: str = "none"
    pid: int | None = None
    command_line: str | None = None

    @property
    def is_agent(self) -> bool:
        return self.key in _AGENT_PROGRAM_KEYS

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "source": self.source,
            "pid": self.pid,
            "commandLine": self.command_line,
            "isAgent": self.is_agent,
        }


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
    adopted_primary: bool = False  # 接管时从 iTerm2 读取的最重要任务状态


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
    is_primary: bool = False  # 当前唯一最重要任务标记
    program: TerminalProgramInfo = field(default_factory=TerminalProgramInfo)
    content_hash: str = ""
    content_stable_since: float = 0.0
    ai_summary: str = ""
    ai_summary_at: float = 0.0
    ai_summary_status: str = "none"  # "none" | "summarizing" | "done" | "fallback"
    ai_summary_reason: str = ""  # 状态原因："" | "no_api" | "cooldown" | "idle" | "content_changing" | "api_error" | "empty_response"
    ai_summary_error_detail: str = ""
    ai_summary_first: bool = True  # 首次总结标记（启动后立即执行）
    last_interaction_at: float = 0.0  # 首次接管只建基线；后续 LLM 屏幕内容变化才更新
    interaction_content_hash: str = ""  # 过滤状态行后的 LLM 内容指纹，不对外展示

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
            "isPrimary": self.is_primary,
            "program": self.program.to_dict(),
            "aiSummary": self.ai_summary,
            "aiSummaryAt": self.ai_summary_at,
            "aiSummaryStatus": self.ai_summary_status,
            "aiSummaryReason": self.ai_summary_reason,
            "aiSummaryErrorDetail": self.ai_summary_error_detail,
            "lastInteractionAt": self.last_interaction_at,
        }


@dataclass
class CreateTerminalParams:
    name: str
    command: str | None = None
    profile: str | None = None
    cwd: str | None = None
    frame: TerminalFrame | None = None
    browser_x: float | None = None
    browser_y: float | None = None


@dataclass
class SplitTerminalParams:
    vertical: bool
    cwd: str | None = None
    profile: str | None = None


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
