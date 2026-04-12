"""App 监控模块的数据模型定义"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4


class AppMonitorStatus(str, Enum):
    """被监控 App 的状态"""
    active = "active"
    stopped = "stopped"
    error = "error"
    gone = "gone"


@dataclass
class MonitoredApp:
    """被监控的 App 记录"""
    id: str
    pid: int
    bundle_id: str
    app_name: str
    window_title: str
    window_number: int
    owner_name: str
    screenshot_b64: str = ""
    screenshot_width: int = 0
    screenshot_height: int = 0
    frame: dict = field(default_factory=dict)
    status: AppMonitorStatus = AppMonitorStatus.active
    last_error: str | None = None
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "pid": self.pid,
            "bundleId": self.bundle_id,
            "appName": self.app_name,
            "windowTitle": self.window_title,
            "windowNumber": self.window_number,
            "ownerName": self.owner_name,
            "screenshotB64": self.screenshot_b64,
            "screenshotWidth": self.screenshot_width,
            "screenshotHeight": self.screenshot_height,
            "frame": self.frame,
            "status": self.status.value,
            "lastError": self.last_error,
            "updatedAt": self.updated_at,
        }


@dataclass
class DiscoveredWindow:
    """发现的可视窗口"""
    pid: int
    bundle_id: str
    app_name: str
    window_title: str
    window_number: int
    owner_name: str
    frame: dict
    is_on_screen: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "bundleId": self.bundle_id,
            "appName": self.app_name,
            "windowTitle": self.window_title,
            "windowNumber": self.window_number,
            "ownerName": self.owner_name,
            "frame": self.frame,
            "isOnScreen": self.is_on_screen,
        }


@dataclass
class AppMonitorSettings:
    """App 监控配置"""
    screenshot_interval_sec: float = 2.0
    screenshot_quality: float = 0.3
    max_width: int = 800

    def to_dict(self) -> dict[str, Any]:
        return {
            "screenshotIntervalSec": self.screenshot_interval_sec,
            "screenshotQuality": self.screenshot_quality,
            "maxWidth": self.max_width,
        }


def new_app_monitor_id() -> str:
    """生成新的 App 监控 ID"""
    return f"app-{uuid4().hex[:8]}"
