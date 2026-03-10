from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any

from multi_iterm2_manager.analyzer import analyze_screen_text
from multi_iterm2_manager.backend.mock import MockTerminalBackend
from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.display import suggest_monitor_grid
from multi_iterm2_manager.models import CreateTerminalParams, GridLayoutParams, TerminalFrame, TerminalRecord, TerminalStatus, new_terminal_id


class DashboardService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.records: dict[str, TerminalRecord] = {}
        self.monitor_tasks: dict[str, asyncio.Task[None]] = {}
        self._subscribers: set[asyncio.Queue[dict]] = set()
        self._lock = asyncio.Lock()
        self.backend: Any = self._build_backend()
        self._watchdog_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        await self.backend.start()
        try:
            await asyncio.wait_for(self.backend.cleanup_managed_terminals(), timeout=6)
        except Exception:
            pass
        try:
            await asyncio.wait_for(self.backend.maybe_quit_app(), timeout=3)
        except Exception:
            pass
        self._watchdog_task = asyncio.create_task(self._watchdog_loop())

    async def stop(self) -> None:
        if self._watchdog_task is not None:
            self._watchdog_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._watchdog_task
            self._watchdog_task = None
        try:
            await self.close_all_terminals()
        except Exception:
            pass
        try:
            await self.backend.cleanup_managed_terminals()
            await self.backend.maybe_quit_app()
        except Exception:
            pass
        for task in self.monitor_tasks.values():
            task.cancel()
        for task in self.monitor_tasks.values():
            with suppress(asyncio.CancelledError):
                await task
        self.monitor_tasks.clear()
        await self.backend.stop()

    def static_dir(self) -> Path:
        return Path(__file__).with_name("static")

    async def subscribe(self) -> asyncio.Queue[dict]:
        queue: asyncio.Queue[dict] = asyncio.Queue()
        self._subscribers.add(queue)
        await queue.put(self.snapshot_event())
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict]) -> None:
        self._subscribers.discard(queue)

    def list_terminals(self) -> list[dict]:
        return [record.to_dict() for record in self.records.values()]

    def list_active_terminals(self) -> list[dict]:
        return [record.to_dict() for record in self.records.values() if record.status != TerminalStatus.closed]

    def monitor_layout(self) -> dict:
        count = len([record for record in self.records.values() if record.status != TerminalStatus.closed])
        columns, rows = suggest_monitor_grid(count)
        return {"count": count, "columns": columns, "rows": rows}

    def _next_default_name(self) -> str:
        existing = {record.name.strip().lower() for record in self.records.values() if record.name}
        index = 1
        while True:
            candidate = f"终端 {index}"
            if candidate.lower() not in existing:
                return candidate
            index += 1

    async def health_status(self) -> dict:
        return {
            "ok": True,
            "backend": self.settings.backend,
            "terminals": len(self.records),
            "itermReady": await self.backend.ping(),
        }

    async def create_terminal(self, params: CreateTerminalParams) -> dict:
        final_name = (params.name or '').strip() or self._next_default_name()
        handle = await self.backend.create_terminal(CreateTerminalParams(name=final_name, command=params.command, profile=params.profile, frame=params.frame))
        frame = await self.backend.get_frame(handle)
        record = TerminalRecord(
            id=new_terminal_id(),
            name=final_name,
            handle=handle,
            command=params.command,
            profile=params.profile,
            frame=frame,
        )
        async with self._lock:
            self.records[record.id] = record
        await self.refresh_terminal(record.id)
        self._start_monitor(record.id)
        await self.enter_monitor_mode()
        await self._broadcast(self.record_event(record.id))
        return record.to_dict()

    async def create_demo_terminals(self, count: int = 4) -> list[dict]:
        count = max(1, count)
        created: list[dict] = []
        for index in range(count):
            created.append(
                await self.create_terminal(
                    CreateTerminalParams(
                        name=f"终端 {index + 1}",
                        command="/bin/zsh -l",
                    )
                )
            )
        return created

    async def focus_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        try:
            await self.backend.focus(record.handle)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def rename_terminal(self, terminal_id: str, name: str) -> dict:
        record = self._get_record(terminal_id)
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("名称不能为空")
        if len(clean_name) > 60:
            raise ValueError("名称不能超过 60 个字符")

        for other in self.records.values():
            if other.id == record.id:
                continue
            if other.status == TerminalStatus.closed:
                continue
            if other.name.strip().lower() == clean_name.lower():
                raise ValueError(f"名称已存在：{clean_name}")

        await self.backend.rename(record.handle, clean_name)
        record.name = clean_name
        record.updated_at = self._now()
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def enter_monitor_mode(self) -> dict:
        await self.backend.hide_app()
        payload = {"type": "workspace-mode", "mode": "monitor", "layout": self.monitor_layout()}
        await self._broadcast(payload)
        return payload

    async def close_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        if record.status != TerminalStatus.closed:
            try:
                await self.backend.close(record.handle)
            except Exception:
                pass
        return await self._mark_terminal_closed(record)

    async def detach_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        if record.status == TerminalStatus.closed:
            raise ValueError("终端已关闭，无法解绑")
        await self.backend.detach(record.handle)
        task = self.monitor_tasks.pop(record.id, None)
        if task is not None:
            task.cancel()
        async with self._lock:
            del self.records[record.id]
        await self._broadcast(self.snapshot_event())
        return {"detached": True, "terminalId": terminal_id}

    async def scan_sessions(self) -> list[dict]:
        return await self.backend.scan_unmanaged_sessions()

    async def adopt_terminal(self, session_id: str, name: str | None = None) -> dict:
        final_name = (name or '').strip() or self._next_default_name()
        handle = await self.backend.adopt(session_id, final_name)
        frame = await self.backend.get_frame(handle)
        record = TerminalRecord(
            id=new_terminal_id(),
            name=final_name,
            handle=handle,
            frame=frame,
        )
        async with self._lock:
            self.records[record.id] = record
        await self.refresh_terminal(record.id)
        self._start_monitor(record.id)
        await self.enter_monitor_mode()
        await self._broadcast(self.record_event(record.id))
        return record.to_dict()

    async def close_all_terminals(self) -> list[dict]:
        target_ids = [record.id for record in self.records.values() if record.status != TerminalStatus.closed]
        result: list[dict] = []
        for terminal_id in target_ids:
            result.append(await self.close_terminal(terminal_id))
        return result

    async def refresh_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        try:
            text, screen_html = await self.backend.get_screen_render(record.handle)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        self._apply_screen_text(record, text, screen_html, is_live=False)
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def send_text(self, terminal_id: str, text: str) -> dict:
        record = self._get_record(terminal_id)
        payload = text if text.endswith("\n") or text.endswith("\r") else f"{text}\n"
        try:
            await self.backend.send_text(record.handle, payload)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        await asyncio.sleep(0.1)
        return await self.refresh_terminal(terminal_id)

    async def set_frame(self, terminal_id: str, frame: TerminalFrame) -> dict:
        record = self._get_record(terminal_id)
        try:
            await self.backend.set_frame(record.handle, frame)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        record.frame = frame
        record.updated_at = self._now()
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def apply_grid_layout(self, params: GridLayoutParams) -> dict:
        columns = max(1, params.columns)
        rows = max(1, params.rows)
        payload = {
            "type": "monitor-layout",
            "layout": {
                "count": len([record for record in self.records.values() if record.status != TerminalStatus.closed]),
                "columns": columns,
                "rows": rows,
            },
        }
        await self._broadcast(payload)
        return payload

    def snapshot_event(self) -> dict:
        return {
            "type": "snapshot",
            "terminals": self.list_terminals(),
            "layout": self.monitor_layout(),
        }

    def record_event(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        return {
            "type": "terminal-updated",
            "terminal": record.to_dict(),
            "layout": self.monitor_layout(),
        }

    async def _broadcast(self, payload: dict) -> None:
        dead: list[asyncio.Queue[dict]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            self._subscribers.discard(queue)

    def _start_monitor(self, terminal_id: str) -> None:
        task = asyncio.create_task(self._monitor_terminal(terminal_id))
        self.monitor_tasks[terminal_id] = task

    async def _monitor_terminal(self, terminal_id: str) -> None:
        record = self._get_record(terminal_id)
        try:
            async for text, screen_html in self.backend.stream_screen(record.handle):
                self._apply_screen_text(record, text, screen_html, is_live=True)
                await self._broadcast(self.record_event(terminal_id))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
                return
            record.last_error = str(exc)
            if record.status != TerminalStatus.closed:
                record.status = TerminalStatus.error
                record.updated_at = self._now()
                record.is_live = False
                await self._broadcast(self.record_event(terminal_id))

    async def _mark_terminal_closed(self, record: TerminalRecord, reason: str | None = None) -> dict:
        record.status = TerminalStatus.closed
        record.updated_at = self._now()
        record.is_live = False
        record.last_error = None
        if reason:
            record.summary = reason
        task = self.monitor_tasks.pop(record.id, None)
        if task is not None:
            task.cancel()
        await self._broadcast(self.record_event(record.id))
        await self.enter_monitor_mode()
        return record.to_dict()

    def _is_missing_terminal_error(self, exc: Exception) -> bool:
        message = str(exc).lower()
        patterns = [
            "找不到 window",
            "找不到 session",
            "window not found",
            "session not found",
            "no such window",
            "no such session",
            "session ended",
            "无法连接",
        ]
        return any(pattern in message for pattern in patterns)

    def _apply_screen_text(self, record: TerminalRecord, text: str, screen_html: str, is_live: bool) -> None:
        status, markers, summary = analyze_screen_text(text)
        record.screen_text = text
        record.screen_html = screen_html
        record.status = status
        record.markers = markers
        record.summary = summary
        record.updated_at = self._now()
        record.is_live = is_live
        if record.status != TerminalStatus.error:
            record.last_error = None

    def _get_record(self, terminal_id: str) -> TerminalRecord:
        if terminal_id not in self.records:
            raise KeyError(f"未知终端: {terminal_id}")
        return self.records[terminal_id]

    def _build_backend(self):
        if self.settings.backend == "mock":
            return MockTerminalBackend()
        if self.settings.backend == "iterm2":
            from multi_iterm2_manager.backend.iterm2_backend import ITerm2Backend

            return ITerm2Backend()
        try:
            from multi_iterm2_manager.backend.iterm2_backend import ITerm2Backend

            return ITerm2Backend()
        except Exception:
            return MockTerminalBackend()

    async def _watchdog_loop(self) -> None:
        while True:
            await asyncio.sleep(5)
            alive = not hasattr(self.backend, 'is_alive') or self.backend.is_alive()
            print(f"[watchdog] iTerm2 alive={alive}, terminals={len(self.records)}", flush=True)
            if alive:
                continue
            active = [r for r in self.records.values() if r.status != TerminalStatus.closed]
            if not active:
                continue
            print(f"[watchdog] iTerm2 已退出，关闭 {len(active)} 个终端", flush=True)
            for record in active:
                record.status = TerminalStatus.closed
                record.updated_at = self._now()
                record.is_live = False
                record.summary = "iTerm2 已退出"
                task = self.monitor_tasks.pop(record.id, None)
                if task is not None:
                    task.cancel()
            await self._broadcast(self.snapshot_event())

    def _now(self) -> str:
        return datetime.now().isoformat(timespec="seconds")
