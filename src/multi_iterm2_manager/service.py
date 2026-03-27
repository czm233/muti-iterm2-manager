from __future__ import annotations

import asyncio
import hashlib
import os
import re
import time
from contextlib import suppress
from datetime import datetime
from dataclasses import replace
from pathlib import Path
from typing import Any

from multi_iterm2_manager.analyzer import analyze_screen_text, analyze_timeout_only, load_rules, RuleEngineConfig
from multi_iterm2_manager.backend.mock import MockTerminalBackend
from multi_iterm2_manager.config import Settings, save_ui_settings
from multi_iterm2_manager.display import build_maximized_frame, get_all_screens, get_screen_index_from_coordinates, suggest_monitor_grid
from multi_iterm2_manager.models import CreateTerminalParams, GridLayoutParams, TerminalFrame, TerminalRecord, TerminalStatus, new_terminal_id


class DashboardService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.records: dict[str, TerminalRecord] = {}
        self.monitor_tasks: dict[str, asyncio.Task[None]] = {}
        self._subscribers: set[asyncio.Queue[dict]] = set()
        self._lock = asyncio.Lock()
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

    async def stop(self) -> None:
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
        return self.ui_settings.target_screen

    def set_target_screen(self, screen_index: int) -> None:
        """设置目标屏幕索引，-1 表示不指定，并持久化到配置文件"""
        self.ui_settings = replace(self.ui_settings, target_screen=screen_index)
        self.settings.ui_settings = self.ui_settings
        save_ui_settings(self.settings.ui_settings_file, self.ui_settings)

    async def create_terminal(self, params: CreateTerminalParams) -> dict:
        final_name = (params.name or '').strip() or self._next_default_name()

        # 优先使用浏览器坐标计算屏幕，其次使用全局 target_screen
        screen_index = -1
        if params.browser_x is not None and params.browser_y is not None:
            screen_index = get_screen_index_from_coordinates(params.browser_x, params.browser_y)
        if screen_index < 0:
            screen_index = self.ui_settings.target_screen

        # 优先级：1. 显式传入的 frame > 2. 默认窗口模板 > 3. build_maximized_frame
        target_frame = params.frame
        if target_frame is None:
            default_frame = self.get_default_frame()
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
        async with self._lock:
            self.records[record.id] = record
        # 对齐窗口大小到其他可见终端
        await self._align_frame_to_siblings(record)
        await self.refresh_terminal(record.id)
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
        if self.ui_settings.target_screen >= 0:
            from multi_iterm2_manager.display import get_screen_bounds
            bounds = get_screen_bounds(self.ui_settings.target_screen)
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

    async def focus_terminal(self, terminal_id: str, browser_x: float | None = None, browser_y: float | None = None) -> dict:
        record = self._get_record(terminal_id)
        try:
            await self.backend.focus(record.handle)
            # 如果传入了浏览器坐标，根据坐标计算屏幕并移动窗口
            if browser_x is not None and browser_y is not None:
                screen_index = get_screen_index_from_coordinates(browser_x, browser_y)
                if screen_index >= 0:
                    from multi_iterm2_manager.display import get_screen_bounds
                    bounds = get_screen_bounds(screen_index)
                    if bounds is not None:
                        current_frame = await self.backend.get_frame(record.handle)
                        if current_frame is not None:
                            # 检查窗口是否已经在当前屏幕范围内，避免覆盖用户手动移动的位置
                            in_screen = (bounds.x <= current_frame.x < bounds.x + bounds.width
                                         and bounds.y <= current_frame.y < bounds.y + bounds.height)
                            if not in_screen:
                                new_frame = TerminalFrame(
                                    x=round(bounds.x + 18.0, 2),
                                    y=round(bounds.y + 18.0, 2),
                                    width=current_frame.width,
                                    height=current_frame.height,
                                )
                                await self.backend.set_frame(record.handle, new_frame)
                                record.frame = new_frame
                        # 让其他可见终端也跟随移动到同一屏幕
                        await self._move_siblings_to_screen(record, bounds)
            else:
                await self._move_to_target_screen(record)
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

    def list_all_tags(self) -> list[str]:
        """遍历所有非关闭终端，收集去重排序的标签列表"""
        all_tags: set[str] = set()
        for record in self.records.values():
            if record.status != TerminalStatus.closed:
                all_tags.update(record.tags)
        return sorted(all_tags)

    async def _move_siblings_to_screen(self, source_record: TerminalRecord, bounds) -> None:
        """将其他可见终端移动到与源终端相同的屏幕"""
        for sibling in self.records.values():
            if sibling.id == source_record.id:
                continue
            if sibling.status == TerminalStatus.closed or sibling.hidden:
                continue
            try:
                current_frame = await self.backend.get_frame(sibling.handle)
                if current_frame is not None:
                    # 检查是否已经在目标屏幕内
                    in_screen = (bounds.x <= current_frame.x < bounds.x + bounds.width
                                 and bounds.y <= current_frame.y < bounds.y + bounds.height)
                    if not in_screen:
                        new_frame = TerminalFrame(
                            x=round(bounds.x + 18.0, 2),
                            y=round(bounds.y + 18.0, 2),
                            width=current_frame.width,
                            height=current_frame.height,
                        )
                        await self.backend.set_frame(sibling.handle, new_frame)
                        sibling.frame = new_frame
            except Exception:
                pass

    async def _align_frame_to_siblings(self, record: TerminalRecord) -> None:
        """将窗口大小对齐到其他可见终端（取第一个非隐藏、非关闭终端的 frame）"""
        # 对齐到兄弟终端的 frame
        for sibling in self.records.values():
            if sibling.id == record.id:
                continue
            if sibling.status == TerminalStatus.closed or sibling.hidden:
                continue
            if sibling.frame is not None:
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
        # 没有兄弟终端时，如果设置了目标屏幕，移动到目标屏幕
        if self.ui_settings.target_screen >= 0:
            target = build_maximized_frame(screen_index=self.ui_settings.target_screen)
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
        await self.backend.detach(record.handle)
        task = self.monitor_tasks.pop(record.id, None)
        if task is not None:
            task.cancel()
        async with self._lock:
            del self.records[record.id]
        await self._broadcast(self.snapshot_event())
        return {"detached": True, "terminalId": terminal_id}

    async def scan_sessions(self) -> list[dict]:
        # 将当前已知的 session IDs 传给后端，使其能识别"孤儿托管"终端
        # 孤儿托管 = 有 mitm_managed 标记，但服务重启后 records 已清空的旧终端
        known_ids = {r.handle.session_id for r in self.records.values()}
        return await self.backend.scan_unmanaged_sessions(known_session_ids=known_ids)

    async def adopt_terminal(self, session_id: str, name: str | None = None) -> dict:
        explicit_name = (name or '').strip() if name else None
        handle = await self.backend.adopt(session_id, explicit_name)
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
        )
        # 将最终 ID 写回 iTerm2 session 变量，确保下次重启可复用
        try:
            await self.backend.set_terminal_id(handle, record.id)
        except Exception:
            pass
        async with self._lock:
            self.records[record.id] = record
        # 对齐窗口大小到其他可见终端
        if not record.hidden:
            await self._align_frame_to_siblings(record)
        await self.refresh_terminal(record.id)
        self._start_monitor(record.id)
        await self.enter_monitor_mode()
        await self._broadcast(self.record_event(record.id))
        return record.to_dict()

    async def close_all_terminals(self) -> list[dict]:
        target_ids = [record.id for record in self.records.values() if record.status != TerminalStatus.closed]
        result: list[dict] = []
        for terminal_id in target_ids:
            result.append(await self.close_terminal(terminal_id))
        # 清理所有已关闭的记录，避免状态残留
        closed_ids = [rid for rid, rec in self.records.items() if rec.status == TerminalStatus.closed]
        async with self._lock:
            for rid in closed_ids:
                self.records.pop(rid, None)
        # 广播 snapshot 确保前端拿到一致状态
        await self._broadcast(self.snapshot_event())
        return result

    async def refresh_terminal(self, terminal_id: str) -> dict:
        record = self._get_record(terminal_id)
        try:
            text, screen_html = await self.backend.get_screen_render(record.handle)
        except Exception as exc:
            if self._is_missing_terminal_error(exc):
                return await self._mark_terminal_closed(record, reason="真实窗口已被手动关闭")
            raise
        self._apply_screen_text(record, text, screen_html, is_live=False)
        # 获取当前工作目录
        cwd = await self.backend.get_cwd(record.handle)
        if cwd is not None:
            record.cwd = cwd
        await self._broadcast(self.record_event(terminal_id))
        return record.to_dict()

    async def send_text(self, terminal_id: str, text: str) -> dict:
        record = self._get_record(terminal_id)
        payload = text if text.endswith("\n") or text.endswith("\r") else f"{text}\n"
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

    def get_default_frame(self) -> dict | None:
        """获取默认窗口模板，若未设置返回 None"""
        if (self.ui_settings.default_frame_x is not None and
            self.ui_settings.default_frame_y is not None and
            self.ui_settings.default_frame_width is not None and
            self.ui_settings.default_frame_height is not None):
            return {
                "x": self.ui_settings.default_frame_x,
                "y": self.ui_settings.default_frame_y,
                "width": self.ui_settings.default_frame_width,
                "height": self.ui_settings.default_frame_height,
            }
        return None

    async def set_default_frame(self, frame: TerminalFrame) -> dict:
        """设置默认窗口模板并持久化"""
        self.ui_settings = replace(
            self.ui_settings,
            default_frame_x=frame.x,
            default_frame_y=frame.y,
            default_frame_width=frame.width,
            default_frame_height=frame.height,
        )
        self.settings.ui_settings = self.ui_settings
        save_ui_settings(self.settings.ui_settings_file, self.ui_settings)

        payload = {
            "type": "default-frame-updated",
            "defaultFrame": frame.to_dict(),
        }
        await self._broadcast(payload)
        return payload

    async def apply_default_frame_to_all(self) -> dict:
        """将默认位置应用到所有活跃终端"""
        default_frame = self.get_default_frame()
        if default_frame is None:
            raise ValueError("尚未设置默认窗口模板")

        frame = TerminalFrame(**default_frame)
        applied = 0
        errors = []

        for record in self.records.values():
            if record.status == TerminalStatus.closed or record.hidden:
                continue
            try:
                await self.backend.set_frame(record.handle, frame)
                record.frame = frame
                applied += 1
            except Exception as e:
                errors.append({"terminalId": record.id, "error": str(e)})

        await self._broadcast(self.snapshot_event())
        return {"applied": applied, "errors": errors, "frame": frame.to_dict()}

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
                self._apply_screen_text(record, text, screen_html, is_live=True)

                status_changed = record.status != old_status
                content_changed = record.content_hash != old_hash

                # 内容变化时才更新工作目录，避免无意义的 API 调用
                if content_changed:
                    cwd = await self.backend.get_cwd(record.handle)
                    if cwd is not None:
                        record.cwd = cwd

                # 状态变了但内容没变（超时规则触发），立即广播不限速
                if status_changed and not content_changed:
                    if pending_broadcast is not None and not pending_broadcast.done():
                        pending_broadcast.cancel()
                        pending_broadcast = None
                    last_broadcast_time = time.time()
                    await self._broadcast(self.record_event(terminal_id))
                    continue

                # 内容和状态都没变，跳过广播
                if not content_changed:
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

    async def _mark_terminal_closed(self, record: TerminalRecord, reason: str | None = None) -> dict:
        record.status = TerminalStatus.closed
        record.updated_at = self._now()
        record.is_live = False
        record.last_error = None
        if reason:
            record.summary = reason
        task = self.monitor_tasks.pop(record.id, None)
        if task is not None:
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

    def _apply_screen_text(self, record: TerminalRecord, text: str, screen_html: str, is_live: bool) -> None:
        # 已关闭的终端不再更新状态
        if record.status == TerminalStatus.closed:
            return

        # 计算内容哈希，判断内容是否变化
        new_hash = hashlib.md5(text.encode()).hexdigest()
        if new_hash != record.content_hash:
            record.content_hash = new_hash
            record.content_stable_since = time.time()

        # 计算停滞时间
        stable_seconds = 0.0
        if record.content_stable_since > 0:
            stable_seconds = time.time() - record.content_stable_since

        old_status = record.status
        status, markers, summary = analyze_screen_text(text, stable_seconds, self._rule_config)

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
        while True:
            await asyncio.sleep(5)
            alive = not hasattr(self.backend, 'is_alive') or self.backend.is_alive()
            print(f"[watchdog] iTerm2 alive={alive}, terminals={len(self.records)}", flush=True)
            if alive:
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
