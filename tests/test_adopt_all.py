from __future__ import annotations

import pytest

from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.models import TerminalHandle, TerminalRecord, TerminalStatus
from multi_iterm2_manager.service import DashboardService, _normalize_terminal_name


@pytest.mark.anyio
async def test_adopt_all_terminals_returns_snapshot_and_failures() -> None:
    service = DashboardService(Settings(backend="mock"))

    async def fake_scan_sessions() -> list[dict]:
        return [
            {"session_id": "session-ok", "name": "可接管"},
            {"session_id": "session-fail", "name": "失败终端"},
        ]

    async def fake_adopt_terminal(session_id: str, name: str | None = None) -> dict:
        if session_id == "session-fail":
            raise RuntimeError("接管失败")
        record = TerminalRecord(
            id="task-adopted",
            name="可接管",
            handle=TerminalHandle(window_id="window-ok", session_id=session_id),
        )
        service.records[record.id] = record
        return record.to_dict()

    events: list[dict] = []

    async def fake_broadcast(payload: dict) -> None:
        events.append(payload)

    service.scan_sessions = fake_scan_sessions  # type: ignore[method-assign]
    service.adopt_terminal = fake_adopt_terminal  # type: ignore[method-assign]
    service._broadcast = fake_broadcast  # type: ignore[method-assign]

    result = await service.adopt_all_terminals()

    assert result["scanned"] == 2
    assert result["adopted"] == 1
    assert result["errors"] == [
        {"sessionId": "session-fail", "name": "失败终端", "error": "接管失败"}
    ]
    assert [item["id"] for item in result["items"]] == ["task-adopted"]
    assert result["layout"]["count"] == 1
    assert events[-1]["type"] == "snapshot"


def test_list_terminals_prunes_duplicate_active_sessions() -> None:
    service = DashboardService(Settings(backend="mock"))
    first = TerminalRecord(
        id="task-first",
        name="终端 1",
        handle=TerminalHandle(window_id="window-1", session_id="session-1"),
        status=TerminalStatus.idle,
        tags=["ai"],
    )
    duplicate = TerminalRecord(
        id="task-duplicate",
        name="终端 1 duplicate",
        handle=TerminalHandle(window_id="window-1", session_id="session-1"),
        status=TerminalStatus.running,
        screen_text="working",
        tags=["urgent"],
    )
    service.records[first.id] = first
    service.records[duplicate.id] = duplicate

    items = service.list_terminals()

    assert [item["id"] for item in items] == ["task-first"]
    assert list(service.records) == ["task-first"]
    assert service.records["task-first"].status == TerminalStatus.running
    assert service.records["task-first"].screen_text == "working"
    assert service.records["task-first"].tags == ["ai", "urgent"]
    assert service.monitor_layout()["count"] == 1


@pytest.mark.anyio
async def test_adopt_terminal_returns_existing_record_for_tracked_session() -> None:
    service = DashboardService(Settings(backend="mock"))
    existing = TerminalRecord(
        id="task-existing",
        name="已接管",
        handle=TerminalHandle(window_id="window-1", session_id="session-1"),
    )
    service.records[existing.id] = existing

    async def fail_adopt(session_id: str, name: str | None = None) -> TerminalHandle:
        raise AssertionError("already tracked sessions should not be adopted again")

    service.backend.adopt = fail_adopt  # type: ignore[method-assign]

    result = await service.adopt_terminal("session-1")

    assert result["id"] == "task-existing"
    assert list(service.records) == ["task-existing"]


def test_normalize_terminal_name_strips_codex_auto_title_noise() -> None:
    assert _normalize_terminal_name('⠇ EasyFit-Workspace (codex")') == "EasyFit-Workspace"
    assert _normalize_terminal_name("手动命名 (codex)") == "手动命名 (codex)"
