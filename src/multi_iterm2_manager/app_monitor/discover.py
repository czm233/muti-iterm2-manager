"""窗口发现模块 - 使用 CoreGraphics API 枚举当前可见窗口"""
from __future__ import annotations

import ctypes
import ctypes.util
import logging
import os

from multi_iterm2_manager.app_monitor.models import DiscoveredWindow

logger = logging.getLogger(__name__)

try:
    import objc  # type: ignore
except Exception:
    objc = None

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None

# 需要排除的系统进程名称
_EXCLUDED_OWNERS = frozenset({
    "WindowServer",
    "Dock",
    "SystemUIServer",
    "loginwindow",
    "Notification Center",
    "Control Center",
    "Spotlight",
})

_cg_lib = None


def _cg():
    """延迟加载 CoreGraphics 动态库"""
    global _cg_lib
    if _cg_lib is None:
        path = ctypes.util.find_library("CoreGraphics")
        if path:
            _cg_lib = ctypes.cdll.LoadLibrary(path)
            _cg_lib.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
            _cg_lib.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    return _cg_lib


def discover_visible_windows() -> list[DiscoveredWindow]:
    """枚举当前所有可见窗口（排除系统进程和自身进程）"""
    cg = _cg()
    if cg is None or objc is None or AppKit is None:
        logger.warning("CoreGraphics/AppKit/objc 不可用，无法发现窗口")
        return []

    bundle_map = _build_bundle_id_map()
    self_pid = os.getpid()
    seen_windows: set[int] = set()

    # 先尝试 OnScreenOnly，如果没有 Screen Recording 权限会返回空
    # 此时回退到 option=0 + 手动过滤 layer==0
    for option in (24, 0):
        window_list_ptr = cg.CGWindowListCopyWindowInfo(option, 0)
        if not window_list_ptr:
            continue

        try:
            count = _cf_array_get_count(window_list_ptr)
            if count == 0:
                continue

            result: list[DiscoveredWindow] = []

            for i in range(count):
                try:
                    item_ptr = _cf_array_get_value_at(window_list_ptr, i)
                    if not item_ptr:
                        continue
                    info = objc.objc_object(c_void_p=ctypes.c_void_p(item_ptr))

                    layer = info.get("kCGWindowLayer", -1)
                    if layer != 0:
                        continue

                    # option=24 时 onScreen 过滤由系统完成；option=0 时手动过滤
                    if option == 0:
                        on_screen = info.get("kCGWindowIsOnscreen", False)
                        # 没有权限时 onScreen 全为 False，跳过此检查
                        # 只要有 title 且 layer==0 就认为可见
                    else:
                        on_screen = info.get("kCGWindowIsOnscreen", False)
                        if not on_screen:
                            continue

                    pid = info.get("kCGWindowOwnerPID", 0)
                    if not pid or pid == self_pid:
                        continue

                    owner_name = str(info.get("kCGWindowOwnerName", ""))
                    if owner_name in _EXCLUDED_OWNERS:
                        continue

                    window_title = str(info.get("kCGWindowName", ""))
                    if not window_title:
                        continue

                    window_number = info.get("kCGWindowNumber", 0)
                    if not window_number:
                        continue

                    # 去重（option=0 可能包含重复，option=24 也可能返回重复记录）
                    win_key = int(window_number)
                    if win_key in seen_windows:
                        continue
                    seen_windows.add(win_key)

                    bounds = info.get("kCGWindowBounds", {})
                    frame = {
                        "x": bounds.get("X", 0),
                        "y": bounds.get("Y", 0),
                        "width": bounds.get("Width", 0),
                        "height": bounds.get("Height", 0),
                    }

                    bundle_id = str(bundle_map.get(pid, ""))
                    app_name = owner_name or bundle_id.split(".")[-1] if bundle_id else owner_name

                    result.append(DiscoveredWindow(
                        pid=int(pid),
                        bundle_id=bundle_id,
                        app_name=str(app_name),
                        window_title=window_title,
                        window_number=int(window_number),
                        owner_name=owner_name,
                        frame=frame,
                        is_on_screen=bool(info.get("kCGWindowIsOnscreen", True)),
                    ))
                except Exception:
                    continue

            # option=24 有结果就直接返回
            if result:
                return _dedupe_logical_windows(result)
            # 否则尝试 option=0

        finally:
            _cf_release(window_list_ptr)

    return []


def _dedupe_logical_windows(windows: list[DiscoveredWindow]) -> list[DiscoveredWindow]:
    """折叠同一进程下标题相同的重复窗口，保留面积更大的主窗口。"""
    deduped: dict[tuple[int, str], DiscoveredWindow] = {}
    order: list[tuple[int, str]] = []

    for win in windows:
        key = (int(win.pid), win.window_title.strip())
        existing = deduped.get(key)
        if existing is None:
            deduped[key] = win
            order.append(key)
            continue

        if _window_area(win.frame) > _window_area(existing.frame):
            logger.debug(
                "使用更大的窗口替换重复项: pid=%d, title=%s, %d -> %d",
                win.pid,
                win.window_title,
                existing.window_number,
                win.window_number,
            )
            deduped[key] = win

    return [deduped[key] for key in order]


def _window_area(frame: dict) -> float:
    try:
        return float(frame.get("width", 0) or 0) * float(frame.get("height", 0) or 0)
    except Exception:
        return 0.0


def _cf_array_get_count(array_ptr: int) -> int:
    """获取 CFArray 长度"""
    cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    return int(cf.CFArrayGetCount(array_ptr))


def _cf_array_get_value_at(array_ptr: int, index: int) -> int:
    """获取 CFArray 指定位置的元素指针"""
    cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    return int(cf.CFArrayGetValueAtIndex(array_ptr, index))


def _cf_release(ptr: int) -> None:
    """释放 CoreFoundation 对象"""
    try:
        cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
        cf.CFRelease.restype = None
        cf.CFRelease.argtypes = [ctypes.c_void_p]
        cf.CFRelease(ptr)
    except Exception:
        pass


def _build_bundle_id_map() -> dict[int, str]:
    """构建 PID -> bundle_id 映射表"""
    bundle_map: dict[int, str] = {}
    if AppKit is None:
        return bundle_map
    try:
        apps = AppKit.NSWorkspace.sharedWorkspace().runningApplications()
        for app in apps:
            pid = app.processIdentifier()
            bid = app.bundleIdentifier()
            if pid and bid:
                bundle_map[int(pid)] = str(bid)
    except Exception:
        pass
    return bundle_map
