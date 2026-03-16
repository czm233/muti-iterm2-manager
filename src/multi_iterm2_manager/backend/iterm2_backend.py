from __future__ import annotations

import asyncio
import html
import os
import signal
import subprocess
import time
from typing import Any

from multi_iterm2_manager.display import build_maximized_frame
from multi_iterm2_manager.models import CreateTerminalParams, TerminalFrame, TerminalHandle

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None

import iterm2  # type: ignore

# ANSI 256 色调色板：索引 0-255 对应的 (r, g, b) 值
_ANSI_256_PALETTE: list[tuple[int, int, int]] = [
    # 索引 0-7：标准 ANSI 8 色
    (0, 0, 0),        # 0 黑
    (205, 0, 0),      # 1 红
    (0, 205, 0),      # 2 绿
    (205, 205, 0),    # 3 黄
    (0, 0, 238),      # 4 蓝
    (205, 0, 205),    # 5 洋红
    (0, 205, 205),    # 6 青
    (229, 229, 229),  # 7 白
    # 索引 8-15：亮色 ANSI 8 色
    (127, 127, 127),  # 8  亮黑(灰)
    (255, 0, 0),      # 9  亮红
    (0, 255, 0),      # 10 亮绿
    (255, 255, 0),    # 11 亮黄
    (92, 92, 255),    # 12 亮蓝
    (255, 0, 255),    # 13 亮洋红
    (0, 255, 255),    # 14 亮青
    (255, 255, 255),  # 15 亮白
]

# 索引 16-231：216 色立方体（6x6x6）
for _i in range(216):
    _r = _i // 36
    _g = (_i % 36) // 6
    _b = _i % 6
    _ANSI_256_PALETTE.append((
        _r * 40 + 55 if _r else 0,
        _g * 40 + 55 if _g else 0,
        _b * 40 + 55 if _b else 0,
    ))

# 索引 232-255：24 级灰度
for _i in range(24):
    _v = 8 + _i * 10
    _ANSI_256_PALETTE.append((_v, _v, _v))


def _color_to_css(color, css_prop: str) -> str | None:
    """将 CellStyle.Color 转为 CSS 颜色字符串，返回 None 表示使用默认色"""
    if color is None:
        return None
    try:
        if color.is_rgb:
            return f"{css_prop}: rgb({color.rgb.red}, {color.rgb.green}, {color.rgb.blue})"
        if color.is_standard:
            idx = color.standard
            if 0 <= idx < 256:
                r, g, b = _ANSI_256_PALETTE[idx]
                return f"{css_prop}: rgb({r}, {g}, {b})"
    except Exception:
        pass
    return None


MANAGED_FLAG_VAR = "user.mitm_managed"
MANAGED_OWNER_VAR = "user.mitm_owner"
MANAGED_OWNER_VALUE = "multi-iterm2-manager"
MANAGED_NAME_VAR = "user.mitm_name"
MANAGED_HIDDEN_VAR = "user.mitm_hidden"
MANAGED_TAGS_VAR = "user.mitm_tags"  # 标签列表，逗号分隔存储
MANAGED_ID_VAR = "user.mitm_id"  # 持久化终端 ID，跨重启稳定
MANAGED_MUTED_VAR = "user.mitm_muted"  # 静默状态，跨重启稳定
ANCHOR_ROLE_VAR = "user.mitm_role"
ANCHOR_ROLE_VALUE = "anchor"


class ITerm2Backend:
    def __init__(self, connect_retries: int = 20, retry_delay: float = 0.5) -> None:
        self._connect_retries = connect_retries
        self._retry_delay = retry_delay
        self._connection: Any = None
        self._app: Any = None
        self._lock = asyncio.Lock()
        self._last_refresh: float = 0

    async def start(self) -> None:
        await self._ensure_connection()

    async def stop(self) -> None:
        if self._connection is not None:
            try:
                await self._connection.async_close()
            except Exception:
                pass
        self._connection = None
        self._app = None

    def is_alive(self) -> bool:
        return self._is_iterm2_running()

    async def ping(self) -> bool:
        try:
            await asyncio.wait_for(self._ping_once(), timeout=3)
            return True
        except Exception:
            try:
                await self._reset_runtime()
                await asyncio.wait_for(self._ping_once(), timeout=3)
                return True
            except Exception:
                return False

    async def _ping_once(self) -> None:
        _, app = await self._get_runtime()
        await app.async_refresh()

    async def cleanup_managed_terminals(self) -> int:
        _, app = await self._get_runtime()
        await app.async_refresh()
        handles: list[TerminalHandle] = []
        for window in list(app.terminal_windows):
            for tab in list(window.tabs):
                for session in list(tab.sessions):
                    if await self._is_managed_session(session):
                        handles.append(
                            TerminalHandle(
                                window_id=window.window_id,
                                session_id=session.session_id,
                                tab_id=tab.tab_id,
                            )
                        )
        for handle in handles:
            try:
                await self.close(handle)
            except Exception:
                pass
        await self.maybe_quit_app()
        return len(handles)

    async def unmark_all_managed(self) -> int:
        """取消所有 session 的管理标记，但不关闭窗口。"""
        async def _inner():
            _, app = await self._get_runtime()
            await app.async_refresh()
            count = 0
            for window in list(app.terminal_windows):
                for tab in list(window.tabs):
                    for session in list(tab.sessions):
                        try:
                            is_managed = await self._is_managed_session(session)
                            if is_managed:
                                await session.async_set_variable(MANAGED_FLAG_VAR, "")
                                await session.async_set_variable(MANAGED_OWNER_VAR, "")
                                count += 1
                        except Exception:
                            pass
            return count
        return await self._run_with_reconnect(_inner)

    async def create_terminal(self, params: CreateTerminalParams) -> TerminalHandle:
        async def _inner():
            connection, app = await self._get_runtime()
            window = await iterm2.Window.async_create(connection, profile=params.profile, command=params.command)
            if window is None:
                raise RuntimeError("iTerm2 返回了空窗口")
            await app.async_refresh()
            fresh_window = app.get_window_by_id(window.window_id) or window
            tab = fresh_window.current_tab
            if tab is None or tab.current_session is None:
                raise RuntimeError("无法从新窗口中解析当前 session")
            session = tab.current_session
            try:
                await session.async_set_variable(MANAGED_FLAG_VAR, True)
                await session.async_set_variable(MANAGED_OWNER_VAR, MANAGED_OWNER_VALUE)
                await session.async_set_variable(ANCHOR_ROLE_VAR, "managed")
            except Exception:
                pass
            if params.name:
                try:
                    await session.async_set_name(params.name)
                    await session.async_set_variable(MANAGED_NAME_VAR, params.name)
                except Exception:
                    pass
            target_frame = params.frame or build_maximized_frame()
            handle = TerminalHandle(window_id=fresh_window.window_id, session_id=session.session_id, tab_id=tab.tab_id)
            await self.set_frame(handle, target_frame)
            await self.hide_app()
            return handle
        return await self._run_with_reconnect(_inner)

    # 最大捕获行数（监控场景只需看近期输出）
    SCREEN_MAX_LINES = 80

    async def get_screen_render(self, handle: TerminalHandle) -> tuple[str, str]:
        async def _inner():
            session = await self._get_session(handle.session_id)
            line_info = await session.async_get_line_info()
            history = line_info.scrollback_buffer_height
            height = line_info.mutable_area_height
            overflow = line_info.overflow
            total = history + height
            max_lines = min(total, self.SCREEN_MAX_LINES)
            start_y = overflow + total - max_lines
            end_y = overflow + total


            coord_range = iterm2.util.CoordRange(
                iterm2.util.Point(0, start_y),
                iterm2.util.Point(0, end_y),
            )
            wcr = iterm2.util.WindowedCoordRange(coord_range)

            response = await iterm2.rpc.async_get_screen_contents(
                connection=self._connection,
                session=session.session_id,
                windowed_coord_range=wcr,
                style=True,
            )
            if response.get_buffer_response.status != iterm2.api_pb2.GetBufferResponse.Status.Value("OK"):
                raise RuntimeError("读取终端屏幕失败")
            contents = iterm2.screen.ScreenContents(response.get_buffer_response)
            return self._screen_to_text(contents), self._screen_to_html(contents)
        try:
            return await self._run_with_reconnect(_inner)
        except Exception as exc:
            print(f"[get_screen_render] fallback: {type(exc).__name__}: {exc}", flush=True)
            async def _fallback():
                session = await self._get_session(handle.session_id)
                contents = await session.async_get_screen_contents()
                plain_text = self._screen_to_text(contents)
                return plain_text, f'<pre class="terminal-mirror">{html.escape(plain_text or "暂无输出")}</pre>'
            return await self._run_with_reconnect(_fallback)

    async def get_screen_text(self, handle: TerminalHandle) -> str:
        text, _ = await self.get_screen_render(handle)
        return text

    async def stream_screen(self, handle: TerminalHandle):
        MAX_RECONNECT = 10
        INITIAL_BACKOFF = 0.5
        MAX_BACKOFF = 10.0

        sent_initial = False
        reconnect_count = 0
        backoff = INITIAL_BACKOFF
        while True:
            try:
                session = await self._get_session(handle.session_id)
                async with session.get_screen_streamer() as streamer:
                    if not sent_initial:
                        yield await self.get_screen_render(handle)
                        sent_initial = True
                    # 成功恢复连接，重置重连计数器
                    reconnect_count = 0
                    backoff = INITIAL_BACKOFF
                    while True:
                        try:
                            await asyncio.wait_for(streamer.async_get(), timeout=5)
                        except asyncio.TimeoutError:
                            if not self._is_iterm2_running():
                                raise RuntimeError("无法连接 iTerm2 — 应用未在运行")
                        # 每次都检查 session 是否还存在（检测窗口关闭）
                        try:
                            await self._get_session(handle.session_id)
                        except Exception:
                            raise RuntimeError(f"找不到 session: {handle.session_id}")
                        yield await self.get_screen_render(handle)
            except Exception as exc:
                print(f"[stream_screen] 异常: {type(exc).__name__}: {exc}", flush=True)
                print(f"[stream_screen] _is_connection_lost={self._is_connection_lost_error(exc)}", flush=True)
                if not self._is_connection_lost_error(exc):
                    raise
                reconnect_count += 1
                if reconnect_count > MAX_RECONNECT:
                    print(f"[stream_screen] 超过最大重连次数({MAX_RECONNECT})，终止 stream", flush=True)
                    return
                print(f"[stream_screen] 第 {reconnect_count}/{MAX_RECONNECT} 次重连，退避 {backoff:.1f}s", flush=True)
                await self._reset_runtime()
                await self._ensure_connection(launch=False)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, MAX_BACKOFF)

    async def send_text(self, handle: TerminalHandle, text: str) -> None:
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_send_text(text)
        await self._run_with_reconnect(_inner)

    async def focus(self, handle: TerminalHandle) -> None:
        # 保存剪贴板状态：macOS 应用切换时可能清空系统剪贴板
        saved_clipboard = None
        saved_change_count = None
        if AppKit is not None:
            try:
                pb = AppKit.NSPasteboard.generalPasteboard()
                saved_change_count = pb.changeCount()
                saved_clipboard = []
                for pb_type in pb.types() or []:
                    data = pb.dataForType_(pb_type)
                    if data is not None:
                        saved_clipboard.append((pb_type, bytes(data)))
            except Exception:
                saved_clipboard = None
                saved_change_count = None

        async def _inner():
            await self._get_runtime()
            session = await self._get_session(handle.session_id)
            await session.async_activate(select_tab=True, order_window_front=True)
            # 将 iTerm2 app 激活到前台（高于浏览器等其他窗口）
            # 使用 NSApplicationActivateIgnoringOtherApps 而非 app.async_activate()
            # 避免恢复所有最小化窗口
            if AppKit is not None:
                try:
                    apps = AppKit.NSRunningApplication.runningApplicationsWithBundleIdentifier_("com.googlecode.iterm2")
                    if apps:
                        apps[0].activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
                except Exception:
                    pass
        await self._run_with_reconnect(_inner)

        # 恢复剪贴板：如果 changeCount 变化说明剪贴板被清空/修改了
        if AppKit is not None and saved_clipboard is not None and saved_change_count is not None:
            try:
                pb = AppKit.NSPasteboard.generalPasteboard()
                if pb.changeCount() != saved_change_count:
                    pb.clearContents()
                    for pb_type, data_bytes in saved_clipboard:
                        ns_data = AppKit.NSData.dataWithBytes_length_(data_bytes, len(data_bytes))
                        pb.setData_forType_(ns_data, pb_type)
            except Exception:
                pass

    async def detach(self, handle: TerminalHandle) -> None:
        async def _inner():
            await self._get_runtime()  # 确保连接有效
            session = await self._get_session(handle.session_id)
            # 先清除管理标记
            await session.async_set_variable(MANAGED_FLAG_VAR, "")
            await session.async_set_variable(MANAGED_OWNER_VAR, "")
            await session.async_set_variable(ANCHOR_ROLE_VAR, "")
            # 只激活目标 session 的窗口，不调用 app.async_activate()
            # 避免锚点终端等其他窗口一起显现
            await session.async_activate(select_tab=True, order_window_front=True)
        await self._run_with_reconnect(_inner)

    async def scan_unmanaged_sessions(self, known_session_ids: set[str] | None = None) -> list[dict]:
        async def _inner():
            _, app = await self._get_runtime(force_refresh=True)
            results: list[dict] = []
            for window in list(app.terminal_windows):
                for tab in list(window.tabs):
                    for session in list(tab.sessions):
                        try:
                            role = await session.async_get_variable(ANCHOR_ROLE_VAR)
                        except Exception:
                            role = None
                        if role == ANCHOR_ROLE_VALUE:
                            continue
                        is_managed = await self._is_managed_session(session)
                        if is_managed:
                            # 若服务传入了已知 session 集合，则"有标记但不在集合里"的
                            # 属于孤儿托管（服务重启后遗留），应包含进扫描结果
                            if known_session_ids is not None and session.session_id not in known_session_ids:
                                pass  # 孤儿，继续加入结果
                            else:
                                continue  # 当前服务已知的管理终端，跳过
                        try:
                            name = await session.async_get_variable(MANAGED_NAME_VAR)
                            if not name:
                                name = await session.async_get_variable("name") or session.session_id
                        except Exception:
                            name = session.session_id
                        try:
                            title = await session.async_get_variable("terminalTitle") or ""
                        except Exception:
                            title = ""
                        results.append({
                            "session_id": session.session_id,
                            "window_id": window.window_id,
                            "tab_id": tab.tab_id,
                            "name": name,
                            "title": title,
                        })
            return results
        return await self._run_with_reconnect(_inner)

    async def adopt(self, session_id: str, name: str | None = None) -> TerminalHandle:
        async def _inner():
            _, app = await self._get_runtime(force_refresh=True)
            target_session = None
            target_window_id = None
            target_tab_id = None
            for window in list(app.terminal_windows):
                for tab in list(window.tabs):
                    for session in list(tab.sessions):
                        if session.session_id == session_id:
                            target_session = session
                            target_window_id = window.window_id
                            target_tab_id = tab.tab_id
                            break
                    if target_session:
                        break
                if target_session:
                    break
            if target_session is None:
                raise ValueError(f"找不到 session: {session_id}")
            assert target_window_id is not None  # target_session 不为 None 时一定已赋值
            await target_session.async_set_variable(MANAGED_FLAG_VAR, True)
            await target_session.async_set_variable(MANAGED_OWNER_VAR, MANAGED_OWNER_VALUE)
            await target_session.async_set_variable(ANCHOR_ROLE_VAR, "managed")
            # 读取 iTerm2 中 session 的当前名字，用于接管时保留原始名
            adopted_name = None
            if name:
                try:
                    await target_session.async_set_name(name)
                except Exception:
                    pass
            else:
                # 没有显式传入名字，优先从自定义变量读取管理器设置的名字
                try:
                    adopted_name = await target_session.async_get_variable(MANAGED_NAME_VAR)
                    if not adopted_name:
                        adopted_name = await target_session.async_get_variable("session.name")
                except Exception:
                    pass
            # 读取隐藏状态
            adopted_hidden = False
            try:
                hidden_val = await target_session.async_get_variable(MANAGED_HIDDEN_VAR)
                adopted_hidden = bool(hidden_val)
            except Exception:
                pass
            # 读取静默状态
            adopted_muted = False
            try:
                muted_val = await target_session.async_get_variable(MANAGED_MUTED_VAR)
                adopted_muted = bool(muted_val)
            except Exception:
                pass
            # 读取标签列表
            adopted_tags: list[str] = []
            try:
                tags_val = await target_session.async_get_variable(MANAGED_TAGS_VAR)
                if tags_val and isinstance(tags_val, str):
                    adopted_tags = [t.strip() for t in tags_val.split(",") if t.strip()]
            except Exception:
                pass
            # 读取持久化终端 ID
            adopted_id = None
            try:
                adopted_id = await target_session.async_get_variable(MANAGED_ID_VAR)
                if not adopted_id or not isinstance(adopted_id, str):
                    adopted_id = None
            except Exception:
                pass
            await self.hide_app()
            return TerminalHandle(
                window_id=target_window_id,
                session_id=session_id,
                tab_id=target_tab_id,
                adopted_name=adopted_name,
                adopted_id=adopted_id,
                adopted_muted=adopted_muted,
                adopted_hidden=adopted_hidden,
                adopted_tags=adopted_tags,
            )
        return await self._run_with_reconnect(_inner)

    async def get_cwd(self, handle: TerminalHandle) -> str | None:
        """获取终端 session 的当前工作目录"""
        async def _inner():
            session = await self._get_session(handle.session_id)
            try:
                path = await session.async_get_variable("path")
                return path or None
            except Exception:
                return None
        try:
            return await self._run_with_reconnect(_inner)
        except Exception:
            return None

    async def set_hidden(self, handle: TerminalHandle, hidden: bool) -> None:
        """将隐藏状态写入 iTerm2 session 变量，重启后可恢复"""
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_set_variable(MANAGED_HIDDEN_VAR, hidden)
        await self._run_with_reconnect(_inner)

    async def set_tags(self, handle: TerminalHandle, tags: list[str]) -> None:
        """将标签列表写入 iTerm2 session 变量，逗号分隔存储，重启后可恢复"""
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_set_variable(MANAGED_TAGS_VAR, ",".join(tags))
        await self._run_with_reconnect(_inner)

    async def set_terminal_id(self, handle: TerminalHandle, terminal_id: str) -> None:
        """将终端 ID 写入 iTerm2 session 变量，跨重启持久化"""
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_set_variable(MANAGED_ID_VAR, terminal_id)
        await self._run_with_reconnect(_inner)

    async def set_muted(self, handle: TerminalHandle, muted: bool) -> None:
        """将静默状态写入 iTerm2 session 变量，重启后可恢复"""
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_set_variable(MANAGED_MUTED_VAR, muted)
        await self._run_with_reconnect(_inner)

    async def rename(self, handle: TerminalHandle, name: str) -> None:
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_set_name(name)
            await session.async_set_variable(MANAGED_NAME_VAR, name)
        await self._run_with_reconnect(_inner)

    async def hide_app(self) -> None:
        if AppKit is not None:
            try:
                apps = AppKit.NSRunningApplication.runningApplicationsWithBundleIdentifier_("com.googlecode.iterm2")
                if apps:
                    apps[0].hide()
                    return
            except Exception:
                pass
        subprocess.run(["/usr/bin/osascript", "-e", 'tell application "iTerm" to hide'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

    async def maybe_quit_app(self) -> None:
        try:
            _, app = await self._get_runtime()
            await app.async_refresh()
            real_windows = 0
            for window in list(app.terminal_windows):
                has_non_anchor = False
                for tab in list(window.tabs):
                    for session in list(tab.sessions):
                        try:
                            owner = await session.async_get_variable(MANAGED_OWNER_VAR)
                            role = await session.async_get_variable(ANCHOR_ROLE_VAR)
                        except Exception:
                            owner = None
                            role = None
                        if not (owner == MANAGED_OWNER_VALUE and role == ANCHOR_ROLE_VALUE):
                            has_non_anchor = True
                if has_non_anchor:
                    real_windows += 1
            if real_windows == 0 and len(app.terminal_windows) == 0:
                subprocess.run(["/usr/bin/osascript", "-e", 'tell application "iTerm" to quit'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        except Exception:
            return

    async def close(self, handle: TerminalHandle) -> None:
        try:
            await asyncio.wait_for(self._terminate_tty_processes(handle), timeout=5)
        except Exception:
            pass
        async def _inner():
            try:
                session = await self._get_session(handle.session_id)
                await session.async_close(force=True)
            except Exception:
                pass
            try:
                window = await self._get_window(handle.window_id)
                await window.async_close(force=True)
            except Exception:
                pass
        await self._run_with_reconnect(_inner)

    async def set_frame(self, handle: TerminalHandle, frame: TerminalFrame) -> None:
        async def _inner():
            window = await self._get_window(handle.window_id)
            native_frame = iterm2.util.Frame()
            native_frame.origin.x = frame.x
            native_frame.origin.y = frame.y
            native_frame.size.width = frame.width
            native_frame.size.height = frame.height
            await window.async_set_frame(native_frame)
        await self._run_with_reconnect(_inner)

    async def get_frame(self, handle: TerminalHandle) -> TerminalFrame | None:
        async def _inner():
            window = await self._get_window(handle.window_id)
            native_frame = await window.async_get_frame()
            return TerminalFrame(
                x=float(native_frame.origin.x),
                y=float(native_frame.origin.y),
                width=float(native_frame.size.width),
                height=float(native_frame.size.height),
            )
        return await self._run_with_reconnect(_inner)

    async def _terminate_tty_processes(self, handle: TerminalHandle) -> None:
        try:
            session = await self._get_session(handle.session_id)
            tty = await session.async_get_variable("tty")
        except Exception:
            return
        if not tty or not isinstance(tty, str):
            return
        short = tty.replace('/dev/', '')
        try:
            proc = subprocess.run(['bash', '-lc', f"ps -t {short} -o pid="], capture_output=True, text=True, check=False)
            pids = [int(item) for item in proc.stdout.split() if item.strip()]
            # 跳过当前进程自身，避免服务器从被管理终端启动时误杀自己
            my_pid = os.getpid()
            for pid in pids:
                if pid == my_pid:
                    continue
                try:
                    os.kill(pid, signal.SIGKILL)
                except Exception:
                    pass
        except Exception:
            return

    async def _is_managed_session(self, session: Any) -> bool:
        try:
            managed = await session.async_get_variable(MANAGED_FLAG_VAR)
            owner = await session.async_get_variable(MANAGED_OWNER_VAR)
            return bool(managed) or owner == MANAGED_OWNER_VALUE
        except Exception:
            return False

    async def _get_runtime(self, *, force_refresh: bool = False):
        connection = await self._ensure_connection()
        if self._app is None:
            self._app = await iterm2.async_get_app(connection)
        # 1秒内不重复 refresh，减少 RPC 调用；force_refresh 跳过节流
        now = time.monotonic()
        if force_refresh or (now - self._last_refresh >= 1.0):
            await self._app.async_refresh()
            self._last_refresh = now
        return connection, self._app

    async def _run_with_reconnect(self, callback):
        try:
            return await asyncio.wait_for(callback(), timeout=8)
        except Exception as exc:
            if not self._is_connection_lost_error(exc):
                raise
            await self._reset_runtime()
            await self._ensure_connection(launch=False)
            return await asyncio.wait_for(callback(), timeout=8)

    async def _reset_runtime(self) -> None:
        if self._connection is not None:
            try:
                await self._connection.async_close()
            except Exception:
                pass
        self._connection = None
        self._app = None

    def _is_connection_lost_error(self, exc: Exception) -> bool:
        message = str(exc).lower()
        patterns = ['no close frame received or sent', 'connection closed', 'connection refused', 'socket closed', 'socket is closed', 'broken pipe']
        return any(pattern in message for pattern in patterns)

    async def _ensure_connection(self, *, launch: bool = True):
        async with self._lock:
            if self._connection is not None:
                return self._connection
            if launch:
                self._launch_iterm2()
            elif not self._is_iterm2_running():
                raise RuntimeError("无法连接 iTerm2 — 应用未在运行")
            last_error: Exception | None = None
            for _ in range(self._connect_retries):
                try:
                    self._connection = await iterm2.Connection.async_create()
                    self._app = await iterm2.async_get_app(self._connection)
                    await self._app.async_refresh()
                    return self._connection
                except Exception as exc:
                    last_error = exc
                    if not launch and not self._is_iterm2_running():
                        break
                    self._clear_auth_env()
                    try:
                        self._prime_auth_env(force=True)
                    except Exception:
                        pass
                    await asyncio.sleep(self._retry_delay)
            raise RuntimeError("无法连接 iTerm2 Python API。请确认已开启 Python API，并在 iTerm 中允许脚本授权请求。") from last_error

    def _is_iterm2_running(self) -> bool:
        try:
            result = subprocess.run(["pgrep", "-x", "iTerm2"], capture_output=True, check=False)
            return result.returncode == 0
        except Exception:
            return False

    def _launch_iterm2(self) -> None:
        print("[backend] _launch_iterm2() 被调用!", flush=True)
        if self._is_iterm2_running():
            return
        try:
            subprocess.run(
                ["/usr/bin/open", "-g", "-j", "-a", "iTerm"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except Exception:
            pass

    def _prime_auth_env(self, force: bool) -> None:
        print(f"[backend] _prime_auth_env(force={force}) 被调用!", flush=True)
        if not force and os.environ.get("ITERM2_COOKIE") and os.environ.get("ITERM2_KEY"):
            return
        if force:
            self._clear_auth_env()
        cookie_and_key = self._request_cookie_and_key_via_osascript(app_name="Codex", timeout=20)
        cookie, key = cookie_and_key.split(" ", 1)
        os.environ["ITERM2_COOKIE"] = cookie
        os.environ["ITERM2_KEY"] = key

    def _clear_auth_env(self) -> None:
        os.environ.pop("ITERM2_COOKIE", None)
        os.environ.pop("ITERM2_KEY", None)

    def _request_cookie_and_key_via_osascript(self, app_name: str, timeout: int) -> str:
        script = f'tell application "iTerm2" to request cookie and key for app named "{app_name}"'
        try:
            result = subprocess.run(["/usr/bin/osascript", "-"], input=script.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("iTerm 授权请求超时，请检查 iTerm 是否弹出了允许脚本访问的确认框") from exc
        stdout = result.stdout.decode("utf-8", errors="replace").strip()
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        if result.returncode != 0:
            raise RuntimeError(f"iTerm 授权失败：{stderr or '未知错误'}")
        if " " not in stdout:
            raise RuntimeError(f"iTerm 返回了异常认证结果：{stdout or '空结果'}")
        return stdout

    async def _get_session(self, session_id: str):
        _, app = await self._get_runtime()
        session = app.get_session_by_id(session_id)
        if session is None:
            # app 缓存可能过期（如服务重启后重新接管），强制刷新重试一次
            _, app = await self._get_runtime(force_refresh=True)
            session = app.get_session_by_id(session_id)
        if session is None:
            raise RuntimeError(f"找不到 session: {session_id}")
        return session

    async def _get_window(self, window_id: str):
        _, app = await self._get_runtime()
        window = app.get_window_by_id(window_id)
        if window is None:
            raise RuntimeError(f"找不到 window: {window_id}")
        return window

    def _is_visually_blank_line(self, text: str | None) -> bool:
        if not text:
            return True
        normalized = text.replace("\xa0", " ").replace("\u2007", " ").replace("\u202f", " ")
        return not normalized.strip()

    def _visible_line_count(self, contents) -> int:
        if contents is None:
            return 0
        last_visible_index = -1
        for index in range(contents.number_of_lines):
            line = contents.line(index)
            text = line.string if line is not None else ""
            if not self._is_visually_blank_line(text):
                last_visible_index = index
        return last_visible_index + 1

    def _screen_to_text(self, contents) -> str:
        if contents is None:
            return ""
        lines: list[str] = []
        visible_count = self._visible_line_count(contents)
        for index in range(visible_count):
            line = contents.line(index).string.rstrip()
            lines.append(line)
        return "\n".join(lines).rstrip()

    def _build_css_tuple(self, style) -> tuple[str, ...] | None:
        """将 CellStyle 转为可比较的 CSS 属性元组，无样式返回 None"""
        if style is None:
            return None
        css: list[str] = []
        fg_css = _color_to_css(style.fg_color, "color")
        if fg_css:
            css.append(fg_css)
        bg_css = _color_to_css(style.bg_color, "background-color")
        if bg_css:
            css.append(bg_css)
        if getattr(style, 'bold', False):
            css.append('font-weight: 700')
        if getattr(style, 'italic', False):
            css.append('font-style: italic')
        if getattr(style, 'underline', False):
            css.append('text-decoration: underline')
        return tuple(css) if css else None

    def _flush_span(self, css_tuple: tuple[str, ...] | None, buf: list[str], segments: list[str]) -> None:
        """将缓冲区中的字符刷出为一个 span（或纯文本）"""
        if not buf:
            return
        text = ''.join(buf)
        if css_tuple:
            segments.append(f'<span style="{"; ".join(css_tuple)}">{text}</span>')
        else:
            segments.append(text)
        buf.clear()

    def _screen_to_html(self, contents) -> str:
        visible_count = self._visible_line_count(contents)
        if contents is None or visible_count == 0:
            return '<pre class="terminal-mirror">暂无输出</pre>'
        html_lines = []
        for index in range(visible_count):
            line = contents.line(index)
            segments: list[str] = []
            text = line.string or ""
            max_len = len(text)
            # 合并相邻相同样式的字符到一个 span
            cur_css: tuple[str, ...] | None = None
            buf: list[str] = []
            for pos in range(max_len):
                ch = html.escape(line.string_at(pos) or " ")
                style = line.style_at(pos)
                css_tuple = self._build_css_tuple(style)
                if css_tuple != cur_css:
                    self._flush_span(cur_css, buf, segments)
                    cur_css = css_tuple
                buf.append(ch)
            self._flush_span(cur_css, buf, segments)
            html_lines.append(''.join(segments) if segments else '&nbsp;')
        return '<pre class="terminal-mirror terminal-mirror-rich">' + '\n'.join(html_lines) + '</pre>'
