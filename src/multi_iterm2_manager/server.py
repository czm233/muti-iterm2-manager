from __future__ import annotations

import asyncio
from contextlib import suppress
from uuid import uuid4

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from multi_iterm2_manager import __version__
from multi_iterm2_manager.config import (
    UiSettings,
    delete_screen_layout,
    ensure_preset_layout,
    get_default_layout_for_screen,
    get_screen_layout,
    get_screen_layouts,
    load_settings,
    save_screen_layout,
    set_default_layout,
)
from multi_iterm2_manager.display import get_current_screen_config
from multi_iterm2_manager.models import (
    CreateTerminalParams,
    GridLayoutParams,
    ScreenLayoutConfig,
    TerminalFrame,
    TerminalLayout,
)
from multi_iterm2_manager.service import DashboardService
from multi_iterm2_manager.app_monitor.routes import router as app_monitor_router, set_service


class CachedStaticFiles(StaticFiles):
    """对静态资源响应添加 Cache-Control 头（开发模式下不缓存 JS/CSS）"""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def _send_with_cache(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                path = scope.get("path", "")
                if path.endswith((".js", ".css", ".html")):
                    headers.append((b"cache-control", b"no-cache, no-store, must-revalidate"))
                else:
                    headers.append((b"cache-control", b"max-age=86400"))
                message["headers"] = headers
            await send(message)

        await super().__call__(scope, receive, _send_with_cache)


def _live_version() -> str:
    """实时读取版本号，避免修改后需要重启才能生效"""
    import importlib, multi_iterm2_manager as _pkg
    importlib.reload(_pkg)
    return _pkg.__version__


settings = load_settings()
service = DashboardService(settings)
app = FastAPI(title="多 iTerm2 管理器", version=__version__)
app.mount("/assets", CachedStaticFiles(directory=service.static_dir()), name="assets")
set_service(service.app_monitor)
app.include_router(app_monitor_router)


async def _apply_screen_layout(
    screen_name: str,
    layout: ScreenLayoutConfig | None,
    *,
    persist_default: bool = False,
) -> dict:
    """将指定屏幕布局应用到当前活跃终端。"""
    if not layout:
        return {
            "screenName": screen_name,
            "layoutId": "",
            "applied": 0,
            "notFound": [],
            "errors": [],
        }

    applied = 0
    not_found: list[str] = []
    errors: list[dict[str, str]] = []

    if layout.is_preset and not layout.terminals:
        from .display import build_preset_frame

        frame_data = build_preset_frame(screen_name)
        if not frame_data:
            raise RuntimeError(f"无法获取屏幕 {screen_name} 的信息")
        frame = TerminalFrame(**frame_data)
        for record in service.records.values():
            if record.status.value != "closed":
                try:
                    await service.set_frame(record.id, frame)
                    applied += 1
                except Exception as exc:
                    errors.append({"terminal_id": record.id, "error": str(exc)})
    else:
        for terminal_id, terminal_layout in layout.terminals.items():
            record = service.records.get(terminal_id)
            if not record:
                not_found.append(terminal_id)
                continue
            try:
                frame = TerminalFrame(
                    x=terminal_layout.x,
                    y=terminal_layout.y,
                    width=terminal_layout.width,
                    height=terminal_layout.height,
                )
                await service.set_frame(terminal_id, frame)
                applied += 1
            except Exception as exc:
                errors.append({"terminal_id": terminal_id, "error": str(exc)})

    if persist_default and layout.layout_id:
        set_default_layout(screen_name, layout.layout_id)

    return {
        "screenName": screen_name,
        "layoutId": layout.layout_id,
        "applied": applied,
        "notFound": not_found,
        "errors": errors,
    }


async def _apply_target_screen_default_layout(target_screen: int | None = None) -> dict | None:
    """对当前目标屏幕补应用一次默认布局，覆盖重启恢复时的错位窗口。"""
    screens = service.get_screens()
    target_index = service.get_target_screen() if target_screen is None else target_screen
    if target_index < 0 or target_index >= len(screens):
        return None

    screen_name = screens[target_index]["name"]
    ensure_preset_layout(screen_name)
    default_layout = get_default_layout_for_screen(screen_name)
    if not default_layout:
        return None

    return await _apply_screen_layout(screen_name, default_layout, persist_default=False)


class FramePayload(BaseModel):
    x: float
    y: float
    width: float = Field(gt=100)
    height: float = Field(gt=100)


class DefaultFramePayload(BaseModel):
    x: float
    y: float
    width: float = Field(gt=100)
    height: float = Field(gt=100)
    screen_name: str | None = None


class CreateTerminalPayload(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    command: str | None = None
    profile: str | None = None
    frame: FramePayload | None = None
    tags: list[str] | None = None
    browser_x: float | None = None
    browser_y: float | None = None


class FocusTerminalPayload(BaseModel):
    browser_x: float | None = None
    browser_y: float | None = None


class SendTextPayload(BaseModel):
    text: str = Field(min_length=1)


class RenamePayload(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class CreateDemoPayload(BaseModel):
    count: int = Field(default=4, ge=1, le=12)


class GridLayoutPayload(BaseModel):
    columns: int = Field(default=2, ge=1, le=6)
    rows: int = Field(default=2, ge=1, le=6)
    task_ids: list[str] | None = None
    gap: float = Field(default=12.0, ge=0.0, le=64.0)
    padding: float = Field(default=36.0, ge=0.0, le=128.0)


class AdoptPayload(BaseModel):
    session_id: str
    name: str | None = Field(default=None, max_length=60)


class SetHiddenPayload(BaseModel):
    hidden: bool


class SetMutedPayload(BaseModel):
    muted: bool


class SetTagsPayload(BaseModel):
    tags: list[str] = Field(default_factory=list, max_length=10)


class UiSettingsPayload(BaseModel):
    dashboard_padding_px: int = Field(default=4, ge=0, le=48)
    monitor_stage_padding_px: int = Field(default=12, ge=0, le=64)
    dashboard_gap_px: int = Field(default=6, ge=0, le=48)
    monitor_grid_gap_px: int = Field(default=6, ge=0, le=48)
    wall_card_padding_px: int = Field(default=10, ge=0, le=48)
    wall_card_border_radius_px: int = Field(default=22, ge=0, le=48)
    wall_card_border_width_px: float = Field(default=1.0, ge=0.0, le=8.0)
    wall_card_terminal_border_width_px: float = Field(default=1.0, ge=0.0, le=8.0)
    split_resizer_hit_area_px: int = Field(default=14, ge=4, le=48)
    split_resizer_line_width_px: int = Field(default=2, ge=0, le=8)
    grid_resizer_hit_area_px: int = Field(default=16, ge=4, le=48)
    grid_resizer_line_width_px: int = Field(default=2, ge=0, le=8)
    filter_tab_slide_duration_ms: int = Field(default=420, ge=50, le=5000)
    terminal_font_size_px: int = Field(default=10, ge=6, le=24)


@app.on_event("startup")
async def on_startup() -> None:
    await service.start()
    try:
        await _apply_target_screen_default_layout()
    except Exception as exc:
        print(f"[startup] 应用默认屏幕布局失败: {exc}", flush=True)


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await service.stop()


@app.get("/")
async def index() -> HTMLResponse:
    static_dir = service.static_dir()
    html = (static_dir / "index.html").read_text(encoding="utf-8")
    css_version = int((static_dir / "styles.css").stat().st_mtime)
    js_version = int((static_dir / "app.js").stat().st_mtime)
    build_version = f"v{_live_version()}-{js_version}"
    html = html.replace('{{BUILD_VERSION}}', build_version)
    html = html.replace('/assets/styles.css', f'/assets/styles.css?v={css_version}')
    html = html.replace('/assets/app.js', f'/assets/app.js?v={js_version}')
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/api/health")
async def health() -> dict:
    status = await service.health_status()
    status["version"] = _live_version()
    return status


@app.get("/api/system-stats")
async def system_stats() -> dict:
    """获取系统资源使用率（CPU、内存、磁盘）"""
    return await asyncio.to_thread(service.system_stats)


@app.get("/api/screens")
async def get_screens() -> dict:
    """获取所有可用屏幕列表"""
    screens = service.get_screens()
    return {"items": screens, "targetScreen": service.get_target_screen()}


class TargetScreenPayload(BaseModel):
    target_screen: int = Field(default=-1, ge=-1)


@app.put("/api/screens/target")
async def set_target_screen(payload: TargetScreenPayload) -> dict:
    """设置目标屏幕，并自动应用该屏幕的默认布局"""
    screens = service.get_screens()
    if payload.target_screen >= len(screens):
        raise HTTPException(status_code=400, detail=f"屏幕索引超出范围，当前共 {len(screens)} 个屏幕")
    service.set_target_screen(payload.target_screen)

    if payload.target_screen < 0:
        # -1 表示不指定当前屏幕，只保存配置，不触发布局应用。
        return {"targetScreen": service.get_target_screen()}

    await _apply_target_screen_default_layout(payload.target_screen)
    return {"targetScreen": service.get_target_screen()}


@app.get("/api/ui-settings")
async def get_ui_settings() -> dict:
    payload = service.ui_settings_payload()
    payload["defaults"] = UiSettings().to_dict()
    return payload


@app.put("/api/ui-settings")
async def put_ui_settings(payload: UiSettingsPayload) -> dict:
    try:
        return await service.update_ui_settings(payload.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/terminals")
async def list_terminals() -> dict:
    return {"items": service.list_terminals(), "layout": service.monitor_layout(), "allTags": service.list_all_tags()}


@app.post("/api/terminals")
async def create_terminal(payload: CreateTerminalPayload) -> dict:
    try:
        frame = None
        if payload.frame is not None:
            frame = TerminalFrame(**payload.frame.model_dump())
        terminal = await service.create_terminal(
            CreateTerminalParams(
                name=payload.name,
                command=payload.command,
                profile=payload.profile,
                frame=frame,
                browser_x=payload.browser_x,
                browser_y=payload.browser_y,
            )
        )
        # 如果传入了 tags，创建后立即设置标签（失败时降级，终端仍正常返回）
        if payload.tags:
            try:
                terminal = await service.set_tags(terminal["id"], payload.tags)
            except Exception:
                pass
        return {"item": terminal, "layout": service.monitor_layout(), "allTags": service.list_all_tags()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/demo")
async def create_demo(payload: CreateDemoPayload) -> dict:
    try:
        items = await service.create_demo_terminals(payload.count)
        return {"items": items, "layout": service.monitor_layout()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/close-all")
async def close_all_terminals() -> dict:
    try:
        return {"items": await service.close_all_terminals(), "layout": service.monitor_layout()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/workspace/monitor-mode")
async def monitor_mode() -> dict:
    try:
        return await service.enter_monitor_mode()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/rename")
async def rename_terminal(terminal_id: str, payload: RenamePayload) -> dict:
    try:
        return {"item": await service.rename_terminal(terminal_id, payload.name), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/hidden")
async def set_terminal_hidden(terminal_id: str, payload: SetHiddenPayload) -> dict:
    try:
        return {"item": await service.set_hidden(terminal_id, payload.hidden), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/tags")
async def set_terminal_tags(terminal_id: str, payload: SetTagsPayload) -> dict:
    """设置终端标签"""
    try:
        return {"item": await service.set_tags(terminal_id, payload.tags), "layout": service.monitor_layout(), "allTags": service.list_all_tags()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/muted")
async def set_terminal_muted(terminal_id: str, payload: SetMutedPayload) -> dict:
    """设置终端静默状态"""
    try:
        return {"item": await service.set_muted(terminal_id, payload.muted), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/tags")
async def list_all_tags() -> dict:
    """获取所有终端的标签列表（去重排序）"""
    return {"items": service.list_all_tags()}


@app.post("/api/terminals/{terminal_id}/focus")
async def focus_terminal(terminal_id: str, payload: FocusTerminalPayload | None = None) -> dict:
    try:
        browser_x = payload.browser_x if payload else None
        browser_y = payload.browser_y if payload else None
        return {"item": await service.focus_terminal(terminal_id, browser_x, browser_y), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/close")
async def close_terminal(terminal_id: str) -> dict:
    try:
        return {"item": await service.close_terminal(terminal_id), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/detach")
async def detach_terminal(terminal_id: str) -> dict:
    try:
        return await service.detach_terminal(terminal_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/iterm2/sessions")
async def scan_sessions() -> dict:
    try:
        sessions = await service.scan_sessions()
        return {"items": sessions}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/adopt")
async def adopt_terminal(payload: AdoptPayload) -> dict:
    try:
        terminal = await service.adopt_terminal(payload.session_id, payload.name)
        return {"item": terminal, "layout": service.monitor_layout()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/refresh")
async def refresh_terminal(terminal_id: str) -> dict:
    try:
        return {"item": await service.refresh_terminal(terminal_id), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/send-text")
async def send_text(terminal_id: str, payload: SendTextPayload) -> dict:
    try:
        return {"item": await service.send_text(terminal_id, payload.text), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/terminals/{terminal_id}/frame")
async def get_frame(terminal_id: str) -> dict:
    """实时获取终端窗口的当前位置和大小"""
    try:
        return await service.get_live_frame(terminal_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/terminals/{terminal_id}/frame")
async def set_frame(terminal_id: str, payload: FramePayload) -> dict:
    try:
        return {"item": await service.set_frame(terminal_id, TerminalFrame(**payload.model_dump())), "layout": service.monitor_layout()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/layouts/grid")
async def layout_grid(payload: GridLayoutPayload) -> dict:
    try:
        return await service.apply_grid_layout(
            GridLayoutParams(
                columns=payload.columns,
                rows=payload.rows,
                task_ids=payload.task_ids,
                gap=payload.gap,
                padding=payload.padding,
            )
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ============ 默认窗口位置 API ============


@app.get("/api/default-frame")
async def get_default_frame(screen_name: str | None = None) -> dict:
    """获取默认窗口模板，若未设置则返回 null。可传入 screen_name 查找特定屏幕的默认位置"""
    return {
        "defaultFrame": service.get_default_frame(screen_name),
        "allFrames": service.ui_settings.default_frames_by_screen,
    }


@app.put("/api/default-frame")
async def set_default_frame(payload: DefaultFramePayload) -> dict:
    """设置默认窗口模板（按屏幕名称存储）。未传 screen_name 时自动从坐标检测。"""
    try:
        screen_name = payload.screen_name
        if not screen_name:
            from multi_iterm2_manager.display import get_screen_name_from_coordinates
            screen_name = get_screen_name_from_coordinates(payload.x, payload.y)
        if not screen_name:
            raise ValueError("无法确定当前屏幕，请确保窗口在有效屏幕范围内")
        return await service.set_default_frame(
            TerminalFrame(x=payload.x, y=payload.y, width=payload.width, height=payload.height),
            screen_name=screen_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/default-frame/apply-all")
async def apply_default_frame_to_all() -> dict:
    """将默认位置应用到所有活跃终端"""
    try:
        return await service.apply_default_frame_to_all()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ============ 屏幕配置快照 API ============


@app.get("/api/screen-configs")
async def get_screen_configs() -> dict:
    """获取所有屏幕配置和当前屏幕信息（嵌套布局结构）"""
    from .display import get_all_screens

    current_config = get_current_screen_config()

    # 获取目标弹出屏幕的名称
    screens = get_all_screens()
    target_index = service.get_target_screen()
    target_screen_name = None
    if 0 <= target_index < len(screens):
        target_screen_name = screens[target_index].get("name")

    # 确保所有检测到的屏幕都有预设布局
    for screen in screens:
        ensure_preset_layout(screen["name"])

    layout_groups = get_screen_layouts()

    # 返回嵌套结构：screen_name -> { screenName, layouts: { layout_id -> layout_dict } }
    saved_layouts = {}
    for screen_name, screen_layouts in layout_groups.items():
        saved_layouts[screen_name] = {
            "screenName": screen_name,
            "layouts": {
                layout_id: layout.to_dict()
                for layout_id, layout in screen_layouts.items()
            },
        }

    return {
        "current": {
            "fingerprint": current_config.fingerprint,
            "configName": current_config.config_name,
            "primaryScreen": current_config.primary_screen_name,
            "screens": [s.to_dict() for s in current_config.screens],
        },
        "targetScreenName": target_screen_name,
        "savedLayouts": saved_layouts,
    }


class SaveLayoutPayload(BaseModel):
    config_name: str | None = None


async def _collect_live_terminal_layouts() -> dict[str, TerminalLayout]:
    """实时读取活跃终端窗口位置，避免使用过期的内存 frame。"""
    terminals: dict[str, TerminalLayout] = {}
    for record in service.records.values():
        if record.status.value == "closed":
            continue
        try:
            live_frame = await service.backend.get_frame(record.handle)
        except Exception:
            live_frame = None
        if live_frame is None:
            live_frame = record.frame
        if live_frame is None:
            continue
        record.frame = live_frame
        terminals[record.id] = TerminalLayout(
            terminal_id=record.id,
            x=int(live_frame.x),
            y=int(live_frame.y),
            width=int(live_frame.width),
            height=int(live_frame.height),
        )
    return terminals


@app.post("/api/screen-configs/save")
async def save_current_layout(payload: SaveLayoutPayload | None = None) -> dict:
    """保存当前终端布局为新布局（生成唯一 layout_id）"""
    from datetime import datetime

    current_config = get_current_screen_config()

    # 获取当前所有活跃终端的实时位置
    terminals = await _collect_live_terminal_layouts()

    # 使用目标弹出屏幕名称作为 key
    screens = service.get_screens()
    target_index = service.get_target_screen()
    screen_name = screens[target_index]["name"] if 0 <= target_index < len(screens) else current_config.primary_screen_name
    config_name = payload.config_name if payload and payload.config_name else f"{screen_name} 布局"

    # 检查同名布局
    existing_layouts = get_screen_layouts()
    screen_group = existing_layouts.get(screen_name, {})
    for lid, l in screen_group.items():
        if l.config_name == config_name:
            raise HTTPException(status_code=409, detail=f"该屏幕已有名为「{config_name}」的布局，请使用其他名称")

    layout_id = f"user_{uuid4().hex[:8]}"
    layout = ScreenLayoutConfig(
        screen_name=screen_name,
        config_name=config_name,
        created_at=datetime.now().isoformat(timespec="seconds"),
        terminals=terminals,
        layout_id=layout_id,
    )

    # 保存到配置文件，使用屏幕名称和 layout_id
    save_screen_layout(screen_name, layout_id, layout)

    return {
        "success": True,
        "screenName": screen_name,
        "layoutId": layout_id,
        "terminalCount": len(terminals),
        "layout": layout.to_dict(),
    }


@app.put("/api/screen-configs/{screen_name}/{layout_id}")
async def update_screen_layout(screen_name: str, layout_id: str) -> dict:
    """更新已有布局的终端位置（保持名称等不变）"""
    existing = get_screen_layout(screen_name, layout_id)
    if not existing:
        raise HTTPException(status_code=404, detail="布局不存在")

    # 获取当前所有活跃终端的实时位置
    terminals = await _collect_live_terminal_layouts()

    # 更新布局（保留原名称、默认状态等）
    existing.terminals = terminals
    save_screen_layout(screen_name, layout_id, existing)

    return {
        "success": True,
        "screenName": screen_name,
        "layoutId": layout_id,
        "terminalCount": len(terminals),
    }


@app.delete("/api/screen-configs/{screen_name}/{layout_id}")
async def delete_screen_config(screen_name: str, layout_id: str) -> dict:
    """删除指定屏幕的指定布局"""
    success = delete_screen_layout(screen_name, layout_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"布局 {screen_name}/{layout_id} 不存在或无法删除")
    return {"success": True, "screenName": screen_name, "layoutId": layout_id}


@app.post("/api/screen-configs/{screen_name}/{layout_id}/apply")
async def apply_screen_config(screen_name: str, layout_id: str) -> dict:
    """应用指定屏幕的指定布局，将保存的位置应用到终端窗口"""
    layout = get_screen_layout(screen_name, layout_id)
    if not layout:
        raise HTTPException(status_code=404, detail=f"布局 {screen_name}/{layout_id} 不存在")

    try:
        result = await _apply_screen_layout(screen_name, layout, persist_default=True)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "success": True,
        "screenName": result["screenName"],
        "layoutId": result["layoutId"],
        "applied": result["applied"],
        "notFound": result["notFound"],
        "errors": result["errors"],
    }


@app.post("/api/screen-configs/{screen_name}/{layout_id}/set-default")
async def set_default_layout_api(screen_name: str, layout_id: str) -> dict:
    """将指定布局设为该屏幕的默认布局"""
    success = set_default_layout(screen_name, layout_id)
    if not success:
        raise HTTPException(status_code=404, detail="布局不存在")
    return {"success": True, "screenName": screen_name, "layoutId": layout_id}


@app.websocket("/ws")
async def websocket_updates(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = await service.subscribe()

    async def sender() -> None:
        while True:
            payload = await queue.get()
            await websocket.send_json(payload)

    send_task = asyncio.create_task(sender())
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        with suppress(asyncio.CancelledError):
            await send_task
        service.unsubscribe(queue)
