from __future__ import annotations

import asyncio
import hashlib
from contextlib import suppress

import pytest

from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.models import (
    TerminalFrame,
    TerminalHandle,
    TerminalProgramInfo,
    TerminalRecord,
    TerminalRuntimeInfo,
    TerminalStatus,
)
from multi_iterm2_manager.service import DashboardService
from multi_iterm2_manager.state_store import TerminalStateStore


def test_terminal_state_store_round_trips_active_record(tmp_path) -> None:
    store = TerminalStateStore(tmp_path / "terminal-state.json")
    record = TerminalRecord(
        id="task-cache",
        name="缓存终端",
        handle=TerminalHandle(window_id="window-1", session_id="session-1", tab_id="tab-1"),
        status=TerminalStatus.running,
        summary="working",
        screen_text="python job.py",
        screen_html="<pre>python job.py</pre>",
        frame=TerminalFrame(x=1, y=2, width=800, height=600),
        cwd="/tmp/project",
        hidden=True,
        muted=True,
        tags=["ai"],
        is_primary=True,
        program=TerminalProgramInfo(key="codex", label="Codex", source="runtime", pid=123, command_line="codex"),
        ai_summary="cached summary",
        ai_summary_status="done",
        ai_summary_first=False,
        last_interaction_at=42.0,
        interaction_content_hash="abc",
    )

    store.save([record])
    restored = store.load()

    assert len(restored) == 1
    loaded = restored[0]
    assert loaded.id == "task-cache"
    assert loaded.handle.session_id == "session-1"
    assert loaded.frame == TerminalFrame(x=1, y=2, width=800, height=600)
    assert loaded.status == TerminalStatus.running
    assert loaded.is_live is False
    assert loaded.hidden is True
    assert loaded.muted is True
    assert loaded.tags == ["ai"]
    assert loaded.program.key == "codex"
    assert loaded.ai_summary == "cached summary"
    assert loaded.ai_summary_first is False


@pytest.mark.anyio
async def test_fast_restore_uses_cached_records_and_prunes_missing_sessions(tmp_path) -> None:
    store = TerminalStateStore(tmp_path / "terminal-state.json")
    live_record = TerminalRecord(
        id="task-live",
        name="Live",
        handle=TerminalHandle(window_id="window-live", session_id="session-live"),
        status=TerminalStatus.running,
        screen_text="cached",
    )
    missing_record = TerminalRecord(
        id="task-missing",
        name="Missing",
        handle=TerminalHandle(window_id="window-missing", session_id="session-missing"),
        status=TerminalStatus.running,
    )
    store.save([live_record, missing_record])

    class RestoreBackend:
        async def list_session_ids(self) -> set[str]:
            return {"session-live"}

        async def stream_screen(self, handle: TerminalHandle):
            await asyncio.sleep(60)
            if False:
                yield "", ""

    service = DashboardService(Settings(backend="mock"))
    service.backend = RestoreBackend()
    service._terminal_state_store = store

    restored_count = await service._restore_cached_records_fast()

    assert restored_count == 1
    assert list(service.records) == ["task-live"]
    assert service.records["task-live"].is_live is False
    assert service.used_fast_start_restore is True
    assert "task-live" in service.monitor_tasks

    for task in service.monitor_tasks.values():
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@pytest.mark.anyio
async def test_cached_monitor_first_frame_broadcasts_live_state() -> None:
    class StreamingBackend:
        async def stream_screen(self, handle: TerminalHandle):
            yield "cached", "<pre>cached</pre>"
            await asyncio.sleep(60)

        async def get_cwd(self, handle: TerminalHandle) -> str | None:
            return None

        async def get_runtime_info(self, handle: TerminalHandle) -> TerminalRuntimeInfo:
            return TerminalRuntimeInfo()

    service = DashboardService(Settings(backend="mock"))
    service.backend = StreamingBackend()
    record = TerminalRecord(
        id="task-live-state",
        name="Live State",
        handle=TerminalHandle(window_id="window-live", session_id="session-live"),
        status=TerminalStatus.running,
        screen_text="cached",
        screen_html="<pre>cached</pre>",
        content_hash=hashlib.md5("cached".encode()).hexdigest(),
        is_live=False,
    )
    service.records[record.id] = record
    events: list[dict] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload)

    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    service._start_monitor(record.id)
    try:
        for _ in range(20):
            if any(event.get("terminal", {}).get("isLive") is True for event in events):
                break
            await asyncio.sleep(0.01)
        assert any(event.get("terminal", {}).get("isLive") is True for event in events)
    finally:
        for task in service.monitor_tasks.values():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
