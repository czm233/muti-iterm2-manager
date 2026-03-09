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
ANCHOR_TERMINAL_NAME = "系统终端（请勿关闭）"


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

    async def ensure_anchor_terminal(self) -> None:
        async def _inner():
            _, app = await self._get_runtime()
            await app.async_refresh()
            for window in list(app.terminal_windows):
                for tab in list(window.tabs):
                    for session in list(tab.sessions):
                        try:
                            owner = await session.async_get_variable(MANAGED_OWNER_VAR)
                            role = await session.async_get_variable(ANCHOR_ROLE_VAR)
                        except Exception:
                            owner = None
                            role = None
                        if owner == MANAGED_OWNER_VALUE and role == ANCHOR_ROLE_VALUE:
                            return
            window = await iterm2.Window.async_create(self._connection, command="/bin/zsh -l")
            if window is None:
                return
            await app.async_refresh()
            fresh_window = app.get_window_by_id(window.window_id) or window
            tab = fresh_window.current_tab
            if tab is None or tab.current_session is None:
                return
            session = tab.current_session
            try:
                await session.async_set_variable(MANAGED_FLAG_VAR, True)
                await session.async_set_variable(MANAGED_OWNER_VAR, MANAGED_OWNER_VALUE)
                await session.async_set_variable(ANCHOR_ROLE_VAR, ANCHOR_ROLE_VALUE)
                await session.async_set_name(ANCHOR_TERMINAL_NAME)
            except Exception:
                pass
        await self._run_with_reconnect(_inner)

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

    async def get_screen_render(self, handle: TerminalHandle) -> tuple[str, str]:
        async def _inner():
            session = await self._get_session(handle.session_id)
            response = await iterm2.rpc.async_get_screen_contents(
                connection=self._connection,
                session=session.session_id,
                windowed_coord_range=None,
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
                        await streamer.async_get()
                        yield await self.get_screen_render(handle)
            except Exception as exc:
                if not self._is_connection_lost_error(exc):
                    raise
                await self._reset_runtime()
                await self._ensure_connection()
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
            await self._ensure_connection()
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

    async def _ensure_connection(self):
        async with self._lock:
            if self._connection is not None:
                return self._connection
            self._launch_iterm2()
            last_error: Exception | None = None
            for _ in range(self._connect_retries):
                try:
                    self._connection = await iterm2.Connection.async_create()
                    self._app = await iterm2.async_get_app(self._connection)
                    await self._app.async_refresh()
                    return self._connection
                except Exception as exc:
                    last_error = exc
                    self._clear_auth_env()
                    try:
                        self._prime_auth_env(force=True)
                    except Exception:
                        pass
                    await asyncio.sleep(self._retry_delay)
            raise RuntimeError("无法连接 iTerm2 Python API。请确认已开启 Python API，并在 iTerm 中允许脚本授权请求。") from last_error

    def _launch_iterm2(self) -> None:
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

    def _screen_to_text(self, contents) -> str:
        if contents is None:
            return ""
        lines: list[str] = []
        for index in range(contents.number_of_lines):
            line = contents.line(index).string.rstrip()
            lines.append(line)
        return "\n".join(lines).rstrip()

    def _screen_to_html(self, contents) -> str:
        if contents is None or contents.number_of_lines == 0:
            return '<pre class="terminal-mirror">暂无输出</pre>'
        html_lines = []
        for index in range(contents.number_of_lines):
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
