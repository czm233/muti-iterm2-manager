from __future__ import annotations

import asyncio
from contextlib import suppress

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from multi_iterm2_manager import __version__
from multi_iterm2_manager.config import UiSettings, load_settings
from multi_iterm2_manager.models import CreateTerminalParams, GridLayoutParams, TerminalFrame
from multi_iterm2_manager.service import DashboardService

settings = load_settings()
service = DashboardService(settings)
app = FastAPI(title="多 iTerm2 管理器", version=__version__)
app.mount("/assets", StaticFiles(directory=service.static_dir()), name="assets")


class FramePayload(BaseModel):
    x: float
    y: float
    width: float = Field(gt=100)
    height: float = Field(gt=100)


class CreateTerminalPayload(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    command: str | None = None
    profile: str | None = None
    frame: FramePayload | None = None


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


class UiSettingsPayload(BaseModel):
    dashboard_padding_px: int = Field(default=4, ge=0, le=48)
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


@app.on_event("startup")
async def on_startup() -> None:
    await service.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await service.stop()


@app.get("/")
async def index() -> HTMLResponse:
    static_dir = service.static_dir()
    html = (static_dir / "index.html").read_text(encoding="utf-8")
    css_version = int((static_dir / "styles.css").stat().st_mtime)
    js_version = int((static_dir / "app.js").stat().st_mtime)
    build_version = f"v{__version__}-{js_version}"
    html = html.replace('{{BUILD_VERSION}}', build_version)
    html = html.replace('/assets/styles.css', f'/assets/styles.css?v={css_version}')
    html = html.replace('/assets/app.js', f'/assets/app.js?v={js_version}')
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/api/health")
async def health() -> dict:
    status = await service.health_status()
    status["version"] = __version__
    return status


@app.get("/api/screens")
async def get_screens() -> dict:
    """获取所有可用屏幕列表"""
    screens = service.get_screens()
    return {"items": screens, "targetScreen": service.get_target_screen()}


class TargetScreenPayload(BaseModel):
    target_screen: int = Field(default=-1, ge=-1)


@app.put("/api/screens/target")
async def set_target_screen(payload: TargetScreenPayload) -> dict:
    """设置目标屏幕"""
    screens = service.get_screens()
    if payload.target_screen >= len(screens):
        raise HTTPException(status_code=400, detail=f"屏幕索引超出范围，当前共 {len(screens)} 个屏幕")
    service.set_target_screen(payload.target_screen)
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
    return {"items": service.list_terminals(), "layout": service.monitor_layout()}


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
            )
        )
        return {"item": terminal, "layout": service.monitor_layout()}
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


@app.post("/api/terminals/{terminal_id}/focus")
async def focus_terminal(terminal_id: str) -> dict:
    try:
        return {"item": await service.focus_terminal(terminal_id), "layout": service.monitor_layout()}
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
