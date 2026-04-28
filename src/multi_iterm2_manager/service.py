from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shlex
import time
from contextlib import suppress
from datetime import datetime
from dataclasses import replace
from pathlib import Path
from typing import Any

from multi_iterm2_manager.analyzer import analyze_screen_text, analyze_timeout_only, load_rules, RuleEngineConfig
from multi_iterm2_manager.backend.mock import MockTerminalBackend
from multi_iterm2_manager.config import Settings, save_ui_settings
from multi_iterm2_manager.display import (
    build_maximized_frame,
    get_all_screens,
    get_screen_by_display_id,
    get_screen_by_name,
    get_screen_index_from_coordinates,
    get_screen_name_from_coordinates,
    is_point_on_screen,
    suggest_monitor_grid,
)
from multi_iterm2_manager.models import CreateTerminalParams, GridLayoutParams, TerminalFrame, TerminalRecord, TerminalStatus, new_terminal_id
from multi_iterm2_manager.app_monitor import AppMonitorService
from multi_iterm2_manager.codex_statusline import parse_codex_statusline
from multi_iterm2_manager.program_detection import detect_terminal_program
from multi_iterm2_manager.summarizer import SUMMARY_MAX_CONCURRENCY, SummaryConfig, TerminalSummarizer

logger = logging.getLogger(__name__)


class DashboardService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.records: dict[str, TerminalRecord] = {}
        self.monitor_tasks: dict[str, asyncio.Task[None]] = {}
        self._subscribers: set[asyncio.Queue[dict]] = set()
        self._lock: asyncio.Lock | None = None
        self._last_snapshot_time: float = 0.0
        self.backend: Any = self._build_backend()
        self._watchdog_task: asyncio.Task[None] | None = None
        self._timeout_check_task: asyncio.Task[None] | None = None
        self._rule_config: RuleEngineConfig = load_rules(settings.rules_file)
        self.ui_settings = settings.ui_settings
        # 焦点抑制：记录因焦点而抑制了 idle→running 转换的终端 ID
        self._focus_suppressed: set[str] = set()
        self._focus_recheck_task: asyncio.Task[None] | None = None
        # 预热 psutil CPU 采样，避免首次调用返回 0.0
        try:
            import psutil
            psutil.cpu_percent()
        except ImportError:
            pass
        # App 监控服务
        self.app_monitor = AppMonitorService(broadcast_fn=self._broadcast)
        # hook done 延迟计时器（防抖）
        self._hook_done_timers: dict[str, asyncio.Task[None]] = {}
        # 摘要引擎
        self._summarizer: TerminalSummarizer | None = None
        if settings.summary_api_base and settings.summary_api_key:
            self._summarizer = TerminalSummarizer(SummaryConfig(
                api_base=settings.summary_api_base,
                api_key=settings.summary_api_key,
                model=settings.summary_model,
                interval_seconds=settings.summary_interval_seconds,
            ))
        self._summary_queue: asyncio.Queue[str] | None = None
        self._summary_task: asyncio.Task[None] | None = None
        self._summary_trigger_task: asyncio.Task[None] | None = None
        # 上次总结时的终端状态（用于检测状态变更），不需要序列化
        self._last_summary_status: dict[str, str] = {}
        # 新建终端的初始内容基线：内容未变化前不做首次摘要
        self._summary_skipped_initial_hash: dict[str, str] = {}
        # 新建/拆分终端默认暂停自动摘要，避免 shell prompt 初始重绘触发 LLM
        self._summary_suspended_terminal_ids: set[str] = set()
        self._missing_session_scan_counts: dict[str, int] = {}

    async def start(self) -> None:
        await self.backend.start()
        # 环境变量由 start.sh 设置，告诉新进程跳过启动清理
        if os.environ.get("MITERM_SAFE_RESTART") == "1":
            print("[service] 安全重启模式：跳过 iTerm2 终端清理", flush=True)
            # 启动完成后清理标志文件（旧进程 stop 已用完或不存在）
            self._remove_safe_restart_flag()
            # 自动接管所有孤儿终端（带管理标记但不在 records 中的 session）
            try:
                orphans = await self.scan_sessions()
                adopted_count = 0
                for orphan in orphans:
                    try:
                        await self.adopt_terminal(orphan["session_id"])
                        adopted_count += 1
                    except Exception as exc:
                        print(f"[service] 自动接管失败 session={orphan['session_id']}: {exc}", flush=True)
                if adopted_count > 0:
                    print(f"[service] 自动接管 {adopted_count} 个终端", flush=True)
            except Exception as exc:
                print(f"[service] 自动接管扫描失败: {exc}", flush=True)
        else:
            try:
                await asyncio.wait_for(self.backend.cleanup_managed_terminals(), timeout=6)
            except Exception:
                pass
            try:
                await asyncio.wait_for(self.backend.maybe_quit_app(), timeout=3)
            except Exception:
                pass
        self._watchdog_task = asyncio.create_task(self._watchdog_loop())
        self._timeout_check_task = asyncio.create_task(self._timeout_check_loop())
        self._focus_recheck_task = asyncio.create_task(self._focus_recheck_loop())
        # 启动焦点监控（后端支持时）
        if hasattr(self.backend, 'start_focus_monitor'):
            try:
                await self.backend.start_focus_monitor()
            except Exception as exc:
                print(f"[service] 焦点监控启动失败（不影响核心功能）: {exc}", flush=True)
        # 启动 App 监控服务
        await self.app_monitor.start()
        # 启动摘要循环（即使 summarizer 未配置也需要运行，以便设置 reason="no_api"）
        self._summary_work_queue()
        self._summary_task = asyncio.create_task(self._summary_loop())

    async def stop(self) -> None:
        # 停止 App 监控服务
        await self.app_monitor.stop()
        # 取消所有 hook done 延迟计时器
        for timer_task in self._hook_done_timers.values():
            timer_task.cancel()
        for timer_task in self._hook_done_timers.values():
            with suppress(asyncio.CancelledError):
                await timer_task
        self._hook_done_timers.clear()
        # 取消摘要任务
        if self._summary_task:
            self._summary_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._summary_task
            self._summary_task = None
        if self._summary_trigger_task:
            self._summary_trigger_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._summary_trigger_task
            self._summary_trigger_task = None
        if self._summarizer:
            await self._summarizer.close()
        if self._watchdog_task is not None:
            self._watchdog_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._watchdog_task
            self._watchdog_task = None
        if self._timeout_check_task is not None:
            self._timeout_check_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._timeout_check_task
            self._timeout_check_task = None
        if self._focus_recheck_task is not None:
            self._focus_recheck_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._focus_recheck_task
            self._focus_recheck_task = None
        # 停止后端焦点监控
        if hasattr(self.backend, 'stop_focus_monitor'):
            try:
                await self.backend.stop_focus_monitor()
            except Exception:
                pass

        # 反转默认行为：
        # - 只有 stop.sh 明确要求完整清理时（创建 full-cleanup 标志），才执行完整清理
        # - 其他所有退出场景（Dock 强制退出、SIGTERM 等），默认只取消管理标记，不关闭窗口
        full_cleanup = DashboardService._has_full_cleanup_flag()

        if full_cleanup:
            print("[service] 完整清理模式：关闭终端并退出 iTerm2", flush=True)
            try:
                await self.close_all_terminals()
            except Exception:
                pass
            try:
                await self.backend.cleanup_managed_terminals()
                await self.backend.maybe_quit_app()
            except Exception:
                pass
        else:
            print("[service] 安全退出模式：仅取消管理标记，保留窗口", flush=True)
            try:
                await self.backend.unmark_all_managed()
            except Exception:
                pass

        for task in self.monitor_tasks.values():
            task.cancel()
        for task in self.monitor_tasks.values():
            with suppress(asyncio.CancelledError):
                await task
        self.monitor_tasks.clear()
        await self.backend.stop()

    @staticmethod
    def _safe_restart_flag_path() -> Path:
        return Path(__file__).resolve().parent.parent.parent / ".run" / "safe-restart"

    @staticmethod
    def _has_safe_restart_flag() -> bool:
        """只读检查标志文件是否存在（不删除）"""
        return DashboardService._safe_restart_flag_path().is_file()

    @staticmethod
    def _remove_safe_restart_flag() -> None:
        """清理标志文件"""
        try:
            DashboardService._safe_restart_flag_path().unlink(missing_ok=True)
        except Exception:
            pass

    @staticmethod
    def _full_cleanup_flag_path() -> Path:
        return Path(__file__).resolve().parent.parent.parent / ".run" / "full-cleanup"

    @staticmethod
    def _has_full_cleanup_flag() -> bool:
        """检查是否需要完整清理（由 stop.sh 创建）"""
        path = DashboardService._full_cleanup_flag_path()
        if path.is_file():
            path.unlink(missing_ok=True)  # 一次性标志，用后即删
            return True
        return False

    def static_dir(self) -> Path:
        return Path(__file__).with_name("static")

    def _records_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _summary_work_queue(self) -> asyncio.Queue[str]:
        if self._summary_queue is None:
            self._summary_queue = asyncio.Queue()
        return self._summary_queue

    def trigger_all_summaries(self) -> int:
        """后台强制重跑所有可摘要终端，统一并发上限。"""
        terminal_ids = [
            terminal_id
            for terminal_id, record in self.records.items()
            if record.status != TerminalStatus.closed and record.screen_text.strip()
        ]
        if not terminal_ids:
            return 0
        if self._summary_trigger_task and not self._summary_trigger_task.done():
            self._summary_trigger_task.cancel()
        self._summary_trigger_task = asyncio.create_task(self._run_forced_summaries(terminal_ids))
        return len(terminal_ids)

    async def _run_forced_summaries(self, terminal_ids: list[str]) -> None:
        semaphore = asyncio.Semaphore(SUMMARY_MAX_CONCURRENCY)

        async def run_one(terminal_id: str) -> None:
            async with semaphore:
                await self._generate_summary(terminal_id, force=True)

        await asyncio.gather(*(run_one(terminal_id) for terminal_id in terminal_ids))

    async def subscribe(self) -> asyncio.Queue[dict]:
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        await queue.put(self.snapshot_event())
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict]) -> None:
        self._subscribers.discard(queue)

    def list_terminals(self) -> list[dict]:
        return [record.to_dict() for record in self.records.values()]

    def list_active_terminals(self) -> list[dict]:
        return [record.to_dict() for record in self.records.values() if record.status != TerminalStatus.closed]

    def monitor_layout(self) -> dict:
        count = len([record for record in self.records.values() if record.status != TerminalStatus.closed])
        columns, rows = suggest_monitor_grid(count)
        return {"count": count, "columns": columns, "rows": rows}

    def ui_settings_payload(self) -> dict:
        return {
            "file": str(Path(self.settings.ui_settings_file)),
            "settings": self.ui_settings.to_dict(),
        }

    async def update_ui_settings(self, updates: dict[str, Any]) -> dict:
        self.ui_settings = replace(self.ui_settings, **updates)
        self.settings.ui_settings = self.ui_settings
        saved_path = save_ui_settings(self.settings.ui_settings_file, self.ui_settings)
        payload = {
            "type": "ui-settings-updated",
            "file": str(saved_path),
            "settings": self.ui_settings.to_dict(),
        }
        await self._broadcast(payload)
        return payload

    def _next_default_name(self) -> str:
        existing = {record.name.strip().lower() for record in self.records.values() if record.name}
        index = 1
        while True:
            candidate = f"终端 {index}"
            if candidate.lower() not in existing:
                return candidate
            index += 1

    async def health_status(self) -> dict:
        return {
            "ok": True,
            "backend": self.settings.backend,
            "terminals": len(self.records),
            "itermReady": await self.backend.ping(),
        }

    def system_stats(self) -> dict:
        """获取系统资源使用率（CPU、内存、磁盘）"""
        try:
            import psutil
            cpu = psutil.cpu_percent(interval=None)
            mem = psutil.virtual_memory().percent
            disk_usage = psutil.disk_usage('/')
            return {
                "cpu_percent": cpu,
                "memory_percent": mem,
                "disk_percent": disk_usage.percent,
                "disk_free_gb": round(disk_usage.free / (1024 ** 3), 1),
                "disk_total_gb": round(disk_usage.total / (1024 ** 3), 1),
            }
        except ImportError:
            # psutil 不可用时使用系统命令作为 fallback
            return self._system_stats_fallback()

    @staticmethod
    def _system_stats_fallback() -> dict:
        """psutil 不可用时通过系统命令获取资源使用率"""
        import subprocess
        stats: dict[str, float] = {"cpu_percent": 0.0, "memory_percent": 0.0, "disk_percent": 0.0, "disk_free_gb": 0.0, "disk_total_gb": 0.0}
        try:
            # macOS: 通过 top 获取 CPU 空闲率
            out = subprocess.check_output(
                ["top", "-l", "1", "-n", "0", "-s", "0"], text=True, timeout=5
            )
            for line in out.splitlines():
                if "CPU usage" in line:
                    # 格式: CPU usage: 3.33% user, 5.55% sys, 91.11% idle
                    parts = line.split(",")
                    for part in parts:
                        if "idle" in part:
                            idle = float(part.strip().split("%")[0])
                            stats["cpu_percent"] = round(100.0 - idle, 1)
                            break
                    break
        except Exception:
            pass
        try:
            # macOS: 通过 vm_stat 获取内存使用率
            import os
            out = subprocess.check_output(["vm_stat"], text=True, timeout=5)
            page_size = os.sysconf("SC_PAGE_SIZE")
            pages: dict[str, int] = {}
            for line in out.splitlines():
                if ":" in line:
                    key, val = line.split(":", 1)
                    val = val.strip().rstrip(".")
                    if val.isdigit():
                        pages[key.strip()] = int(val)
            free = pages.get("Pages free", 0)
            active = pages.get("Pages active", 0)
            inactive = pages.get("Pages inactive", 0)
            speculative = pages.get("Pages speculative", 0)
            wired = pages.get("Pages wired down", 0)
            total = free + active + inactive + speculative + wired
            if total > 0:
                used = active + wired
                stats["memory_percent"] = round(used / total * 100, 1)
        except Exception:
            pass
        try:
            # 通过 df 获取磁盘使用率和剩余空间
            # 使用 -k (1K blocks) 避免 -h 的单位解析问题
            out = subprocess.check_output(["df", "-k", "/"], text=True, timeout=5)
            lines = out.strip().splitlines()
            if len(lines) >= 2:
                # 格式: Filesystem 1024-blocks Used Available Capacity ...
                parts = lines[1].split()
                if len(parts) >= 5:
                    total_kb = int(parts[1])
                    avail_kb = int(parts[3])
                    cap_str = parts[4]  # e.g. "28%"
                    stats["disk_total_gb"] = round(total_kb / (1024 * 1024), 1)
                    stats["disk_free_gb"] = round(avail_kb / (1024 * 1024), 1)
                    if cap_str.endswith("%"):
                        stats["disk_percent"] = float(cap_str.rstrip("%"))
        except Exception:
            pass
        return stats

    def get_screens(self) -> list[dict]:
        """获取所有可用屏幕信息"""
        return get_all_screens()

    def get_target_screen(self) -> int:
        """获取当前配置的目标屏幕索引"""
        target_index, _, _ = self.get_target_screen_info()
        return target_index

    def set_target_screen(self, screen_index: int) -> None:
        """设置目标屏幕索引，-1 表示不指定，并持久化到配置文件"""
        screens = self.get_screens()
        target_screen_id = None
        target_screen_name = None
        if 0 <= screen_index < len(screens):
            target_screen = screens[screen_index]
            target_screen_id = target_screen.get("displayId")
            target_screen_name = target_screen.get("name")

        self.ui_settings = replace(
            self.ui_settings,
            target_screen=screen_index,
            target_screen_id=target_screen_id,
            target_screen_name=target_screen_name,
        )
        self.settings.ui_settings = self.ui_settings
        save_ui_settings(self.settings.ui_settings_file, self.ui_settings)

    def get_target_screen_info(self) -> tuple[int, str | None, dict | None]:
        """解析当前目标屏幕，优先使用稳定的 displayId。"""
        screens = self.get_screens()

        target_screen_id = self.ui_settings.target_screen_id
        if target_screen_id is not None:
            screen = get_screen_by_display_id(target_screen_id, screens)
            if screen is not None:
                return screen["index"], screen.get("name"), screen

        target_screen_name = self.ui_settings.target_screen_name
        if target_screen_name:
            screen = get_screen_by_name(target_screen_name, screens)
            if screen is not None:
                return screen["index"], screen.get("name"), screen

        target_index = self.ui_settings.target_screen
        if 0 <= target_index < len(screens):
            screen = screens[target_index]
            return target_index, screen.get("name"), screen

        return -1, None, None

    def _resolve_preferred_screen(
        self,
        browser_x: float | None = None,
        browser_y: float | None = None,
    ) -> tuple[int, str | None]:
        """解析当前应优先使用的屏幕。

        规则：
        1. 用户显式设置了 `target_screen` 时，始终优先该屏幕。
        2. 仅当未设置目标屏幕时，才回退到浏览器坐标推断。
        """
        target_index, target_name, _ = self.get_target_screen_info()
        if target_index >= 0:
            return target_index, target_name

        if browser_x is not None and browser_y is not None:
            screen_index = get_screen_index_from_coordinates(browser_x, browser_y)
            screen_name = get_screen_name_from_coordinates(browser_x, browser_y)
            return screen_index, screen_name

        return -1, None

    async def create_terminal(self, params: CreateTerminalParams) -> dict:
        final_name = (params.name or '').strip() or self._next_default_name()

        screen_index, screen_name = self._resolve_preferred_screen(
            browser_x=params.browser_x,
            browser_y=params.browser_y,
        )

        # 优先级：1. 显式传入的 frame > 2. 默认窗口模板（按屏幕名称） > 3. build_maximized_frame
        target_frame = params.frame
        if target_frame is None:
            default_frame = self.get_default_frame(screen_name)
            if default_frame is not None:
                target_frame = TerminalFrame(**default_frame)

        if target_frame is None and screen_index >= 0:
            target_frame = build_maximized_frame(screen_index=screen_index)
        handle = await self.backend.create_terminal(CreateTerminalParams(name=final_name, command=params.command, profile=params.profile, frame=target_frame))
        frame = await self.backend.get_frame(handle)
        record = TerminalRecord(
            id=new_terminal_id(),
            name=final_name,
            handle=handle,
            command=params.command,
            profile=params.profile,
            frame=frame,
        )
        # 将终端 ID 写回 iTerm2 session 变量，跨重启持久化
        try:
            await self.backend.set_terminal_id(handle, record.id)
        except Exception:
            pass
        async with self._records_lock():
            self.records[record.id] = record
        # 对齐窗口大小到其他可见终端
        await self._align_frame_to_siblings(record)
        await self.refresh_terminal(record.id, queue_summary=False)
        self._skip_initial_summary_until_content_changes(record)
        self._start_monitor(record.id)
        await self.enter_monitor_mode()
        await self._broadcast(self.record_event(record.id))
        return record.to_dict()

    async def split_terminal(self, terminal_id: str, direction: str) -> dict:
        source_record = self._get_record(terminal_id)
        if source_record.status == TerminalStatus.closed:
            raise ValueError("终端已关闭，无法拆分")
        if direction not in {"vertical", "horizontal"}:
            raise ValueError(f"不支持的拆分方向: {direction}")

        source_cwd = source_record.cwd or await self.backend.get_cwd(source_record.handle)
        if source_cwd is not None:
            source_record.cwd = source_cwd

        final_name = self._next_default_name()
        handle = await self.backend.create_terminal(
            CreateTerminalParams(
                name=final_name,
                profile=source_record.profile,
                cwd=source_cwd,
            ),
        )
        frame = await self.backend.get_frame(handle)
        record = TerminalRecord(
            id=new_terminal_id(),
            name=final_name,
            handle=handle,
            profile=source_record.profile,
            frame=frame,
        )
        try:
            await self.backend.set_terminal_id(handle, record.id)
        except Exception:
            pass
        async with self._records_lock():
            self.records[record.id] = record

        last_refresh_error: Exception | None = None
        for attempt in range(3):
            try:
                await self.refresh_terminal(record.id, queue_summary=False)
                last_refresh_error = None
                break
            except Exception as exc:
                last_refresh_error = exc
                await asyncio.sleep(0.12 * (attempt + 1))
        if last_refresh_error is not None:
            raise last_refresh_error

        # create_terminal 未必能在所有终端配置下直接继承 cwd，必要时补发一次 cd 兜底。
        if source_cwd and record.cwd != source_cwd:
            await self.backend.send_text(handle, f"cd {shlex.quote(source_cwd)}\n")
            await asyncio.sleep(0.05)
            await self.refresh_terminal(record.id, queue_summary=False)

        self._skip_initial_summary_until_content_changes(record)

        self._start_monitor(record.id)
        await self.enter_monitor_mode()
        await self._broadcast(self.record_event(record.id))
        return record.to_dict()

    async def create_demo_terminals(self, count: int = 4) -> list[dict]:
        count = max(1, count)
        created: list[dict] = []
        for index in range(count):
            created.append(
                await self.create_terminal(
                    CreateTerminalParams(
                        name=f"终端 {index + 1}",
                        command="/bin/zsh -l",
                    )
                )
            )
        return created

    async def _move_to_target_screen(self, record: TerminalRecord) -> None:
        """如果设置了目标屏幕，确保窗口在目标屏幕上"""
        target_index, _, _ = self.get_target_screen_info()
        if target_index >= 0:
            from multi_iterm2_manager.display import get_screen_bounds
            bounds = get_screen_bounds(target_index)
            if bounds is not None:
                current_frame = await self.backend.get_frame(record.handle)
                if current_frame is not None:
                    # 检查窗口是否已经在目标屏幕范围内
                    in_screen = (bounds.x <= current_frame.x < bounds.x + bounds.width
                                 and bounds.y <= current_frame.y < bounds.y + bounds.height)
                    if not in_screen:
                        # 保持窗口大小，移动到目标屏幕中心区域
                        new_frame = TerminalFrame(
                            x=round(bounds.x + 18.0, 2),
                            y=round(bounds.y + 18.0, 2),
                            width=current_frame.width,
                            height=current_frame.height,
                        )
                        await self.backend.set_frame(record.handle, new_frame)
                        record.frame = new_frame

    @staticmethod
    def _frames_match(left: TerminalFrame, right: TerminalFrame, *, tolerance: float = 1.0) -> bool:
        return (
            abs(left.x - right.x) <= tolerance
            and abs(left.y - right.y) <= tolerance
            and abs(left.width - right.width) <= tolerance
            and abs(left.height - right.height) <= tolerance
        )

    def _build_screen_target_frame(
        self,
        screen_name: str | None,
        bounds,
        current_frame: TerminalFrame,
    ) -> tuple[TerminalFrame, bool]:
        default_frame = self.get_default_frame(screen_name)
        if default_frame is not None:
            return TerminalFrame(**default_frame), True
        return TerminalFrame(
            x=round(bounds.x + 18.0, 2),
            y=round(bounds.y + 18.0, 2),
            width=current_frame.width,
            height=current_frame.height,
        ), False

    async def focus_terminal(self, terminal_id: str, browser_x: float | None = None, browser_y: float | None = None) -> dict:
        record = self._get_record(terminal_id)
        try:
            await self.backend.focus(record.handle)
            self._resume_auto_summary_after_user_activation(record)
            screen_index, screen_name = self._resolve_preferred_screen(
                browser_x=browser_x,
                browser_y=browser_y,
            )
            if screen_index >= 0:
                from multi_iterm2_manager.display import get_screen_bounds
                bounds = get_screen_bounds(screen_index)
                if bounds is not None:
                    current_frame = await self.backend.get_frame(record.handle)
                    if current_frame is not None:
                        target_frame, has_default_frame = self._build_screen_target_frame(
                            screen_name,
                            bounds,
                            current_frame,
                        )
                        in_screen = (bounds.x <= current_frame.x < bounds.x + bounds.width
                                     and bounds.y <= current_frame.y < bounds.y + bounds.height)
                        should_move = not in_screen or (
                            has_default_frame and not self._frames_match(current_frame, target_frame)
                        )
                        if should_move:
                            await self.backend.set_frame(record.handle, target_frame)
                            record.frame = target_frame
                    # 让其他可见终端也跟随移动到同一屏幕
                    await self._move_siblings_to_screen(record, screen_name, bounds)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def rename_terminal(self, terminal_id: str, name: str) -> dict:
        record = self._get_record(terminal_id)
        clean_name = name.strip()
        if not clean_name:
            raise ValueError("名称不能为空")
        if len(clean_name) > 60:
            raise ValueError("名称不能超过 60 个字符")

        for other in self.records.values():
            if other.id == record.id:
                continue
            if other.status == TerminalStatus.closed:
                continue
            if other.name.strip().lower() == clean_name.lower():
                raise ValueError(f"名称已存在：{clean_name}")

        await self.backend.rename(record.handle, clean_name)
        record.name = clean_name
        record.updated_at = self._now()
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def set_hidden(self, terminal_id: str, hidden: bool) -> dict:
        record = self._get_record(terminal_id)
        record.hidden = hidden
        await self.backend.set_hidden(record.handle, hidden)
        # 取消隐藏时，将窗口大小对齐到其他可见终端
        if not hidden:
            await self._align_frame_to_siblings(record)
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def set_tags(self, terminal_id: str, tags: list[str]) -> dict:
        """设置终端标签（最多10个标签，每标签最长20字符，不含逗号）"""
        record = self._get_record(terminal_id)
        # 验证标签
        if len(tags) > 10:
            raise ValueError("最多设置 10 个标签")
        for tag in tags:
            if not tag or not tag.strip():
                raise ValueError("标签不能为空")
            if len(tag) > 20:
                raise ValueError(f"标签长度不能超过 20 个字符：{tag}")
            if "," in tag:
                raise ValueError(f"标签不能包含逗号：{tag}")
        # 去重并保持顺序
        seen: set[str] = set()
        clean_tags: list[str] = []
        for tag in tags:
            t = tag.strip()
            if t not in seen:
                seen.add(t)
                clean_tags.append(t)
        record.tags = clean_tags
        record.updated_at = self._now()
        await self.backend.set_tags(record.handle, clean_tags)
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def set_muted(self, terminal_id: str, muted: bool) -> dict:
        """设置终端静默状态，同步到 iTerm2 session 变量"""
        record = self._get_record(terminal_id)
        record.muted = muted
        record.updated_at = self._now()
        await self.backend.set_muted(record.handle, muted)
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def set_primary(self, terminal_id: str, primary: bool) -> dict:
        """设置当前唯一的最重要任务。"""
        record = self._get_record(terminal_id)
        if record.status == TerminalStatus.closed:
            raise ValueError("终端已关闭，无法设置最重要任务")

        if primary:
            changed = await self._set_primary_terminal(record.id)
        else:
            if not record.is_primary:
                return record.to_dict()
            changed = await self._set_primary_terminal(None)

        if changed:
            await self._broadcast(self.snapshot_event())
        return self._get_record(terminal_id).to_dict()

    async def _set_primary_terminal(self, target_id: str | None) -> list[str]:
        changed_ids: list[str] = []
        now = self._now()
        for current in self.records.values():
            next_is_primary = current.id == target_id
            if current.is_primary == next_is_primary:
                continue
            current.is_primary = next_is_primary
            current.updated_at = now
            changed_ids.append(current.id)
            try:
                await self.backend.set_primary(current.handle, next_is_primary)
            except Exception:
                # 持久化失败不阻塞主流程；内存态仍以后端广播为准
                pass
        return changed_ids

    def list_all_tags(self) -> list[str]:
        """遍历所有非关闭终端，收集去重排序的标签列表"""
        all_tags: set[str] = set()
        for record in self.records.values():
            if record.status != TerminalStatus.closed:
                all_tags.update(record.tags)
        return sorted(all_tags)

    async def _move_siblings_to_screen(self, source_record: TerminalRecord, screen_name: str | None, bounds) -> None:
        """将其他可见终端移动到与源终端相同的屏幕，并优先对齐到默认模板。"""
        for sibling in self.records.values():
            if sibling.id == source_record.id:
                continue
            if sibling.status == TerminalStatus.closed or sibling.hidden:
                continue
            try:
                current_frame = await self.backend.get_frame(sibling.handle)
                if current_frame is not None:
                    target_frame, has_default_frame = self._build_screen_target_frame(
                        screen_name,
                        bounds,
                        current_frame,
                    )
                    in_screen = (bounds.x <= current_frame.x < bounds.x + bounds.width
                                 and bounds.y <= current_frame.y < bounds.y + bounds.height)
                    should_move = not in_screen or (
                        has_default_frame and not self._frames_match(current_frame, target_frame)
                    )
                    if should_move:
                        await self.backend.set_frame(sibling.handle, target_frame)
                        sibling.frame = target_frame
            except Exception:
                pass

    async def _align_frame_to_siblings(self, record: TerminalRecord) -> None:
        """将窗口大小对齐到其他可见终端（取第一个非隐藏、非关闭终端的 frame）"""
        target_index, target_screen_name = self._resolve_preferred_screen()
        target_screen = None
        if target_index >= 0:
            _, _, target_screen = self.get_target_screen_info()

        # 对齐到兄弟终端的 frame
        for sibling in self.records.values():
            if sibling.id == record.id:
                continue
            if sibling.status == TerminalStatus.closed or sibling.hidden:
                continue
            if sibling.frame is not None:
                if target_screen is not None and not is_point_on_screen(target_screen, sibling.frame.x, sibling.frame.y):
                    continue
                target = TerminalFrame(
                    x=sibling.frame.x,
                    y=sibling.frame.y,
                    width=sibling.frame.width,
                    height=sibling.frame.height,
                )
                try:
                    await self.backend.set_frame(record.handle, target)
                    record.frame = target
                except Exception:
                    pass
                return

        if target_screen is not None:
            if record.frame is not None and is_point_on_screen(target_screen, record.frame.x, record.frame.y):
                return

            default_frame = self.get_default_frame(target_screen_name)
            target = TerminalFrame(**default_frame) if default_frame is not None else build_maximized_frame(screen_index=target_index)
            try:
                await self.backend.set_frame(record.handle, target)
                record.frame = target
            except Exception:
                pass

    async def enter_monitor_mode(self) -> dict:
        await self.backend.hide_app()
        payload = {"type": "workspace-mode", "mode": "monitor", "layout": self.monitor_layout()}
        await self._broadcast(payload)
        return payload

    async def close_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        if record.status != TerminalStatus.closed:
            try:
                await self.backend.close(record.handle)
            except Exception:
                pass
        return await self._mark_terminal_closed(record)

    async def detach_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        if record.status == TerminalStatus.closed:
            raise ValueError("终端已关闭，无法解绑")
        if record.is_primary:
            try:
                await self.backend.set_primary(record.handle, False)
            except Exception:
                pass
        await self.backend.detach(record.handle)
        task = self.monitor_tasks.pop(record.id, None)
        if task is not None:
            task.cancel()
        async with self._records_lock():
            del self.records[record.id]
        await self._broadcast(self.snapshot_event())
        return {"detached": True, "terminalId": terminal_id}

    async def scan_sessions(self) -> list[dict]:
        # 将当前已知的 session IDs 传给后端，使其能识别"孤儿托管"终端
        # 孤儿托管 = 有 mitm_managed 标记，但服务重启后 records 已清空的旧终端
        known_ids = {r.handle.session_id for r in self.records.values()}
        return await self.backend.scan_unmanaged_sessions(known_session_ids=known_ids)

    async def adopt_all_terminals(self) -> dict:
        sessions = await self.scan_sessions()
        adopted: list[dict] = []
        errors: list[dict] = []

        for session in sessions:
            session_id = session.get("session_id")
            if not session_id:
                errors.append({"sessionId": "", "name": session.get("name", ""), "error": "缺少 session_id"})
                continue
            try:
                adopted.append(await self.adopt_terminal(session_id))
            except Exception as exc:
                errors.append({
                    "sessionId": session_id,
                    "name": session.get("name", session_id),
                    "error": str(exc),
                })

        await self._broadcast(self.snapshot_event())
        return {
            "scanned": len(sessions),
            "adopted": len(adopted),
            "errors": errors,
            "items": self.list_terminals(),
            "layout": self.monitor_layout(),
            "allTags": self.list_all_tags(),
        }

    async def adopt_terminal(self, session_id: str, name: str | None = None) -> dict:
        explicit_name = (name or '').strip() if name else None
        handle = await self.backend.adopt(session_id, explicit_name)
        restored_managed_terminal = handle.adopted_id is not None
        # 优先使用显式传入的名字，其次使用从 iTerm2 读取的原始名字，最后回退到默认名
        final_name = explicit_name or (handle.adopted_name or '').strip() or self._next_default_name()
        # 把最终名字写回 iTerm2 自定义变量，确保下次重启/接管时不会丢失
        await self.backend.rename(handle, final_name)
        frame = await self.backend.get_frame(handle)
        # 复用持久化的终端 ID（跨重启稳定），若已存在则回退到新 ID
        terminal_id = handle.adopted_id if (handle.adopted_id and handle.adopted_id not in self.records) else new_terminal_id()
        record = TerminalRecord(
            id=terminal_id,
            name=final_name,
            handle=handle,
            frame=frame,
            hidden=handle.adopted_hidden,
            muted=handle.adopted_muted,
            tags=handle.adopted_tags,
            is_primary=handle.adopted_primary,
        )
        # 将最终 ID 写回 iTerm2 session 变量，确保下次重启可复用
        try:
            await self.backend.set_terminal_id(handle, record.id)
        except Exception:
            pass
        async with self._records_lock():
            self.records[record.id] = record
        if record.is_primary:
            await self._set_primary_terminal(record.id)
        # 仅对首次接管的外部终端做兄弟窗口对齐；安全重启恢复的托管终端保留原布局。
        if not record.hidden and not restored_managed_terminal:
            await self._align_frame_to_siblings(record)
        await self.refresh_terminal(record.id)
        self._start_monitor(record.id)
        await self.enter_monitor_mode()
        if record.is_primary:
            await self._broadcast(self.snapshot_event())
        else:
            await self._broadcast(self.record_event(record.id))
        return record.to_dict()

    async def close_all_terminals(self) -> list[dict]:
        target_ids = [record.id for record in self.records.values() if record.status != TerminalStatus.closed]
        result: list[dict] = []
        for terminal_id in target_ids:
            result.append(await self.close_terminal(terminal_id))
        # 清理所有已关闭的记录，避免状态残留
        closed_ids = [rid for rid, rec in self.records.items() if rec.status == TerminalStatus.closed]
        async with self._records_lock():
            for rid in closed_ids:
                self.records.pop(rid, None)
        # 广播 snapshot 确保前端拿到一致状态
        await self._broadcast(self.snapshot_event())
        return result

    async def refresh_terminal(self, terminal_id: str, *, queue_summary: bool = True) -> dict:
        record = self._get_record(terminal_id)
        try:
            text, screen_html = await self.backend.get_screen_render(record.handle)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        self._apply_screen_text(record, text, screen_html, is_live=False, queue_summary=queue_summary)
        # 获取当前工作目录
        cwd = await self.backend.get_cwd(record.handle)
        if cwd is not None:
            record.cwd = cwd
        await self._refresh_runtime_metadata(record)
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    def _skip_initial_summary_until_content_changes(self, record: TerminalRecord) -> None:
        record.ai_summary_first = False
        record.ai_summary_status = "none"
        record.ai_summary_reason = "idle"
        record.ai_summary_error_detail = ""
        self._last_summary_status[record.id] = record.status.value
        self._summary_skipped_initial_hash[record.id] = record.content_hash
        self._summary_suspended_terminal_ids.add(record.id)

    def _resume_auto_summary_for_terminal(self, record: TerminalRecord) -> None:
        self._summary_suspended_terminal_ids.discard(record.id)
        self._summary_skipped_initial_hash.pop(record.id, None)

    def _resume_auto_summary_after_user_activation(self, record: TerminalRecord) -> None:
        was_suspended = (
            record.id in self._summary_suspended_terminal_ids
            or record.id in self._summary_skipped_initial_hash
        )
        self._resume_auto_summary_for_terminal(record)
        if was_suspended and self._summarizer and record.screen_text.strip():
            self._summary_work_queue().put_nowait(record.id)

    async def send_text(self, terminal_id: str, text: str) -> dict:
        record = self._get_record(terminal_id)
        payload = text if text.endswith("\n") or text.endswith("\r") else f"{text}\n"
        self._resume_auto_summary_for_terminal(record)
        try:
            await self.backend.send_text(record.handle, payload)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        await asyncio.sleep(0.1)
        return await self.refresh_terminal(terminal_id)

    async def get_live_frame(self, terminal_id: str) -> dict:
        """实时从 iTerm2 获取终端窗口的当前位置和大小"""
        record = self._get_record(terminal_id)
        try:
            frame = await self.backend.get_frame(record.handle)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        if frame is None:
            raise ValueError("无法获取窗口坐标")
        record.frame = frame
        return frame.to_dict()

    async def set_frame(self, terminal_id: str, frame: TerminalFrame) -> dict:
        record = self._get_record(terminal_id)
        try:
            await self.backend.set_frame(record.handle, frame)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        record.frame = frame
        record.updated_at = self._now()
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    # ============ 默认窗口位置模板 ============

    def get_default_frame(self, screen_name: str | None = None) -> dict | None:
        """获取默认窗口模板，若未设置返回 None

        Args:
            screen_name: 屏幕名称，若提供则查找该屏幕对应的默认位置
        """
        frames_map = self.ui_settings.default_frames_by_screen
        if not frames_map or not isinstance(frames_map, dict):
            return None
        if screen_name and screen_name in frames_map:
            return frames_map[screen_name]
        if screen_name:
            target_screen = get_screen_by_name(screen_name, self.get_screens())
            if target_screen is not None:
                for frame_data in frames_map.values():
                    if not isinstance(frame_data, dict):
                        continue
                    x = frame_data.get("x")
                    y = frame_data.get("y", 0)
                    if x is None:
                        continue
                    if is_point_on_screen(target_screen, x, y):
                        return frame_data
        return None

    async def set_default_frame(self, frame: TerminalFrame, screen_name: str) -> dict:
        """设置指定屏幕的默认窗口模板并持久化"""
        frames_map = dict(self.ui_settings.default_frames_by_screen or {})
        frames_map[screen_name] = {"x": frame.x, "y": frame.y, "width": frame.width, "height": frame.height}

        self.ui_settings = replace(
            self.ui_settings,
            default_frames_by_screen=frames_map,
        )
        self.settings.ui_settings = self.ui_settings
        save_ui_settings(self.settings.ui_settings_file, self.ui_settings)

        payload = {
            "type": "default-frame-updated",
            "screenName": screen_name,
            "defaultFrame": frame.to_dict(),
        }
        await self._broadcast(payload)
        return payload

    async def apply_default_frame_to_all(self) -> dict:
        """根据每个终端所在的屏幕，应用对应的默认位置"""
        frames_map = self.ui_settings.default_frames_by_screen
        if not frames_map:
            raise ValueError("尚未设置任何屏幕的默认窗口模板")

        applied = 0
        skipped = 0
        errors = []

        for record in self.records.values():
            if record.status == TerminalStatus.closed or record.hidden:
                continue
            try:
                current_frame = await self.backend.get_frame(record.handle)
                if current_frame is None:
                    skipped += 1
                    continue
                # 通过终端当前坐标确定所在屏幕名称
                screen_name = get_screen_name_from_coordinates(current_frame.x, current_frame.y)
                if not screen_name or screen_name not in frames_map:
                    skipped += 1
                    continue
                frame_data = frames_map[screen_name]
                frame = TerminalFrame(**frame_data)
                await self.backend.set_frame(record.handle, frame)
                record.frame = frame
                applied += 1
            except Exception as e:
                errors.append({"terminalId": record.id, "error": str(e)})

        await self._broadcast(self.snapshot_event())
        return {"applied": applied, "skipped": skipped, "errors": errors}

    async def apply_grid_layout(self, params: GridLayoutParams) -> dict:
        columns = max(1, params.columns)
        rows = max(1, params.rows)
        payload = {
            "type": "monitor-layout",
            "layout": {
                "count": len([record for record in self.records.values() if record.status != TerminalStatus.closed]),
                "columns": columns,
                "rows": rows,
            },
        }
        await self._broadcast(payload)
        return payload

    def snapshot_event(self) -> dict:
        return {
            "type": "snapshot",
            "terminals": self.list_terminals(),
            "layout": self.monitor_layout(),
            "allTags": self.list_all_tags(),
            "appMonitors": self.app_monitor.list_monitors(),
        }

    def record_event(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        return {
            "type": "terminal-updated",
            "terminal": record.to_dict(),
            "layout": self.monitor_layout(),
            "allTags": self.list_all_tags(),
        }

    async def _broadcast(self, payload: dict) -> None:
        dead: list[asyncio.Queue[dict]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                # 清空旧消息
                self._drain_queue(queue)
                # 节流：至少间隔 2 秒才补发 snapshot
                now = time.monotonic()
                if now - self._last_snapshot_time >= 2.0:
                    try:
                        queue.put_nowait(self.snapshot_event())
                        self._last_snapshot_time = now
                    except asyncio.QueueFull:
                        dead.append(queue)
                # 不足 2 秒则跳过 snapshot，队列已清空，后续正常消息会继续推送
        for queue in dead:
            self._subscribers.discard(queue)

    def _drain_queue(self, queue: asyncio.Queue[dict]) -> None:
        """清空队列中的所有旧消息"""
        while not queue.empty():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    def _start_monitor(self, terminal_id: str) -> None:
        task = asyncio.create_task(self._monitor_terminal(terminal_id))
        self.monitor_tasks[terminal_id] = task

    async def _monitor_terminal(self, terminal_id: str) -> None:
        record = self._get_record(terminal_id)
        last_broadcast_time: float = 0.0
        min_interval: float = 0.3  # 最小广播间隔 300ms
        pending_broadcast: asyncio.Task[None] | None = None
        try:
            async for text, screen_html in self.backend.stream_screen(record.handle):
                old_hash = record.content_hash
                old_status = record.status
                old_program = record.program
                self._apply_screen_text(record, text, screen_html, is_live=True)

                status_changed = record.status != old_status
                content_changed = record.content_hash != old_hash

                # 内容变化时才更新工作目录，避免无意义的 API 调用
                if content_changed:
                    cwd = await self.backend.get_cwd(record.handle)
                    if cwd is not None:
                        record.cwd = cwd
                    await self._refresh_runtime_metadata(record)

                program_changed = record.program != old_program

                # 状态或识别结果变了但内容没变，立即广播不限速
                if (status_changed or program_changed) and not content_changed:
                    if pending_broadcast is not None and not pending_broadcast.done():
                        pending_broadcast.cancel()
                        pending_broadcast = None
                    last_broadcast_time = time.time()
                    await self._broadcast(self.record_event(terminal_id))
                    continue

                # 内容、状态、识别结果都没变，跳过广播
                if not content_changed and not program_changed:
                    continue

                now = time.time()
                elapsed = now - last_broadcast_time

                if elapsed >= min_interval:
                    # 已超过最小间隔，立即广播
                    if pending_broadcast is not None and not pending_broadcast.done():
                        pending_broadcast.cancel()
                        pending_broadcast = None
                    last_broadcast_time = now
                    await self._broadcast(self.record_event(terminal_id))
                else:
                    # 未到间隔，设置兜底定时广播（始终用最新内容）
                    if pending_broadcast is not None and not pending_broadcast.done():
                        pending_broadcast.cancel()
                    delay = min_interval - elapsed

                    async def _deferred_broadcast(tid: str, d: float) -> None:
                        await asyncio.sleep(d)
                        nonlocal last_broadcast_time
                        last_broadcast_time = time.time()
                        await self._broadcast(self.record_event(tid))

                    pending_broadcast = asyncio.ensure_future(
                        _deferred_broadcast(terminal_id, delay)
                    )
        except asyncio.CancelledError:
            if pending_broadcast is not None and not pending_broadcast.done():
                pending_broadcast.cancel()
            raise
        except Exception as exc:
            if pending_broadcast is not None and not pending_broadcast.done():
                pending_broadcast.cancel()
            if self._is_missing_terminal_error(exc):
                await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
                return
            record.last_error = str(exc)
            if record.status != TerminalStatus.closed:
                record.status = TerminalStatus.error
                record.updated_at = self._now()
                record.is_live = False
                await self._broadcast(self.record_event(terminal_id))
        else:
            # 流正常结束（非异常、非取消），说明会话已消失
            if record.id in self.records and record.status != TerminalStatus.closed:
                await self._mark_terminal_closed(record, reason="终端会话已结束")

    async def _mark_terminal_closed(self, record: TerminalRecord, reason: str | None = None) -> dict:
        record.status = TerminalStatus.closed
        record.is_primary = False
        record.updated_at = self._now()
        record.is_live = False
        record.last_error = None
        if reason:
            record.summary = reason
        task = self.monitor_tasks.pop(record.id, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()
        await self._broadcast(self.record_event(record.id))
        await self.enter_monitor_mode()
        return record.to_dict()

    def _is_missing_terminal_error(self, exc: Exception) -> bool:
        message = str(exc).lower()
        patterns = [
            "找不到 window",
            "找不到 session",
            "window not found",
            "session not found",
            "no such window",
            "no such session",
            "session ended",
            "无法连接",
        ]
        return any(pattern in message for pattern in patterns)

    # 提示符守卫：常见 shell 提示符字符（$=bash, %=zsh, ❯=fancy, #=root）
    _PROMPT_CHAR_RE = re.compile(r'[$%❯#]\s')
    # 空闲态集合
    _IDLE_STATUSES = frozenset({TerminalStatus.done, TerminalStatus.idle, TerminalStatus.waiting})
    _ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
    _CODEX_WORKING_LINE_RE = re.compile(
        r"^\s*[│|]?\s*Working\s*\([^)]*esc\s+to\s+interrupt[^)]*\)\s*$",
        re.IGNORECASE,
    )
    _CODEX_CONTEXT_LINE_RE = re.compile(
        r"^\s*[│|]?\s*Context\s+\d+%\s+(?:used|left)\s*$",
        re.IGNORECASE,
    )
    _CODEX_MODEL_LINE_RE = re.compile(
        r"^\s*[│|]?\s*gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)?\s+(?:low|medium|high|xhigh)\s*$",
        re.IGNORECASE,
    )
    _AGENT_PROGRESS_LINE_RE = re.compile(
        r"^\s*[│|]?\s*(?:Thinking|Working|Reading|Editing|Searching|Running|Applying|Compacting)\b.*"
        r"(?:esc|ctrl|tokens?|context|interrupt|\d+s)\s*$",
        re.IGNORECASE,
    )

    def _apply_screen_text(
        self,
        record: TerminalRecord,
        text: str,
        screen_html: str,
        is_live: bool,
        *,
        queue_summary: bool = True,
    ) -> None:
        # 已关闭的终端不再更新状态
        if record.status == TerminalStatus.closed:
            return

        # 计算内容哈希，判断内容是否变化
        new_hash = hashlib.md5(text.encode()).hexdigest()
        if new_hash != record.content_hash:
            had_content_baseline = bool(record.content_hash)
            record.content_hash = new_hash
            record.content_stable_since = time.time()
            self._track_agent_interaction_change(
                record,
                text,
                had_content_baseline=had_content_baseline,
            )
            self._summary_skipped_initial_hash.pop(record.id, None)
            if queue_summary and self._summarizer:
                self._summary_work_queue().put_nowait(record.id)

        # 计算停滞时间
        stable_seconds = 0.0
        if record.content_stable_since > 0:
            stable_seconds = time.time() - record.content_stable_since

        old_status = record.status
        status, markers, summary = analyze_screen_text(text, stable_seconds, self._rule_config)

        # 状态变更时，立即触发摘要（如果还没有在队列中）
        status_changed = (status != old_status) and (old_status != TerminalStatus.closed)
        if queue_summary and status_changed and self._summarizer:
            try:
                self._summary_work_queue().put_nowait(record.id)
            except asyncio.QueueFull:
                pass

        # ── 状态守卫链（顺序不可调换）──
        # 1. 焦点守卫：终端有焦点时（用户正在交互），不要从空闲变为运行中
        #    等终端失焦后由 _focus_recheck_loop 重新评估
        if (old_status in self._IDLE_STATUSES
                and status == TerminalStatus.running
                and self._is_terminal_focused(record)):
            status = old_status
            self._focus_suppressed.add(record.id)

        # 2. 提示符守卫：空闲→运行中的转换需要额外验证
        #    用户在 shell 提示符打字时，只有最后一行变化且提示符仍可见
        if (old_status in self._IDLE_STATUSES
                and status == TerminalStatus.running
                and record.screen_text
                and self._is_likely_typing(record.screen_text, text)):
            status = old_status

        record.screen_text = text
        record.screen_html = screen_html
        record.status = status
        record.markers = markers
        record.summary = summary
        record.updated_at = self._now()
        record.is_live = is_live
        if record.status != TerminalStatus.error:
            record.last_error = None

    @classmethod
    def _is_likely_typing(cls, old_text: str, new_text: str) -> bool:
        """检测是否只是用户在提示符处打字（非命令执行）。

        同时满足两个条件才返回 True：
        1. 行数没有增加（没有新输出行）
        2. 最后一行仍包含 shell 提示符特征
        """
        old_lines = old_text.rstrip('\n').split('\n')
        new_lines = new_text.rstrip('\n').split('\n')
        # 新增了行 → 命令产生了输出
        if len(new_lines) > len(old_lines):
            return False
        # 最后一行是否仍有 shell 提示符
        last_line = new_lines[-1] if new_lines else ''
        return bool(cls._PROMPT_CHAR_RE.search(last_line))

    def _is_terminal_focused(self, record: TerminalRecord) -> bool:
        """检查终端是否当前有焦点（用户正在交互）"""
        if hasattr(self.backend, 'is_session_focused'):
            return self.backend.is_session_focused(record.handle.session_id)
        return False

    def _track_agent_interaction_change(
        self,
        record: TerminalRecord,
        text: str,
        *,
        had_content_baseline: bool,
    ) -> None:
        if not record.program.is_agent:
            return

        interaction_hash = self._agent_interaction_hash(text)
        if not interaction_hash:
            return

        if not record.interaction_content_hash:
            record.interaction_content_hash = interaction_hash
            if had_content_baseline:
                record.last_interaction_at = time.time()
            return

        if interaction_hash != record.interaction_content_hash:
            record.interaction_content_hash = interaction_hash
            record.last_interaction_at = time.time()

    def _sync_agent_interaction_baseline(self, record: TerminalRecord) -> None:
        if not record.program.is_agent:
            record.interaction_content_hash = ""
            return
        if record.interaction_content_hash:
            return
        record.interaction_content_hash = self._agent_interaction_hash(record.screen_text)

    def _agent_interaction_hash(self, text: str) -> str:
        interaction_text = self._agent_interaction_text(text)
        if not interaction_text:
            return ""
        return hashlib.md5(interaction_text.encode()).hexdigest()

    def _agent_interaction_text(self, text: str) -> str:
        lines: list[str] = []
        for raw_line in (text or "").splitlines():
            line = self._ANSI_RE.sub("", raw_line).strip()
            if not line or self._is_agent_status_noise_line(line):
                continue
            lines.append(line)
        return "\n".join(lines[-120:]).strip()

    def _is_agent_status_noise_line(self, line: str) -> bool:
        if parse_codex_statusline(line) is not None:
            return True
        return any(
            pattern.search(line)
            for pattern in (
                self._CODEX_WORKING_LINE_RE,
                self._CODEX_CONTEXT_LINE_RE,
                self._CODEX_MODEL_LINE_RE,
                self._AGENT_PROGRESS_LINE_RE,
            )
        )

    async def _focus_recheck_loop(self) -> None:
        """定期检查焦点抑制的终端，失焦后重新评估状态"""
        while True:
            await asyncio.sleep(1.5)
            if not self._focus_suppressed:
                continue
            for terminal_id in list(self._focus_suppressed):
                record = self.records.get(terminal_id)
                if record is None or record.status == TerminalStatus.closed:
                    self._focus_suppressed.discard(terminal_id)
                    continue
                if self._is_terminal_focused(record):
                    continue  # 仍然有焦点，继续抑制
                # 终端已失焦，重新评估状态
                self._focus_suppressed.discard(terminal_id)
                if not record.screen_text.strip():
                    continue
                # 使用 stable_seconds=0 避免超时规则误判：
                # 焦点抑制期间 content_stable_since 可能已经很久没更新，
                # 用真实 stable_seconds 会让超时规则以为内容停滞了很久而误判为 done。
                # 只用 content 类规则判断即可，超时规则留给 _timeout_check_loop 自然处理。
                new_status, markers, summary = analyze_screen_text(
                    record.screen_text, 0.0, self._rule_config
                )
                if new_status != record.status:
                    record.status = new_status
                    record.markers = markers
                    record.summary = summary
                    record.updated_at = self._now()
                    if new_status != TerminalStatus.error:
                        record.last_error = None
                    if record.id in self.records:
                        await self._broadcast(self.record_event(record.id))

    def _get_record(self, terminal_id: str) -> TerminalRecord:
        if terminal_id not in self.records:
            raise KeyError(f"未知终端: {terminal_id}")
        return self.records[terminal_id]

    def _build_backend(self):
        if self.settings.backend == "mock":
            return MockTerminalBackend()
        if self.settings.backend == "iterm2":
            from multi_iterm2_manager.backend.iterm2_backend import ITerm2Backend

            return ITerm2Backend()
        try:
            from multi_iterm2_manager.backend.iterm2_backend import ITerm2Backend

            return ITerm2Backend()
        except Exception:
            return MockTerminalBackend()

    async def _watchdog_loop(self) -> None:
        cleanup_counter = 0
        while True:
            await asyncio.sleep(5)
            alive = not hasattr(self.backend, 'is_alive') or self.backend.is_alive()
            print(f"[watchdog] iTerm2 alive={alive}, terminals={len(self.records)}", flush=True)
            # 每 30 秒清理一次已关闭的终端记录
            cleanup_counter += 1
            if cleanup_counter >= 6:
                cleanup_counter = 0
                closed_ids = [rid for rid, r in self.records.items() if r.status == TerminalStatus.closed]
                if closed_ids:
                    print(f"[watchdog] 清理 {len(closed_ids)} 个已关闭的终端记录", flush=True)
                    async with self._records_lock():
                        for rid in closed_ids:
                            self.records.pop(rid, None)
                    await self._broadcast(self.snapshot_event())
            if alive:
                await self._close_records_missing_from_session_scan()
                continue
            active = [r for r in self.records.values() if r.status != TerminalStatus.closed]
            if not active:
                continue
            print(f"[watchdog] iTerm2 已退出，关闭 {len(active)} 个终端", flush=True)
            for record in active:
                record.status = TerminalStatus.closed
                record.updated_at = self._now()
                record.is_live = False
                record.summary = "iTerm2 已退出"
                task = self.monitor_tasks.pop(record.id, None)
                if task is not None:
                    task.cancel()
            await self._broadcast(self.snapshot_event())

    async def _close_records_missing_from_session_scan(self) -> None:
        if not hasattr(self.backend, "list_session_ids"):
            return
        active = [r for r in self.records.values() if r.status != TerminalStatus.closed]
        if not active:
            self._missing_session_scan_counts.clear()
            return
        try:
            live_session_ids = set(await self.backend.list_session_ids())
        except Exception as exc:
            print(f"[watchdog] session 存活扫描失败: {exc}", flush=True)
            return

        active_ids = {record.id for record in active}
        for record_id in list(self._missing_session_scan_counts.keys()):
            if record_id not in active_ids:
                self._missing_session_scan_counts.pop(record_id, None)

        for record in active:
            if record.handle.session_id in live_session_ids:
                self._missing_session_scan_counts.pop(record.id, None)
                continue
            missed = self._missing_session_scan_counts.get(record.id, 0) + 1
            if missed < 2:
                self._missing_session_scan_counts[record.id] = missed
                continue
            print(f"[watchdog] session 已不存在，关闭终端记录: {record.id} ({record.handle.session_id})", flush=True)
            self._missing_session_scan_counts.pop(record.id, None)
            await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")

    async def _timeout_check_loop(self) -> None:
        """定时扫描所有活跃终端，只检查超时规则"""
        while True:
            await asyncio.sleep(10)
            for record in list(self.records.values()):
                if record.status == TerminalStatus.closed:
                    continue
                if not record.screen_text.strip():
                    continue
                # 计算停滞时间
                stable_seconds = 0.0
                if record.content_stable_since > 0:
                    stable_seconds = time.time() - record.content_stable_since
                result = analyze_timeout_only(
                    record.screen_text, stable_seconds, self._rule_config
                )
                if result is None:
                    continue
                new_status, markers, summary = result
                if new_status != record.status:
                    # 焦点守卫：终端有焦点时（用户正在交互），不要从空闲变为运行中
                    if (record.status in self._IDLE_STATUSES
                            and new_status == TerminalStatus.running
                            and self._is_terminal_focused(record)):
                        self._focus_suppressed.add(record.id)
                        continue
                    record.status = new_status
                    record.markers = markers
                    record.summary = summary
                    record.updated_at = self._now()
                    if new_status != TerminalStatus.error:
                        record.last_error = None
                    # 防止 record 在 await 期间被移除
                    if record.id in self.records:
                        await self._broadcast(self.record_event(record.id))

    def _now(self) -> str:
        return datetime.now().isoformat(timespec="seconds")

    async def _refresh_runtime_metadata(self, record: TerminalRecord) -> None:
        runtime_info = await self.backend.get_runtime_info(record.handle)
        record.program = detect_terminal_program(runtime_info, record.screen_text)
        self._sync_agent_interaction_baseline(record)

    async def update_hook_status(self, iterm_session_id: str, status: str) -> str | None:
        """根据 hook 通知更新终端状态。

        Args:
            iterm_session_id: 完整的 ITERM_SESSION_ID，格式 w2t0p0:GUID
            status: "running" 或 "done"

        Returns:
            匹配到的 terminal_id，未匹配返回 None
        """
        # 提取 GUID 部分
        guid = iterm_session_id.split(":")[-1] if ":" in iterm_session_id else iterm_session_id

        # 遍历查找匹配的终端
        matched_record: TerminalRecord | None = None
        for record in self.records.values():
            if record.handle.session_id == guid:
                matched_record = record
                break

        if matched_record is None or matched_record.status == TerminalStatus.closed:
            return None

        terminal_id = matched_record.id

        if status == "running":
            # 取消已有的 done 延迟计时器
            existing_timer = self._hook_done_timers.pop(terminal_id, None)
            if existing_timer is not None:
                existing_timer.cancel()

            # 更新状态为 running
            matched_record.status = TerminalStatus.running
            matched_record.summary = "Claude Code 工作中"
            matched_record.updated_at = self._now()
            await self._broadcast(self.record_event(terminal_id))

        elif status == "done":
            # 取消已有的 done 延迟计时器（防抖）
            existing_timer = self._hook_done_timers.pop(terminal_id, None)
            if existing_timer is not None:
                existing_timer.cancel()

            # 创建延迟计时器，10s 后更新为 done
            async def _delayed_done(rec: TerminalRecord, tid: str) -> None:
                await asyncio.sleep(10)
                self._hook_done_timers.pop(tid, None)
                if rec.status != TerminalStatus.closed and rec.id in self.records:
                    rec.status = TerminalStatus.done
                    rec.summary = "Claude Code 已完成"
                    rec.updated_at = self._now()
                    await self._broadcast(self.record_event(tid))

            self._hook_done_timers[terminal_id] = asyncio.create_task(
                _delayed_done(matched_record, terminal_id)
            )

        return terminal_id

    async def _summary_loop(self) -> None:
        """后台循环：为活跃终端生成 AI 摘要"""
        while True:
            try:
                # 优先处理队列中的变更终端
                try:
                    terminal_id = await asyncio.wait_for(self._summary_work_queue().get(), timeout=5.0)
                except asyncio.TimeoutError:
                    # 队列空，遍历所有活跃终端
                    for tid, record in list(self.records.items()):
                        if record.status == TerminalStatus.closed or not record.screen_text.strip():
                            continue
                        await self._generate_summary(tid)
                    continue

                if terminal_id in self.records:
                    await self._generate_summary(terminal_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("摘要循环异常: %s", e)
                await asyncio.sleep(5)

    async def _generate_summary(self, terminal_id: str, *, force: bool = False) -> None:
        """根据调度策略为终端生成 AI 摘要

        调度优先级：
        1. summarizer 未配置 → 设置 reason="no_api"
        2. 首次总结（ai_summary_first） → 立即总结
        3. 终端状态变更 → 立即总结
        4. 运行中终端 → 按 active_interval 间隔总结
        5. 空闲终端 → 内容稳定后总结
        """
        record = self.records.get(terminal_id)
        if not record or record.status == TerminalStatus.closed:
            return

        # 没有 screen_text 的终端
        if not record.screen_text.strip():
            record.ai_summary_status = "none"
            record.ai_summary_reason = "idle"
            record.ai_summary_error_detail = ""
            await self._broadcast(self.record_event(terminal_id))
            return

        # 1. summarizer 未配置
        if not self._summarizer:
            record.ai_summary_status = "none"
            record.ai_summary_reason = "no_api"
            record.ai_summary_error_detail = ""
            await self._broadcast(self.record_event(terminal_id))
            return

        current_status = record.status.value
        last_status = self._last_summary_status.get(terminal_id, "")

        if force:
            self._resume_auto_summary_for_terminal(record)

        if not force and terminal_id in self._summary_suspended_terminal_ids:
            return

        skipped_initial_hash = self._summary_skipped_initial_hash.get(terminal_id)
        if not force and skipped_initial_hash and skipped_initial_hash == record.content_hash:
            return

        # 2. 首次总结 → 立即执行
        if force:
            await self._run_summary_attempt(record, terminal_id, force_announce=True)
            record.ai_summary_first = False
            self._last_summary_status[terminal_id] = current_status
            return

        if record.ai_summary_first:
            await self._run_summary_attempt(record, terminal_id)
            record.ai_summary_first = False
            self._last_summary_status[terminal_id] = current_status
            return

        # 3. 终端状态变更 → 立即总结
        if current_status != last_status:
            await self._run_summary_attempt(record, terminal_id)
            self._last_summary_status[terminal_id] = current_status
            return

        # 4. 运行中终端 → 按 active_interval 间隔总结
        if current_status == "running":
            if self._is_failed_summary_retry_cooling_down(record):
                return
            if self._is_retryable_failed_summary(record):
                await self._run_summary_attempt(record, terminal_id)
                return
            active_interval = self.settings.summary_active_interval
            elapsed = time.time() - record.ai_summary_at if record.ai_summary_at > 0 else active_interval + 1
            if elapsed >= active_interval:
                await self._run_summary_attempt(record, terminal_id)
            # 冷却期内跳过，不覆盖已有的摘要状态
            return

        # 5. 空闲终端（idle/done/waiting）
        # 检查内容是否稳定（至少 10 秒无变化）
        stable_seconds = time.time() - record.content_stable_since if record.content_stable_since > 0 else 999
        if stable_seconds < 10:
            # 内容还在变化，只在从未总结过时才设置 reason
            if record.ai_summary_status == "none" and not record.ai_summary:
                record.ai_summary_reason = "content_changing"
                record.ai_summary_error_detail = ""
                await self._broadcast(self.record_event(terminal_id))
            return

        # 内容稳定，执行总结
        if self._is_failed_summary_retry_cooling_down(record):
            return
        await self._run_summary_attempt(record, terminal_id)

    def _should_announce_summary_start(self, record: TerminalRecord) -> bool:
        return (
            record.ai_summary_first
            or record.ai_summary_status == "fallback"
            or (record.ai_summary_status == "none" and not record.ai_summary)
        )

    def _summary_retry_interval(self) -> float:
        return max(5.0, float(self.settings.summary_fallback_retry_interval))

    def _is_failed_summary_retry_cooling_down(self, record: TerminalRecord) -> bool:
        if not self._is_retryable_failed_summary(record):
            return False
        if record.ai_summary_at <= 0:
            return False
        elapsed = time.time() - record.ai_summary_at
        return elapsed < self._summary_retry_interval()

    @staticmethod
    def _is_retryable_failed_summary(record: TerminalRecord) -> bool:
        return (
            record.ai_summary_status == "fallback"
            and record.ai_summary_reason in {"api_error", "empty_response"}
        )

    async def _set_summary_in_progress(self, record: TerminalRecord, terminal_id: str) -> bool:
        if record.ai_summary_status == "summarizing":
            return False
        record.ai_summary_status = "summarizing"
        record.ai_summary_reason = ""
        record.ai_summary_error_detail = ""
        await self._broadcast(self.record_event(terminal_id))
        return True

    async def _run_summary_attempt(self, record: TerminalRecord, terminal_id: str, *, force_announce: bool = False) -> None:
        previous_status = record.ai_summary_status
        previous_reason = record.ai_summary_reason
        previous_error_detail = record.ai_summary_error_detail
        restore_on_cache = False

        if force_announce or self._should_announce_summary_start(record):
            restore_on_cache = await self._set_summary_in_progress(record, terminal_id)

        await self._do_summarize(
            record,
            terminal_id,
            previous_status=previous_status,
            previous_reason=previous_reason,
            previous_error_detail=previous_error_detail,
            restore_on_cache=restore_on_cache,
        )

    async def _do_summarize(
        self,
        record: TerminalRecord,
        terminal_id: str,
        *,
        previous_status: str = "none",
        previous_reason: str = "",
        previous_error_detail: str = "",
        restore_on_cache: bool = False,
    ) -> None:
        """实际调用 summarizer 生成摘要"""
        try:
            result = await self._summarizer.summarize(terminal_id, record.screen_text)
            # 仅在切换到 summarizing 后，需要用缓存结果恢复真实状态。
            if result.from_cache:
                if not restore_on_cache:
                    return
                record.ai_summary = result.text
                if record.ai_summary_at <= 0:
                    record.ai_summary_at = time.time()
                if result.used_ai:
                    record.ai_summary_status = "done"
                    record.ai_summary_reason = ""
                    record.ai_summary_error_detail = ""
                else:
                    record.ai_summary_status = "fallback"
                    record.ai_summary_reason = result.reason or previous_reason or "api_error"
                    record.ai_summary_error_detail = result.error_detail or previous_error_detail
                await self._broadcast(self.record_event(terminal_id))
                return
            record.ai_summary = result.text
            record.ai_summary_at = time.time()
            record.ai_summary_status = "done" if result.used_ai else "fallback"
            record.ai_summary_reason = "" if result.used_ai else (result.reason or previous_reason or "api_error")
            record.ai_summary_error_detail = "" if result.used_ai else (result.error_detail or previous_error_detail)
        except Exception as exc:
            # API 调用失败 → 降级为截断文本
            record.ai_summary_status = "fallback"
            record.ai_summary_reason = "api_error"
            record.ai_summary_error_detail = " ".join(str(exc).split()).strip()[:120]
            # 使用截断文本作为降级内容
            from multi_iterm2_manager.summarizer import TerminalSummarizer
            record.ai_summary = TerminalSummarizer.fallback_text(record.screen_text)
            record.ai_summary_at = time.time()
        await self._broadcast(self.record_event(terminal_id))
