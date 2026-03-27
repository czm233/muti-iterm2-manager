from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
from dataclasses import dataclass
from datetime import datetime
from math import ceil, sqrt

from multi_iterm2_manager.models import GridLayoutParams, ScreenConfig, ScreenInfo, TerminalFrame

try:
    import AppKit  # type: ignore
except Exception:
    AppKit = None

try:
    import objc  # type: ignore
except Exception:
    objc = None

# --- CoreGraphics ctypes 绑定（实时屏幕检测，不受 NSScreen 缓存影响） ---

_cg_lib = None
_cd_lib = None


def _cg():
    """延迟加载 CoreGraphics 动态库"""
    global _cg_lib
    if _cg_lib is None:
        path = ctypes.util.find_library("CoreGraphics")
        if path:
            _cg_lib = ctypes.cdll.LoadLibrary(path)
            # 定义函数签名
            _cg_lib.CGDisplayBounds.restype = _CGRect
            _cg_lib.CGDisplayBounds.argtypes = [ctypes.c_uint32]
            _cg_lib.CGDisplayIsMain.argtypes = [ctypes.c_uint32]
            _cg_lib.CGDisplayIsBuiltin.argtypes = [ctypes.c_uint32]
    return _cg_lib


def _cd():
    """延迟加载 CoreDisplay 框架（用于实时获取屏幕名称，不受 NSScreen 缓存影响）"""
    global _cd_lib
    if _cd_lib is None:
        try:
            _cd_lib = ctypes.cdll.LoadLibrary(
                "/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay"
            )
            _cd_lib.CoreDisplay_DisplayCreateInfoDictionary.restype = ctypes.c_void_p
            _cd_lib.CoreDisplay_DisplayCreateInfoDictionary.argtypes = [ctypes.c_uint32]
        except Exception:
            _cd_lib = False  # 标记为不可用，避免重复加载
    return _cd_lib if _cd_lib is not False else None


def _get_display_name_via_coredisplay(display_id: int) -> str | None:
    """通过 CoreDisplay 实时获取屏幕名称（不依赖 NSScreen 缓存）"""
    cd = _cd()
    if cd is None or objc is None:
        return None
    try:
        info_ptr = cd.CoreDisplay_DisplayCreateInfoDictionary(display_id)
        if not info_ptr:
            return None
        info = objc.objc_object(c_void_p=ctypes.c_void_p(info_ptr))
        names = info.get("DisplayProductName", {})
        if names:
            return names.get("en_US") or list(names.values())[0]
    except Exception:
        pass
    return None


class _CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class _CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class _CGRect(ctypes.Structure):
    _fields_ = [("origin", _CGPoint), ("size", _CGSize)]


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
    """获取所有可用屏幕信息，返回包含 index/name/width/height/x/y 的列表。

    使用 CoreGraphics CGGetActiveDisplayList 实时检测屏幕，
    避免 NSScreen.screens() 在长时间运行进程中的缓存问题（热插拔外接屏幕时不更新）。
    """
    cg = _cg()
    if cg is None:
        # CoreGraphics 不可用，回退到 NSScreen
        return _get_all_screens_appkit()

    max_displays = 16
    display_ids = (ctypes.c_uint32 * max_displays)()
    count = ctypes.c_uint32(0)
    err = cg.CGGetActiveDisplayList(max_displays, display_ids, ctypes.byref(count))
    if err != 0 or count.value == 0:
        return _get_all_screens_appkit()

    # 尝试从 NSScreen 获取 visibleFrame（按 displayID 映射）
    visible_map: dict[int, dict] = {}
    if AppKit is not None:
        try:
            for s in AppKit.NSScreen.screens():
                desc = s.deviceDescription()
                num = desc.get("NSScreenNumber", None)
                if num is not None:
                    v = s.visibleFrame()
                    visible_map[int(num)] = {
                        "visibleX": int(v.origin.x),
                        "visibleY": int(v.origin.y),
                        "visibleWidth": int(v.size.width),
                        "visibleHeight": int(v.size.height),
                    }
        except Exception:
            pass

    result = []
    for i in range(count.value):
        did = display_ids[i]
        bounds = cg.CGDisplayBounds(did)
        is_main = bool(cg.CGDisplayIsMain(did))
        is_builtin = bool(cg.CGDisplayIsBuiltin(did))

        w = int(bounds.size.width)
        h = int(bounds.size.height)
        x = int(bounds.origin.x)
        y = int(bounds.origin.y)

        # 屏幕名称：优先用 CoreDisplay（实时），回退到 NSScreen（可能缓存旧值）
        name = _get_display_name_via_coredisplay(did)
        if not name:
            name = "Built-in Retina Display" if is_builtin else f"外接屏幕 {i}"
            if AppKit is not None:
                try:
                    for s in AppKit.NSScreen.screens():
                        desc = s.deviceDescription()
                        if desc.get("NSScreenNumber") and int(desc["NSScreenNumber"]) == did:
                            localized = s.localizedName()
                            if localized:
                                name = localized
                            break
                except Exception:
                    pass

        # 可用区域：优先用 NSScreen 数据，否则近似
        vis = visible_map.get(did)
        if vis:
            vx, vy, vw, vh = vis["visibleX"], vis["visibleY"], vis["visibleWidth"], vis["visibleHeight"]
        else:
            # 近似：主屏幕扣除菜单栏(~39px)，非主屏幕使用全部区域
            menu_bar = 39 if is_main else 0
            vx, vy, vw, vh = x, y, w, h - menu_bar

        result.append({
            "index": i,
            "name": name,
            "width": w,
            "height": h,
            "x": x,
            "y": y,
            "visibleX": vx,
            "visibleY": vy,
            "visibleWidth": vw,
            "visibleHeight": vh,
        })
    return result


def _get_all_screens_appkit() -> list[dict]:
    """AppKit 回退方案"""
    if AppKit is None:
        return [{"index": 0, "name": "主屏幕", "width": 1728, "height": 1117,
                 "x": 0, "y": 0, "visibleX": 0, "visibleY": 0,
                 "visibleWidth": 1728, "visibleHeight": 1117}]

    screens = AppKit.NSScreen.screens()
    if not screens:
        return [{"index": 0, "name": "主屏幕", "width": 1728, "height": 1117,
                 "x": 0, "y": 0, "visibleX": 0, "visibleY": 0,
                 "visibleWidth": 1728, "visibleHeight": 1117}]

    result = []
    for i, screen in enumerate(screens):
        frame = screen.frame()
        visible = screen.visibleFrame()
        name = "主屏幕" if i == 0 else f"屏幕 {i + 1}"
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
            "visibleX": int(visible.origin.x),
            "visibleY": int(visible.origin.y),
            "visibleWidth": int(visible.size.width),
            "visibleHeight": int(visible.size.height),
        })
    return result


def get_screen_bounds(screen_index: int) -> DisplayBounds | None:
    """获取指定屏幕的可用区域，返回 None 表示屏幕不存在。

    使用 get_all_screens() 保持一致的实时检测逻辑。
    """
    screens = get_all_screens()
    if screen_index < 0 or screen_index >= len(screens):
        return None

    s = screens[screen_index]
    return DisplayBounds(
        x=float(s["visibleX"]),
        y=float(s["visibleY"]),
        width=float(s["visibleWidth"]),
        height=float(s["visibleHeight"]),
    )


def get_screen_index_from_coordinates(x: float, y: float) -> int:
    """根据坐标判断所在屏幕索引，返回 -1 表示未找到"""
    screens = get_all_screens()
    for screen in screens:
        if (screen["x"] <= x < screen["x"] + screen["width"] and
            screen["y"] <= y < screen["y"] + screen["height"]):
            return screen["index"]
    return -1


def build_maximized_frame(padding: float = 18.0, screen_index: int = -1) -> TerminalFrame:
    """构建最大化窗口 frame。当 screen_index >= 0 时使用指定屏幕的边界。"""
    bounds = None
    if screen_index >= 0:
        bounds = get_screen_bounds(screen_index)
    if bounds is None:
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


def build_grid_frames(count: int, params: GridLayoutParams, screen_index: int = -1) -> list[TerminalFrame]:
    if count <= 0:
        return []

    columns = max(1, params.columns)
    rows = max(params.rows, ceil(count / columns))
    gap = max(0.0, params.gap)
    padding = max(0.0, params.padding)
    bounds = None
    if screen_index >= 0:
        bounds = get_screen_bounds(screen_index)
    if bounds is None:
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


# ============ 屏幕配置快照功能 ============


def _dict_to_screen_info(screen_dict: dict) -> ScreenInfo:
    """将 get_all_screens() 返回的 dict 转换为 ScreenInfo 对象"""
    # 判断是否为主屏幕：x=0 且 y=0 或者是第一个屏幕
    is_primary = screen_dict.get("index", 0) == 0 or (screen_dict["x"] == 0 and screen_dict["y"] == 0)
    return ScreenInfo(
        name=screen_dict["name"],
        width=screen_dict["width"],
        height=screen_dict["height"],
        x=screen_dict["x"],
        y=screen_dict["y"],
        is_primary=is_primary,
    )


def generate_screen_fingerprint(screens: list[ScreenInfo] | None = None) -> str:
    """生成当前屏幕配置的唯一指纹 (8位)

    基于屏幕的名称、尺寸和位置生成指纹，确保相同的屏幕配置总是产生相同的指纹。

    Args:
        screens: 屏幕列表，如果为 None 则自动获取当前屏幕配置

    Returns:
        8位十六进制指纹字符串
    """
    if screens is None:
        screen_dicts = get_all_screens()
        screens = [_dict_to_screen_info(s) for s in screen_dicts]

    if not screens:
        return "00000000"

    # 收集所有屏幕的关键信息
    screen_data = []
    for s in screens:
        screen_data.append(f"{s.name}:{s.width}x{s.height}@{s.x},{s.y}")

    # 按字符串排序，确保顺序一致
    screen_data.sort()

    # 生成指纹
    fingerprint_str = "|".join(screen_data)

    return hashlib.md5(fingerprint_str.encode()).hexdigest()[:8]


def get_current_screen_config() -> ScreenConfig:
    """获取当前屏幕配置快照

    Returns:
        ScreenConfig 包含当前所有屏幕信息和配置指纹
    """
    screen_dicts = get_all_screens()
    screens = [_dict_to_screen_info(s) for s in screen_dicts]
    fingerprint = generate_screen_fingerprint(screens)

    # 找到主屏幕
    primary = next((s for s in screens if s.is_primary), screens[0] if screens else None)

    return ScreenConfig(
        fingerprint=fingerprint,
        primary_screen_name=primary.name if primary else "",
        screens=screens,
        created_at=datetime.now().isoformat(timespec="seconds"),
    )
