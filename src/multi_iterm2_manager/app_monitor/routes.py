"""App 监控 API 路由"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/app-monitor", tags=["app-monitor"])

_service = None


def set_service(svc) -> None:
    """注入 AppMonitorService 实例（避免循环依赖）"""
    global _service
    _service = svc


class AddMonitorPayload(BaseModel):
    pid: int = Field(...)
    windowNumber: int = Field(...)
    appName: str = ""
    windowTitle: str = ""
    bundleId: str = ""
    ownerName: str = ""


class UpdateSettingsPayload(BaseModel):
    screenshotIntervalSec: float = Field(default=2.0, ge=0.5, le=30.0)
    screenshotQuality: float = Field(default=0.6, ge=0.1, le=1.0)
    maxWidth: int = Field(default=800, ge=200, le=1920)


@router.get("/windows")
async def discover_windows():
    """发现所有可见窗口"""
    return {"items": await _service.discover_windows()}


@router.get("/monitors")
async def list_monitors():
    """列出所有监控"""
    return {"items": _service.list_monitors()}


@router.post("/monitors")
async def add_monitor(payload: AddMonitorPayload):
    """添加监控"""
    try:
        item = await _service.add_monitor(
            pid=payload.pid,
            window_number=payload.windowNumber,
            app_name=payload.appName,
            window_title=payload.windowTitle,
            bundle_id=payload.bundleId,
            owner_name=payload.ownerName,
        )
        return {"item": item}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/monitors/{app_id}")
async def remove_monitor(app_id: str):
    """移除监控"""
    try:
        return {"item": await _service.remove_monitor(app_id)}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/monitors/{app_id}/focus")
async def focus_app(app_id: str):
    """唤醒 App 到前台"""
    try:
        await _service.focus_app(app_id)
        return {"success": True}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/settings")
async def get_settings():
    """获取监控设置"""
    return {"settings": _service.settings.to_dict()}


@router.put("/settings")
async def update_settings(payload: UpdateSettingsPayload):
    """更新监控设置"""
    from multi_iterm2_manager.app_monitor.models import AppMonitorSettings
    _service.settings = AppMonitorSettings(
        screenshot_interval_sec=payload.screenshotIntervalSec,
        screenshot_quality=payload.screenshotQuality,
        max_width=payload.maxWidth,
    )
    return {"settings": _service.settings.to_dict()}
