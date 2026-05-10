from __future__ import annotations

import pytest

from multi_iterm2_manager.backend.iterm2_backend import ITerm2Backend


class FakeSession:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.read_keys: list[str] = []

    async def async_get_variable(self, key: str):
        self.read_keys.append(key)
        return None


class FakeTab:
    tab_id = "tab-1"

    def __init__(self, sessions: list[FakeSession]) -> None:
        self.sessions = sessions


class FakeWindow:
    window_id = "window-1"

    def __init__(self, sessions: list[FakeSession]) -> None:
        self.tabs = [FakeTab(sessions)]


class FakeApp:
    def __init__(self, sessions: list[FakeSession]) -> None:
        self.terminal_windows = [FakeWindow(sessions)]


@pytest.mark.anyio
async def test_scan_unmanaged_sessions_skips_known_sessions_even_without_managed_vars() -> None:
    backend = ITerm2Backend()
    known = FakeSession("session-known")
    unmanaged = FakeSession("session-unmanaged")
    app = FakeApp([known, unmanaged])

    async def fake_get_runtime(*, force_refresh: bool = False):
        return None, app

    backend._get_runtime = fake_get_runtime  # type: ignore[method-assign]

    result = await backend.scan_unmanaged_sessions(known_session_ids={"session-known"})

    assert [item["session_id"] for item in result] == ["session-unmanaged"]
    assert known.read_keys == []
