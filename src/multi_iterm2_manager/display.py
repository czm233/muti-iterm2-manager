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
