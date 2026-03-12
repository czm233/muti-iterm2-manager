from __future__ import annotations

from dataclasses import dataclass
from math import ceil, sqrt

from multi_iterm2_manager.models import GridLayoutParams, TerminalFrame

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None


@dataclass
class DisplayBounds:
    x: float
    y: float
    width: float
    height: float


def get_primary_display_bounds() -> DisplayBounds:
    if AppKit is None:
        return DisplayBounds(x=0.0, y=0.0, width=1728.0, height=1117.0)

    screen = AppKit.NSScreen.mainScreen()
    if screen is None:
        return DisplayBounds(x=0.0, y=0.0, width=1728.0, height=1117.0)

    frame = screen.visibleFrame()
    return DisplayBounds(
        x=float(frame.origin.x),
        y=float(frame.origin.y),
        width=float(frame.size.width),
        height=float(frame.size.height),
    )


def get_all_screens() -> list[dict]:
    """获取所有可用屏幕信息，返回包含 index/name/width/height/x/y 的列表"""
    if AppKit is None:
        return [{"index": 0, "name": "主屏幕", "width": 1728, "height": 1117, "x": 0, "y": 0}]

    screens = AppKit.NSScreen.screens()
    if not screens:
        return [{"index": 0, "name": "主屏幕", "width": 1728, "height": 1117, "x": 0, "y": 0}]

    result = []
    for i, screen in enumerate(screens):
        frame = screen.frame()
        visible = screen.visibleFrame()
        name = "主屏幕" if i == 0 else f"屏幕 {i + 1}"
        # 尝试获取屏幕的 localizedName（macOS 10.15+）
        try:
            localized = screen.localizedName()
            if localized:
                name = localized
        except Exception:
            pass
        result.append({
            "index": i,
            "name": name,
            "width": int(frame.size.width),
            "height": int(frame.size.height),
            "x": int(frame.origin.x),
            "y": int(frame.origin.y),
            # 可用区域（排除 Dock 和菜单栏）
            "visibleX": int(visible.origin.x),
            "visibleY": int(visible.origin.y),
            "visibleWidth": int(visible.size.width),
            "visibleHeight": int(visible.size.height),
        })
    return result


def get_screen_bounds(screen_index: int) -> DisplayBounds | None:
    """获取指定屏幕的可用区域，返回 None 表示屏幕不存在"""
    if AppKit is None:
        return None

    screens = AppKit.NSScreen.screens()
    if not screens or screen_index < 0 or screen_index >= len(screens):
        return None

    visible = screens[screen_index].visibleFrame()
    return DisplayBounds(
        x=float(visible.origin.x),
        y=float(visible.origin.y),
        width=float(visible.size.width),
        height=float(visible.size.height),
    )


def build_maximized_frame(padding: float = 18.0) -> TerminalFrame:
    bounds = get_primary_display_bounds()
    return TerminalFrame(
        x=round(bounds.x + padding, 2),
        y=round(bounds.y + padding, 2),
        width=round(max(800.0, bounds.width - padding * 2), 2),
        height=round(max(500.0, bounds.height - padding * 2), 2),
    )


def suggest_monitor_grid(count: int) -> tuple[int, int]:
    if count <= 1:
        return 1, 1
    if count == 2:
        return 2, 1
    if 3 <= count <= 4:
        return 2, 2
    if 5 <= count <= 6:
        return 3, 2
    columns = max(3, ceil(sqrt(count)))
    rows = ceil(count / columns)
    return columns, rows


def build_grid_frames(count: int, params: GridLayoutParams) -> list[TerminalFrame]:
    if count <= 0:
        return []

    columns = max(1, params.columns)
    rows = max(params.rows, ceil(count / columns))
    gap = max(0.0, params.gap)
    padding = max(0.0, params.padding)
    bounds = get_primary_display_bounds()

    usable_width = max(100.0, bounds.width - padding * 2 - gap * (columns - 1))
    usable_height = max(100.0, bounds.height - padding * 2 - gap * (rows - 1))
    cell_width = usable_width / columns
    cell_height = usable_height / rows

    frames: list[TerminalFrame] = []
    for index in range(count):
        row = index // columns
        col = index % columns
        x = bounds.x + padding + col * (cell_width + gap)
        y = bounds.y + padding + (rows - row - 1) * (cell_height + gap)
        frames.append(
            TerminalFrame(
                x=round(x, 2),
                y=round(max(bounds.y, y), 2),
                width=round(cell_width, 2),
                height=round(cell_height, 2),
            )
        )
    return frames
