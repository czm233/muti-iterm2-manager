from __future__ import annotations

import asyncio

import pytest

from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.models import TerminalHandle, TerminalRecord, TerminalStatus
from multi_iterm2_manager.service import DashboardService


class MissingSessionStreamBackend:
    async def stream_screen(self, handle: TerminalHandle):
        if False:
            yield "", ""
        raise RuntimeError(f"找不到 session: {handle.session_id}")

    async def hide_app(self) -> None:
        return None


class SessionScanBackend:
    def __init__(self, session_ids: set[str]) -> None:
        self.session_ids = set(session_ids)

    async def list_session_ids(self) -> set[str]:
        return set(self.session_ids)

    async def hide_app(self) -> None:
        return None


@pytest.mark.anyio
async def test_monitor_task_auto_closes_missing_session_and_broadcasts() -> None:
    service = DashboardService(Settings(backend="mock"))
    service.backend = MissingSessionStreamBackend()
    record = TerminalRecord(
        id="terminal-closed-by-user",
        name="终端 10",
        handle=TerminalHandle(window_id="window-10", session_id="session-10"),
        status=TerminalStatus.running,
    )
    service.records[record.id] = record

    events: list[dict] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload)

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    service._start_monitor(record.id)
    for _ in range(20):
        closed_event_seen = any(
            event.get("type") == "terminal-updated"
            and event.get("terminal", {}).get("id") == record.id
            and event.get("terminal", {}).get("status") == "closed"
            for event in events
        )
        if record.status == TerminalStatus.closed and closed_event_seen:
            break
        await asyncio.sleep(0.01)

    assert record.status == TerminalStatus.closed
    assert record.id not in service.monitor_tasks
    assert any(
        event.get("type") == "terminal-updated"
        and event.get("terminal", {}).get("id") == record.id
        and event.get("terminal", {}).get("status") == "closed"
        for event in events
    )
    assert any(event.get("type") == "workspace-mode" for event in events)


@pytest.mark.anyio
async def test_watchdog_session_scan_closes_repeatedly_missing_session() -> None:
    service = DashboardService(Settings(backend="mock"))
    service.backend = SessionScanBackend(session_ids=set())
    record = TerminalRecord(
        id="terminal-missing-from-scan",
        name="终端 11",
        handle=TerminalHandle(window_id="window-11", session_id="session-11"),
        status=TerminalStatus.running,
    )
    service.records[record.id] = record

    events: list[dict] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload)

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    await service._close_records_missing_from_session_scan()

    assert record.status == TerminalStatus.running
    assert service._missing_session_scan_counts[record.id] == 1

    await service._close_records_missing_from_session_scan()

    assert record.status == TerminalStatus.closed
    assert record.id not in service._missing_session_scan_counts
    assert any(
        event.get("type") == "terminal-updated"
        and event.get("terminal", {}).get("id") == record.id
        and event.get("terminal", {}).get("status") == "closed"
        for event in events
    )
    assert any(event.get("type") == "workspace-mode" for event in events)
