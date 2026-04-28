from __future__ import annotations

import pytest

from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.models import TerminalHandle, TerminalRecord
from multi_iterm2_manager.service import DashboardService


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
