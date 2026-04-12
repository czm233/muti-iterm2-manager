"""App 监控核心服务 - 管理被监控 App 的生命周期和截图任务"""
from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from contextlib import suppress
from datetime import datetime

from multi_iterm2_manager.app_monitor.models import (
    AppMonitorSettings,
    AppMonitorStatus,
    MonitoredApp,
    new_app_monitor_id,
)
from multi_iterm2_manager.app_monitor.discover import discover_visible_windows
from multi_iterm2_manager.app_monitor.screenshot import capture_window

logger = logging.getLogger(__name__)

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None


class AppMonitorService:
    """App 监控服务，负责窗口发现、截图循环和焦点唤醒"""

    def __init__(self, broadcast_fn, settings: AppMonitorSettings | None = None) -> None:
        self._broadcast = broadcast_fn
        self.settings = settings or AppMonitorSettings()
        self.records: dict[str, MonitoredApp] = {}
        self._screenshot_tasks: dict[str, asyncio.Task[None]] = {}

    async def discover_windows(self) -> list[dict]:
        """发现当前所有可见窗口"""
        windows = await asyncio.to_thread(discover_visible_windows)
        return [w.to_dict() for w in windows]

    async def add_monitor(
        self,
        pid: int,
        window_number: int,
        app_name: str,
        window_title: str,
        bundle_id: str = "",
        owner_name: str = "",
    ) -> dict:
        """添加一个 App 到监控列表"""
        resolved = await self._resolve_monitor_window(
            pid=pid,
            window_title=window_title,
            bundle_id=bundle_id,
            owner_name=owner_name,
        )
        if resolved is not None:
            pid = resolved.pid
            bundle_id = resolved.bundle_id or bundle_id
            app_name = resolved.app_name or app_name
            window_title = resolved.window_title or window_title
            window_number = resolved.window_number
            owner_name = resolved.owner_name or owner_name
            frame = resolved.frame
        else:
            frame = {}

        logical_key = self._monitor_key(
            pid=pid,
            bundle_id=bundle_id,
            owner_name=owner_name,
            app_name=app_name,
            window_title=window_title,
        )

        # 去重：同一逻辑窗口（同一进程同一标题）不重复添加
        for existing in self.records.values():
            if self._monitor_key(
                pid=existing.pid,
                bundle_id=existing.bundle_id,
                owner_name=existing.owner_name,
                app_name=existing.app_name,
                window_title=existing.window_title,
            ) == logical_key:
                logger.info("App %s (%s) 已在监控列表中，跳过", app_name, window_title)
                if existing.window_number != window_number:
                    existing.window_number = window_number
                    existing.frame = frame
                    existing.updated_at = self._now()
                return existing.to_dict()
            if existing.window_number == window_number and existing.pid == pid:
                logger.info("窗口 %d 已在监控列表中，跳过", window_number)
                return existing.to_dict()

        app_id = new_app_monitor_id()
        record = MonitoredApp(
            id=app_id,
            pid=pid,
            bundle_id=bundle_id,
            app_name=app_name,
            window_title=window_title,
            window_number=window_number,
            owner_name=owner_name,
            frame=frame,
            status=AppMonitorStatus.active,
        )
        self.records[app_id] = record
        self._start_screenshot_loop(app_id)
        logger.info("添加 App 监控: %s (pid=%d, window=%d)", app_name, pid, window_number)
        await self._broadcast({
            "type": "app-monitor-updated",
            "monitor": record.to_dict(),
        })
        return record.to_dict()

    async def remove_monitor(self, app_id: str) -> dict:
        """移除一个 App 监控"""
        record = self.records.get(app_id)
        if record is None:
            raise KeyError(f"未找到 App 监控: {app_id}")

        task = self._screenshot_tasks.pop(app_id, None)
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

        del self.records[app_id]
        logger.info("移除 App 监控: %s (%s)", record.app_name, app_id)
        await self._broadcast({
            "type": "app-monitor-removed",
            "appId": app_id,
        })
        return record.to_dict()

    async def focus_app(self, app_id: str) -> None:
        """唤醒（激活）指定 App 窗口"""
        record = self.records.get(app_id)
        if record is None:
            raise KeyError(f"未找到 App 监控: {app_id}")

        try:
            activated = False
            if AppKit is not None:
                ns_app = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(record.pid)
                if ns_app is None:
                    logger.warning("进程 %d 已不存在，无法激活", record.pid)
                    record.status = AppMonitorStatus.gone
                    record.updated_at = self._now()
                    await self._broadcast({
                        "type": "app-monitor-updated",
                        "monitor": record.to_dict(),
                    })
                    return

                # NSApplicationActivateIgnoringOtherApps = 1 << 1 = 2
                ns_app.activateWithOptions_(2)
                activated = True

            raised = self._raise_window(record)
            logger.info(
                "激活 App: %s (pid=%d, raised=%s, activated=%s)",
                record.app_name,
                record.pid,
                raised,
                activated,
            )
        except Exception:
            logger.exception("激活 App %s 时发生错误", record.app_name)

    def list_monitors(self) -> list[dict]:
        """获取所有被监控 App 的列表"""
        return [record.to_dict() for record in self.records.values()]

    async def start(self) -> None:
        """启动 App 监控服务"""
        logger.info("App 监控服务已启动")

    async def stop(self) -> None:
        """停止 App 监控服务，取消所有截图任务"""
        for task in self._screenshot_tasks.values():
            task.cancel()
        for task in list(self._screenshot_tasks.values()):
            with suppress(asyncio.CancelledError):
                await task
        self._screenshot_tasks.clear()
        logger.info("App 监控服务已停止")

    # ============ 内部方法 ============

    def _start_screenshot_loop(self, app_id: str) -> None:
        """启动指定 App 的截图循环任务"""
        task = asyncio.create_task(self._screenshot_loop(app_id))
        self._screenshot_tasks[app_id] = task

    async def _screenshot_loop(self, app_id: str) -> None:
        """截图循环：定时截取窗口并广播更新"""
        record = self.records.get(app_id)
        if record is None:
            return

        while True:
            try:
                # 检查进程是否存活
                if not self._is_pid_alive(record.pid):
                    logger.info("进程 %d 已退出，标记 App %s 为 gone", record.pid, record.app_name)
                    record.status = AppMonitorStatus.gone
                    record.updated_at = self._now()
                    await self._broadcast({
                        "type": "app-monitor-updated",
                        "monitor": record.to_dict(),
                    })
                    return

                # 截取窗口截图
                result = await asyncio.to_thread(
                    capture_window,
                    record.window_number,
                    self.settings.max_width,
                    self.settings.screenshot_quality,
                )

                if result is not None:
                    b64, width, height = result
                    record.screenshot_b64 = b64
                    record.screenshot_width = width
                    record.screenshot_height = height
                    record.status = AppMonitorStatus.active
                    record.last_error = None
                else:
                    # 截图失败，尝试通过 PID 查找新的窗口号（App 可能重建了窗口）
                    new_window = await self._find_window_for_record(record)
                    if new_window and new_window.window_number != record.window_number:
                        logger.info(
                            "窗口号变更: %s %d → %d",
                            record.app_name, record.window_number, new_window.window_number,
                        )
                        record.window_number = new_window.window_number
                        record.frame = new_window.frame
                        # 立即用新窗口号重试截图
                        retry = await asyncio.to_thread(
                            capture_window,
                            record.window_number,
                            self.settings.max_width,
                            self.settings.screenshot_quality,
                        )
                        if retry is not None:
                            b64, width, height = retry
                            record.screenshot_b64 = b64
                            record.screenshot_width = width
                            record.screenshot_height = height
                            record.status = AppMonitorStatus.active
                            record.last_error = None
                        else:
                            record.status = AppMonitorStatus.error
                            record.last_error = "截图失败，窗口可能不可见"
                    else:
                        record.status = AppMonitorStatus.error
                        record.last_error = "截图失败，窗口可能不可见"

                record.updated_at = self._now()

                if record.id in self.records:
                    await self._broadcast({
                        "type": "app-monitor-updated",
                        "monitor": record.to_dict(),
                    })

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("截图循环异常: app_id=%s", app_id)
                if record.id in self.records:
                    record.status = AppMonitorStatus.error
                    record.last_error = "截图循环异常"
                    record.updated_at = self._now()
                    await self._broadcast({
                        "type": "app-monitor-updated",
                        "monitor": record.to_dict(),
                    })

            await asyncio.sleep(self.settings.screenshot_interval_sec)

    @staticmethod
    def _is_pid_alive(pid: int) -> bool:
        """检查进程是否存活"""
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    async def _resolve_monitor_window(
        self,
        pid: int,
        window_title: str,
        bundle_id: str = "",
        owner_name: str = "",
    ):
        """把目标窗口规整为该逻辑窗口下的主窗口（通常是面积最大的那个）。"""
        try:
            windows = await asyncio.to_thread(discover_visible_windows)
            candidates = [
                win for win in windows
                if win.pid == pid and self._titles_match(win.window_title, window_title)
            ]
            if not candidates:
                candidates = [win for win in windows if win.pid == pid]
            if bundle_id:
                candidates = [win for win in candidates if not win.bundle_id or win.bundle_id == bundle_id] or candidates
            if owner_name:
                candidates = [win for win in candidates if not win.owner_name or win.owner_name == owner_name] or candidates
            if not candidates:
                return None
            return max(candidates, key=lambda win: self._window_area(win.frame))
        except Exception:
            logger.debug("规整监控窗口时出错: pid=%d", pid, exc_info=True)
            return None

    async def _find_window_for_record(self, record: MonitoredApp):
        """根据当前记录重新寻找最匹配的主窗口。"""
        return await self._resolve_monitor_window(
            pid=record.pid,
            window_title=record.window_title,
            bundle_id=record.bundle_id,
            owner_name=record.owner_name,
        )

    @staticmethod
    def _monitor_key(
        *,
        pid: int,
        bundle_id: str = "",
        owner_name: str = "",
        app_name: str = "",
        window_title: str = "",
    ) -> tuple[int, str, str]:
        scope = (bundle_id or owner_name or app_name or "").strip().lower()
        return (int(pid), scope, window_title.strip())

    @staticmethod
    def _titles_match(left: str, right: str) -> bool:
        return left.strip() == right.strip()

    @staticmethod
    def _window_area(frame: dict) -> float:
        try:
            return float(frame.get("width", 0) or 0) * float(frame.get("height", 0) or 0)
        except Exception:
            return 0.0

    def _raise_window(self, record: MonitoredApp) -> bool:
        """使用 AppleScript 把目标窗口抬到最前，避免只激活 App 看起来没反应。"""
        process_name = (record.owner_name or record.app_name or "").strip()
        if not process_name:
            return False

        window_title = (record.window_title or "").strip()
        script_lines = []
        if record.bundle_id:
            script_lines.append(
                f'tell application id "{self._osascript_escape(record.bundle_id)}" to activate'
            )
        script_lines.extend([
            'tell application "System Events"',
            f'  tell process "{self._osascript_escape(process_name)}"',
            '    set frontmost to true',
        ])
        if window_title:
            escaped_title = self._osascript_escape(window_title)
            script_lines.extend([
                f'    if exists window "{escaped_title}" then',
                f'      perform action "AXRaise" of window "{escaped_title}"',
                '    else if exists window 1 then',
                '      perform action "AXRaise" of window 1',
                '    end if',
            ])
        else:
            script_lines.extend([
                '    if exists window 1 then',
                '      perform action "AXRaise" of window 1',
                '    end if',
            ])
        script_lines.extend([
            '  end tell',
            'end tell',
        ])

        result = subprocess.run(
            ["/usr/bin/osascript", "-"],
            input="\n".join(script_lines).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=5,
        )
        if result.returncode == 0:
            return True

        stderr = result.stderr.decode("utf-8", errors="ignore").strip()
        if stderr:
            logger.warning("抬起窗口失败: %s", stderr)
        return False

    @staticmethod
    def _osascript_escape(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"')

    async def _find_window_for_pid(self, pid: int) -> int | None:
        """兼容旧调用：通过 PID 查找该进程的主窗口号"""
        try:
            windows = await asyncio.to_thread(discover_visible_windows)
            for win in windows:
                if win.pid == pid and win.window_title:
                    return win.window_number
        except Exception:
            logger.debug("查找 PID %d 的窗口时出错", pid, exc_info=True)
        return None

    @staticmethod
    def _now() -> str:
        """获取当前时间的 ISO 格式字符串"""
        return datetime.now().isoformat(timespec="seconds")
