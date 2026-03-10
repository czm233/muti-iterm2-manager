from __future__ import annotations

import asyncio
import html
import os
import signal
import subprocess
from typing import Any

from multi_iterm2_manager.display import build_maximized_frame
from multi_iterm2_manager.models import CreateTerminalParams, TerminalFrame, TerminalHandle

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None

import iterm2  # type: ignore

MANAGED_FLAG_VAR = "user.mitm_managed"
MANAGED_OWNER_VAR = "user.mitm_owner"
MANAGED_OWNER_VALUE = "multi-iterm2-manager"
ANCHOR_ROLE_VAR = "user.mitm_role"
ANCHOR_ROLE_VALUE = "anchor"


class ITerm2Backend:
    def __init__(self, connect_retries: int = 20, retry_delay: float = 0.5) -> None:
        self._connect_retries = connect_retries
        self._retry_delay = retry_delay
        self._connection: Any = None
        self._app: Any = None
        self._lock = asyncio.Lock()

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
                except Exception:
                    pass
            target_frame = params.frame or build_maximized_frame()
            handle = TerminalHandle(window_id=fresh_window.window_id, session_id=session.session_id, tab_id=tab.tab_id)
            await self.set_frame(handle, target_frame)
            await self.hide_app()
            return handle
        return await self._run_with_reconnect(_inner)

    # 最大捕获行数（包括滚动回看历史）
    SCREEN_MAX_LINES = 500

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
            print(f"[DEBUG] session={handle.session_id} history={history} height={height} overflow={overflow} total={total} max_lines={max_lines}")

            coord_range = iterm2.api_pb2.CoordRange()
            coord_range.start.x = 0
            coord_range.start.y = start_y
            coord_range.end.x = 0
            coord_range.end.y = end_y
            wcr = iterm2.api_pb2.WindowedCoordRange()
            wcr.coord_range.CopyFrom(coord_range)

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
        except Exception:
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
        sent_initial = False
        while True:
            try:
                session = await self._get_session(handle.session_id)
                async with session.get_screen_streamer() as streamer:
                    if not sent_initial:
                        yield await self.get_screen_render(handle)
                        sent_initial = True
                    while True:
                        try:
                            await asyncio.wait_for(streamer.async_get(), timeout=10)
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
                await self._reset_runtime()
                await self._ensure_connection(launch=False)
                await asyncio.sleep(0.2)

    async def send_text(self, handle: TerminalHandle, text: str) -> None:
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_send_text(text)
        await self._run_with_reconnect(_inner)

    async def focus(self, handle: TerminalHandle) -> None:
        async def _inner():
            _, app = await self._get_runtime()
            session = await self._get_session(handle.session_id)
            await app.async_activate()
            await session.async_activate(select_tab=True, order_window_front=True)
        await self._run_with_reconnect(_inner)

    async def detach(self, handle: TerminalHandle) -> None:
        async def _inner():
            _, app = await self._get_runtime()
            session = await self._get_session(handle.session_id)
            # 先清除管理标记
            await session.async_set_variable(MANAGED_FLAG_VAR, "")
            await session.async_set_variable(MANAGED_OWNER_VAR, "")
            await session.async_set_variable(ANCHOR_ROLE_VAR, "")
            # 只激活目标 session 的窗口，不调用 app.async_activate()
            # 避免锚点终端等其他窗口一起显现
            await session.async_activate(select_tab=True, order_window_front=True)
        await self._run_with_reconnect(_inner)

    async def scan_unmanaged_sessions(self) -> list[dict]:
        async def _inner():
            _, app = await self._get_runtime()
            await app.async_refresh()
            results: list[dict] = []
            for window in list(app.terminal_windows):
                for tab in list(window.tabs):
                    for session in list(tab.sessions):
                        if await self._is_managed_session(session):
                            continue
                        try:
                            role = await session.async_get_variable(ANCHOR_ROLE_VAR)
                        except Exception:
                            role = None
                        if role == ANCHOR_ROLE_VALUE:
                            continue
                        try:
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
            _, app = await self._get_runtime()
            await app.async_refresh()
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
            await target_session.async_set_variable(MANAGED_FLAG_VAR, True)
            await target_session.async_set_variable(MANAGED_OWNER_VAR, MANAGED_OWNER_VALUE)
            await target_session.async_set_variable(ANCHOR_ROLE_VAR, "managed")
            if name:
                try:
                    await target_session.async_set_name(name)
                except Exception:
                    pass
            await self.hide_app()
            return TerminalHandle(
                window_id=target_window_id,
                session_id=session_id,
                tab_id=target_tab_id,
            )
        return await self._run_with_reconnect(_inner)

    async def rename(self, handle: TerminalHandle, name: str) -> None:
        async def _inner():
            session = await self._get_session(handle.session_id)
            await session.async_set_name(name)
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
        await self._terminate_tty_processes(handle)
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
            for pid in pids:
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

    async def _get_runtime(self):
        connection = await self._ensure_connection()
        if self._app is None:
            self._app = await iterm2.async_get_app(connection)
        await self._app.async_refresh()
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
        try:
            subprocess.run(["/usr/bin/open", "-a", "iTerm"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        except Exception:
            pass
        if AppKit is None:
            return
        try:
            AppKit.NSWorkspace.sharedWorkspace().launchApplication_("iTerm2")
        except Exception:
            return

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

    def _screen_to_html(self, contents) -> str:
        visible_count = self._visible_line_count(contents)
        if contents is None or visible_count == 0:
            return '<pre class="terminal-mirror">暂无输出</pre>'
        html_lines = []
        for index in range(visible_count):
            line = contents.line(index)
            segments = []
            text = line.string or ""
            max_len = len(text)
            for pos in range(max_len):
                ch = html.escape(line.string_at(pos) or " ")
                style = line.style_at(pos)
                if style is None:
                    segments.append(ch)
                    continue
                css = []
                try:
                    fg = style.fg_color
                    if fg and fg.is_rgb:
                        css.append(f"color: rgb({fg.rgb.red}, {fg.rgb.green}, {fg.rgb.blue})")
                except Exception:
                    pass
                try:
                    bg = style.bg_color
                    if bg and bg.is_rgb:
                        css.append(f"background-color: rgb({bg.rgb.red}, {bg.rgb.green}, {bg.rgb.blue})")
                except Exception:
                    pass
                if getattr(style, 'bold', False):
                    css.append('font-weight: 700')
                if getattr(style, 'italic', False):
                    css.append('font-style: italic')
                if getattr(style, 'underline', False):
                    css.append('text-decoration: underline')
                if css:
                    segments.append(f'<span style="{"; ".join(css)}">{ch}</span>')
                else:
                    segments.append(ch)
            html_lines.append(''.join(segments) if segments else '&nbsp;')
        return '<pre class="terminal-mirror terminal-mirror-rich">' + '\n'.join(html_lines) + '</pre>'
