from __future__ import annotations

import asyncio

import multi_iterm2_manager.display as display
from multi_iterm2_manager.config import Settings, UiSettings, get_default_layout_for_screen
from multi_iterm2_manager.models import TerminalFrame, TerminalHandle, TerminalRecord
from multi_iterm2_manager.service import DashboardService


class _FakeOrigin:
    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y


class _FakeSize:
    def __init__(self, width: float, height: float) -> None:
        self.width = width
        self.height = height


class _FakeFrame:
    def __init__(self, x: float, y: float, width: float, height: float) -> None:
        self.origin = _FakeOrigin(x, y)
        self.size = _FakeSize(width, height)


class _FakeScreen:
    def __init__(
        self,
        display_id: int,
        name: str,
        frame: tuple[float, float, float, float],
        visible: tuple[float, float, float, float],
    ) -> None:
        self._display_id = display_id
        self._name = name
        self._frame = _FakeFrame(*frame)
        self._visible = _FakeFrame(*visible)

    def deviceDescription(self) -> dict[str, int]:
        return {"NSScreenNumber": self._display_id}

    def frame(self) -> _FakeFrame:
        return self._frame

    def visibleFrame(self) -> _FakeFrame:
        return self._visible

    def localizedName(self) -> str:
        return self._name


def _mock_screens() -> list[dict]:
    return [
        {
            "index": 0,
            "displayId": 1001,
            "name": "Built-in Retina Display",
            "width": 1710,
            "height": 1112,
            "x": 0,
            "y": 0,
            "visibleX": 0,
            "visibleY": 0,
            "visibleWidth": 1710,
            "visibleHeight": 1073,
            "isMain": True,
            "isBuiltin": True,
        },
        {
            "index": 1,
            "displayId": 2002,
            "name": "外接屏幕 1",
            "width": 2560,
            "height": 1440,
            "x": 1710,
            "y": 0,
            "visibleX": 1710,
            "visibleY": 0,
            "visibleWidth": 2560,
            "visibleHeight": 1440,
            "isMain": False,
            "isBuiltin": False,
        },
    ]


def test_get_default_layout_for_screen_matches_saved_alias_by_coordinates(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(display, "get_all_screens", lambda: _mock_screens())

    config_path = tmp_path / "ui-settings.yaml"
    config_path.write_text(
        """
screen_layouts:
  Mi Monitor:
    layouts:
      user_company:
        configName: 公司
        createdAt: '2026-04-15T09:37:47'
        terminals:
          task-1:
            terminalId: task-1
            x: 1713
            y: -177
            width: 2547
            height: 1091
        isPreset: false
        isDefault: true
        layoutId: user_company
""".strip(),
        encoding="utf-8",
    )

    layout = get_default_layout_for_screen("外接屏幕 1", str(config_path))

    assert layout is not None
    assert layout.config_name == "公司"
    assert layout.screen_name == "Mi Monitor"


def test_get_all_screens_converts_visible_frame_to_global_coordinates(monkeypatch) -> None:
    class _FakeCG:
        def CGGetActiveDisplayList(self, max_displays, display_ids, count_ptr):
            display_ids[0] = 1001
            display_ids[1] = 2002
            count_ptr._obj.value = 2
            return 0

        def CGDisplayBounds(self, display_id):
            if int(display_id) == 1001:
                return type("CGRect", (), {
                    "origin": type("Origin", (), {"x": 0, "y": 0})(),
                    "size": type("Size", (), {"width": 1710, "height": 1112})(),
                })()
            return type("CGRect", (), {
                "origin": type("Origin", (), {"x": 1710, "y": 0})(),
                "size": type("Size", (), {"width": 2560, "height": 1440})(),
            })()

        def CGDisplayIsMain(self, display_id):
            return int(display_id) == 1001

        def CGDisplayIsBuiltin(self, display_id):
            return int(display_id) == 1001

    fake_screens = [
        _FakeScreen(1001, "Color LCD", (-1470, 445, 1710, 1112), (-1470, 484, 1470, 924)),
        _FakeScreen(2002, "Mi Monitor", (0, 0, 2560, 1440), (0, 0, 2560, 1410)),
    ]
    fake_appkit = type("FakeAppKit", (), {"NSScreen": type("FakeNSScreen", (), {"screens": staticmethod(lambda: fake_screens)})})

    monkeypatch.setattr(display, "_cg_lib", _FakeCG())
    monkeypatch.setattr(display, "AppKit", fake_appkit)
    monkeypatch.setattr(display, "_get_display_name_via_coredisplay", lambda display_id: None)

    screens = display.get_all_screens()

    assert screens[0]["visibleX"] == 0
    assert screens[0]["visibleY"] == 39
    assert screens[1]["visibleX"] == 1710
    assert screens[1]["visibleY"] == 0


def test_get_target_screen_prefers_saved_display_id(monkeypatch) -> None:
    settings = Settings(
        backend="mock",
        ui_settings=UiSettings(
            target_screen=0,
            target_screen_id=2002,
            target_screen_name="Mi Monitor",
        ),
    )
    service = DashboardService(settings)
    monkeypatch.setattr(service, "get_screens", lambda: _mock_screens())

    target_index, target_name, target_screen = service.get_target_screen_info()

    assert target_index == 1
    assert target_name == "外接屏幕 1"
    assert target_screen is not None
    assert target_screen["displayId"] == 2002
    assert service.get_target_screen() == 1


def test_get_default_frame_matches_saved_alias_by_coordinates(monkeypatch) -> None:
    settings = Settings(
        backend="mock",
        ui_settings=UiSettings(
            default_frames_by_screen={
                "Mi Monitor": {
                    "x": 1710.0,
                    "y": -162.0,
                    "width": 2560.0,
                    "height": 1074.0,
                }
            }
        ),
    )
    service = DashboardService(settings)
    monkeypatch.setattr(service, "get_screens", lambda: _mock_screens())

    frame = service.get_default_frame("外接屏幕 1")

    assert frame is not None
    assert frame["x"] == 1710.0
    assert frame["width"] == 2560.0


def test_align_frame_to_siblings_keeps_explicit_target_screen(monkeypatch) -> None:
    settings = Settings(
        backend="mock",
        ui_settings=UiSettings(target_screen=1),
    )
    service = DashboardService(settings)
    monkeypatch.setattr(service, "get_screens", lambda: _mock_screens())

    sibling_handle = TerminalHandle(window_id="mock-window-1", session_id="mock-session-1", tab_id="mock-tab-1")
    new_handle = TerminalHandle(window_id="mock-window-2", session_id="mock-session-2", tab_id="mock-tab-2")
    sibling_frame = TerminalFrame(x=24.0, y=24.0, width=800.0, height=500.0)
    external_frame = TerminalFrame(x=1728.0, y=24.0, width=800.0, height=500.0)

    service.backend._items[sibling_handle.session_id] = {
        "name": "sibling",
        "command": "",
        "text": "",
        "frame": sibling_frame,
    }
    service.backend._items[new_handle.session_id] = {
        "name": "new",
        "command": "",
        "text": "",
        "frame": external_frame,
    }

    sibling_record = TerminalRecord(id="task-1", name="sibling", handle=sibling_handle, frame=sibling_frame)
    new_record = TerminalRecord(id="task-2", name="new", handle=new_handle, frame=external_frame)
    service.records = {
        sibling_record.id: sibling_record,
        new_record.id: new_record,
    }

    asyncio.run(service._align_frame_to_siblings(new_record))

    assert new_record.frame is not None
    assert new_record.frame.x == external_frame.x
    assert new_record.frame.y == external_frame.y


def test_focus_terminal_realigns_source_and_siblings_to_default_frame(monkeypatch) -> None:
    settings = Settings(
        backend="mock",
        ui_settings=UiSettings(
            target_screen=1,
            default_frames_by_screen={
                "外接屏幕 1": {
                    "x": 1760.0,
                    "y": 32.0,
                    "width": 900.0,
                    "height": 560.0,
                }
            },
        ),
    )
    service = DashboardService(settings)
    monkeypatch.setattr(service, "get_screens", lambda: _mock_screens())
    monkeypatch.setattr(
        display,
        "get_screen_bounds",
        lambda screen_index: display.DisplayBounds(x=1710.0, y=0.0, width=2560.0, height=1440.0)
        if screen_index == 1
        else None,
    )

    selected_handle = TerminalHandle(window_id="mock-window-1", session_id="mock-session-1", tab_id="mock-tab-1")
    sibling_handle = TerminalHandle(window_id="mock-window-2", session_id="mock-session-2", tab_id="mock-tab-2")
    selected_frame = TerminalFrame(x=1880.0, y=84.0, width=1100.0, height=700.0)
    sibling_frame = TerminalFrame(x=24.0, y=24.0, width=780.0, height=520.0)

    service.backend._items[selected_handle.session_id] = {
        "name": "selected",
        "command": "",
        "text": "",
        "frame": selected_frame,
    }
    service.backend._items[sibling_handle.session_id] = {
        "name": "sibling",
        "command": "",
        "text": "",
        "frame": sibling_frame,
    }

    selected_record = TerminalRecord(id="task-1", name="selected", handle=selected_handle, frame=selected_frame)
    sibling_record = TerminalRecord(id="task-2", name="sibling", handle=sibling_handle, frame=sibling_frame)
    service.records = {
        selected_record.id: selected_record,
        sibling_record.id: sibling_record,
    }

    asyncio.run(service.focus_terminal(selected_record.id))

    expected = TerminalFrame(x=1760.0, y=32.0, width=900.0, height=560.0)
    assert selected_record.frame == expected
    assert sibling_record.frame == expected


def test_split_terminal_creates_new_window_and_reuses_cwd(monkeypatch) -> None:
    settings = Settings(backend="mock")
    service = DashboardService(settings)

    async def _noop_async(*args, **kwargs):
        return {}

    async def _noop_broadcast(_payload):
        return None

    monkeypatch.setattr(service, "enter_monitor_mode", _noop_async)
    monkeypatch.setattr(service, "_broadcast", _noop_broadcast)
    monkeypatch.setattr(service, "_start_monitor", lambda _terminal_id: None)

    source_handle = TerminalHandle(window_id="mock-window-1", session_id="mock-session-1", tab_id="mock-tab-1")
    source_frame = TerminalFrame(x=24.0, y=24.0, width=800.0, height=500.0)
    source_cwd = "/Users/czm/githubProject/muti-iterm2-manager"

    service.backend._items[source_handle.session_id] = {
        "name": "source",
        "command": "",
        "text": "",
        "frame": source_frame,
        "cwd": source_cwd,
    }

    source_record = TerminalRecord(
        id="task-source",
        name="source",
        handle=source_handle,
        frame=source_frame,
        cwd=source_cwd,
    )
    service.records = {source_record.id: source_record}

    created = asyncio.run(service.split_terminal(source_record.id, "vertical"))

    assert created["id"] != source_record.id
    assert created["windowId"] != source_handle.window_id
    assert created["sessionId"] != source_handle.session_id
    assert created["cwd"] == source_cwd
    assert created["name"] == "终端 1"
    assert service.records[created["id"]].cwd == source_cwd
