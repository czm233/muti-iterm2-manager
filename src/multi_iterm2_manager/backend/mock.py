from __future__ import annotations

import asyncio
from datetime import datetime
from itertools import count

from multi_iterm2_manager.display import build_maximized_frame
from multi_iterm2_manager.models import CreateTerminalParams, TerminalFrame, TerminalHandle


class MockTerminalBackend:
    def __init__(self) -> None:
        self._items: dict[str, dict[str, object]] = {}
        self._counter = count(1)

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def cleanup_managed_terminals(self) -> int:
        count = len(self._items)
        self._items.clear()
        return count

    async def ensure_anchor_terminal(self) -> None:
        return None

    async def create_terminal(self, params: CreateTerminalParams) -> TerminalHandle:
        index = next(self._counter)
        session_id = f"mock-session-{index}"
        handle = TerminalHandle(
            window_id=f"mock-window-{index}",
            session_id=session_id,
            tab_id=f"mock-tab-{index}",
        )
        frame = params.frame or build_maximized_frame()
        self._items[session_id] = {
            "name": params.name,
            "command": params.command or "",
            "text": f"[{datetime.now().strftime('%H:%M:%S')}] 已创建模拟终端 {params.name}\n",
            "frame": frame,
        }
        return handle

    async def get_screen_render(self, handle: TerminalHandle) -> tuple[str, str]:
        item = self._items[handle.session_id]
        text = str(item["text"])
        html = '<pre class="terminal-mirror">' + text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;') + '</pre>'
        return text, html

    async def get_screen_text(self, handle: TerminalHandle) -> str:
        item = self._items[handle.session_id]
        return str(item["text"])

    async def stream_screen(self, handle: TerminalHandle):
        while handle.session_id in self._items:
            item = self._items[handle.session_id]
            now = datetime.now().strftime("%H:%M:%S")
            item["text"] = str(item["text"]) + f"[{now}] 模拟输出仍在刷新\n"
            yield str(item["text"])
            await asyncio.sleep(2)

    async def send_text(self, handle: TerminalHandle, text: str) -> None:
        item = self._items[handle.session_id]
        now = datetime.now().strftime("%H:%M:%S")
        item["text"] = str(item["text"]) + f"[{now}] 输入: {text}\n"

    async def focus(self, handle: TerminalHandle) -> None:
        return None

    async def rename(self, handle: TerminalHandle, name: str) -> None:
        if handle.session_id in self._items:
            self._items[handle.session_id]["name"] = name

    async def hide_app(self) -> None:
        return None

    async def maybe_quit_app(self) -> None:
        return None

    async def close(self, handle: TerminalHandle) -> None:
        self._items.pop(handle.session_id, None)

    async def set_frame(self, handle: TerminalHandle, frame: TerminalFrame) -> None:
        if handle.session_id in self._items:
            self._items[handle.session_id]["frame"] = frame

    async def get_frame(self, handle: TerminalHandle) -> TerminalFrame | None:
        if handle.session_id not in self._items:
            return None
        frame = self._items[handle.session_id]["frame"]
        return frame if isinstance(frame, TerminalFrame) else None
