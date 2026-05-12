from __future__ import annotations

import pytest

from multi_iterm2_manager.config import Settings
from multi_iterm2_manager.models import TerminalHandle, TerminalRecord, TerminalStatus
from multi_iterm2_manager.service import DashboardService


@pytest.mark.anyio
async def test_rename_terminal_rejects_duplicate_active_name_case_insensitive() -> None:
    service = DashboardService(Settings(backend="mock"))
    service.records["task-1"] = TerminalRecord(
        id="task-1",
        name="原终端",
        handle=TerminalHandle(window_id="window-1", session_id="session-1"),
    )
    service.records["task-2"] = TerminalRecord(
        id="task-2",
        name="重复名称",
        handle=TerminalHandle(window_id="window-2", session_id="session-2"),
        status=TerminalStatus.running,
    )

    with pytest.raises(ValueError, match="名称已存在：重复名称"):
        await service.rename_terminal("task-1", "  重复名称  ")

    assert service.records["task-1"].name == "原终端"


@pytest.mark.anyio
async def test_rename_terminal_allows_reusing_closed_terminal_name() -> None:
    service = DashboardService(Settings(backend="mock"))
    service.records["task-1"] = TerminalRecord(
        id="task-1",
        name="原终端",
        handle=TerminalHandle(window_id="window-1", session_id="session-1"),
    )
    service.records["task-2"] = TerminalRecord(
        id="task-2",
        name="旧名称",
        handle=TerminalHandle(window_id="window-2", session_id="session-2"),
        status=TerminalStatus.closed,
    )

    result = await service.rename_terminal("task-1", "旧名称")

    assert result["name"] == "旧名称"
    assert service.records["task-1"].name == "旧名称"
