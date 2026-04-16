from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml

from .models import ScreenLayoutConfig, TerminalLayout


@dataclass
class UiSettings:
    dashboard_padding_px: int = 0
    monitor_stage_padding_px: int = 12
    dashboard_gap_px: int = 5
    monitor_grid_gap_px: int = 6
    wall_card_padding_px: int = 10
    wall_card_border_radius_px: int = 22
    wall_card_border_width_px: float = 1.0
    wall_card_terminal_border_width_px: float = 1.0
    split_resizer_hit_area_px: int = 14
    split_resizer_line_width_px: int = 2
    grid_resizer_hit_area_px: int = 16
    grid_resizer_line_width_px: int = 2
    statusbar_font_size_px: int = 13
    statusbar_meter_width_px: int = 90
    statusbar_meter_height_px: int = 10
    filter_tab_slide_duration_ms: int = 420
    terminal_font_size_px: int = 10
    # 屏幕设置
    target_screen: int = -1  # -1 表示"跟随当前/不指定"，0 表示屏幕1，1 表示屏幕2...
    # 默认窗口位置模板（按屏幕名称存储，键是屏幕名称，值是 {"x":..., "y":..., "width":..., "height":...}）
    default_frames_by_screen: dict | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    backend: str = "auto"
    demo_layout_columns: int = 2
    demo_layout_rows: int = 2
    rules_file: str = "rules.yaml"
    ui_settings_file: str = "ui-settings.yaml"
    ui_settings: UiSettings = field(default_factory=UiSettings)


def _resolve_project_file(path_value: str) -> Path:
    path = Path(path_value)
    if path.is_absolute():
        return path
    return Path.cwd() / path


def _read_yaml_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return loaded if isinstance(loaded, dict) else {}


def load_ui_settings(path_value: str) -> UiSettings:
    path = _resolve_project_file(path_value)
    payload = _read_yaml_file(path)
    raw_ui = payload.get("ui")
    ui_payload: dict[str, Any] = raw_ui if isinstance(raw_ui, dict) else payload

    # 向后兼容：如果旧配置有 default_frame_x/y/width/height，自动迁移到新格式
    if "default_frame_x" in ui_payload and "default_frames_by_screen" not in ui_payload:
        old_x = ui_payload.pop("default_frame_x", None)
        old_y = ui_payload.pop("default_frame_y", None)
        old_w = ui_payload.pop("default_frame_width", None)
        old_h = ui_payload.pop("default_frame_height", None)
        if all(v is not None for v in [old_x, old_y, old_w, old_h]):
            # 尝试用坐标检测真实屏幕名称
            try:
                from .display import get_screen_name_from_coordinates
                screen_name = get_screen_name_from_coordinates(old_x, old_y)
            except Exception:
                screen_name = None
            if not screen_name:
                screen_name = "默认"
            ui_payload["default_frames_by_screen"] = {
                screen_name: {"x": old_x, "y": old_y, "width": old_w, "height": old_h}
            }

    defaults = UiSettings()
    values: dict[str, Any] = {}
    for field_name in defaults.to_dict():
        if field_name in ui_payload:
            values[field_name] = ui_payload[field_name]
    return UiSettings(**values)


def save_ui_settings(path_value: str, ui_settings: UiSettings) -> Path:
    path = _resolve_project_file(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 保留文件中已有的非 ui 字段（如 screen_layouts），避免覆盖丢失
    existing = _read_yaml_file(path) if path.exists() else {}
    existing.update({
        "ui": {
            "dashboard_padding_px": ui_settings.dashboard_padding_px,
            "monitor_stage_padding_px": ui_settings.monitor_stage_padding_px,
            "dashboard_gap_px": ui_settings.dashboard_gap_px,
            "monitor_grid_gap_px": ui_settings.monitor_grid_gap_px,
            "wall_card_padding_px": ui_settings.wall_card_padding_px,
            "wall_card_border_radius_px": ui_settings.wall_card_border_radius_px,
            "wall_card_border_width_px": ui_settings.wall_card_border_width_px,
            "wall_card_terminal_border_width_px": ui_settings.wall_card_terminal_border_width_px,
            "split_resizer_hit_area_px": ui_settings.split_resizer_hit_area_px,
            "split_resizer_line_width_px": ui_settings.split_resizer_line_width_px,
            "grid_resizer_hit_area_px": ui_settings.grid_resizer_hit_area_px,
            "grid_resizer_line_width_px": ui_settings.grid_resizer_line_width_px,
            "statusbar_font_size_px": ui_settings.statusbar_font_size_px,
            "statusbar_meter_width_px": ui_settings.statusbar_meter_width_px,
            "statusbar_meter_height_px": ui_settings.statusbar_meter_height_px,
            "filter_tab_slide_duration_ms": ui_settings.filter_tab_slide_duration_ms,
            "terminal_font_size_px": ui_settings.terminal_font_size_px,
            # 屏幕设置
            "target_screen": ui_settings.target_screen,
            # 默认窗口位置模板（按屏幕名称）
            "default_frames_by_screen": ui_settings.default_frames_by_screen,
        }
    })
    path.write_text(
        yaml.safe_dump(existing, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return path


def load_settings() -> Settings:
    ui_settings_file = os.getenv("MITERM_UI_SETTINGS_FILE", "ui-settings.yaml")
    return Settings(
        host=os.getenv("MITERM_HOST", "127.0.0.1"),
        port=int(os.getenv("MITERM_PORT", "8765")),
        backend=os.getenv("MITERM_BACKEND", "auto").lower(),
        demo_layout_columns=int(os.getenv("MITERM_DEMO_COLUMNS", "2")),
        demo_layout_rows=int(os.getenv("MITERM_DEMO_ROWS", "2")),
        rules_file=os.getenv("MITERM_RULES_FILE", "rules.yaml"),
        ui_settings_file=ui_settings_file,
        ui_settings=load_ui_settings(ui_settings_file),
    )


# ============ 屏幕布局配置管理 ============


def _terminal_layout_from_dict(terminal_id: str, data: dict[str, Any]) -> TerminalLayout:
    """从字典创建 TerminalLayout 对象"""
    return TerminalLayout(
        terminal_id=terminal_id,
        x=data.get("x", 0),
        y=data.get("y", 0),
        width=data.get("width", 0),
        height=data.get("height", 0),
    )


def _screen_layout_from_dict(layout_key: str, data: dict[str, Any]) -> ScreenLayoutConfig:
    """从字典创建 ScreenLayoutConfig 对象

    layout_key 是布局存储的键（屏幕名称）。
    兼容旧数据：如果数据中有 screenFingerprint 字段但没有 screenName，则使用 layout_key。
    """
    terminals: dict[str, TerminalLayout] = {}
    terminals_data = data.get("terminals", {})
    for tid, tdata in terminals_data.items():
        terminals[tid] = _terminal_layout_from_dict(tid, tdata)

    # 兼容旧数据：旧版用 screenFingerprint，新版用 screenName
    screen_name = data.get("screenName", data.get("screenFingerprint", layout_key))

    return ScreenLayoutConfig(
        screen_name=screen_name,
        config_name=data.get("configName", data.get("config_name", "")),
        created_at=data.get("createdAt", data.get("created_at", "")),
        terminals=terminals,
        is_preset=data.get("isPreset", False),
        is_default=data.get("isDefault", False),
        layout_id=data.get("layoutId", ""),
    )


def _migrate_screen_layouts(payload: dict, path: Path) -> bool:
    """将旧格式的屏幕布局迁移为新的嵌套结构

    旧格式: {screen_name: {configName, terminals, ...}}
    新格式: {screen_name: {layouts: {__preset__: {..., isPreset: True, isDefault: True}}}}

    Args:
        payload: YAML 文件的完整内容
        path: 文件路径，迁移成功后写回

    Returns:
        是否发生了迁移
    """
    layouts_data = payload.get("screen_layouts", {})
    if not layouts_data or not isinstance(layouts_data, dict):
        return False

    migrated = False
    for screen_name, screen_data in layouts_data.items():
        if not isinstance(screen_data, dict):
            continue
        # 旧格式：有 terminals 但没有 layouts 键
        if "terminals" in screen_data and "layouts" not in screen_data:
            layouts_data[screen_name] = {
                "layouts": {
                    "__preset__": {
                        **screen_data,
                        "isPreset": True,
                        "isDefault": True,
                    }
                }
            }
            migrated = True

    if migrated:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )

    return migrated


def get_screen_layouts(path_value: str = "ui-settings.yaml") -> dict[str, dict[str, ScreenLayoutConfig]]:
    """获取所有屏幕布局配置（嵌套结构）

    加载时自动检测并迁移旧格式数据。

    Args:
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        外层 key 为屏幕名称，内层 key 为 layout_id（如 __preset__、user_xxxx），
        内层 value 为 ScreenLayoutConfig 对象。
        示例: {"H27T13": {"__preset__": ScreenLayoutConfig(...), "user_a1b2": ScreenLayoutConfig(...)}}
    """
    path = _resolve_project_file(path_value)
    payload = _read_yaml_file(path)

    # 自动迁移旧格式
    _migrate_screen_layouts(payload, path)

    layouts_data = payload.get("screen_layouts", {})
    if not layouts_data:
        layouts_data = payload.get("ui", {}).get("screen_layouts", {})

    result: dict[str, dict[str, ScreenLayoutConfig]] = {}
    for screen_name, screen_data in layouts_data.items():
        if not isinstance(screen_data, dict):
            continue
        # 新格式：screen_data 内有 layouts 字典
        inner_layouts = screen_data.get("layouts", {})
        if isinstance(inner_layouts, dict):
            screen_layouts: dict[str, ScreenLayoutConfig] = {}
            for layout_id, layout_data in inner_layouts.items():
                if isinstance(layout_data, dict):
                    layout = _screen_layout_from_dict(screen_name, layout_data)
                    layout.layout_id = layout_id
                    screen_layouts[layout_id] = layout
            if screen_layouts:
                result[screen_name] = screen_layouts

    return result


def get_screen_layout(
    screen_name: str,
    layout_id: str = "__preset__",
    path_value: str = "ui-settings.yaml",
) -> ScreenLayoutConfig | None:
    """获取指定屏幕的指定布局配置

    Args:
        screen_name: 屏幕名称
        layout_id: 布局 ID，默认为 __preset__
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        ScreenLayoutConfig 或 None（如果不存在）
    """
    all_layouts = get_screen_layouts(path_value)
    screen_layouts = all_layouts.get(screen_name, {})
    return screen_layouts.get(layout_id)


def save_screen_layout(
    screen_name: str,
    layout_id: str,
    layout: ScreenLayoutConfig,
    path_value: str = "ui-settings.yaml",
) -> Path:
    """保存屏幕布局配置到新的嵌套结构

    Args:
        screen_name: 屏幕名称
        layout_id: 布局 ID（如 __preset__、user_xxxx）
        layout: 屏幕布局配置对象
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        保存的文件路径
    """
    path = _resolve_project_file(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)

    # 读取现有配置
    payload = _read_yaml_file(path)

    # 自动迁移旧格式
    _migrate_screen_layouts(payload, path)

    # 确保 screen_layouts 字段存在
    if "screen_layouts" not in payload:
        payload["screen_layouts"] = {}

    # 确保屏幕级别的嵌套结构存在
    screen_entry = payload["screen_layouts"].setdefault(screen_name, {})
    if "layouts" not in screen_entry or not isinstance(screen_entry.get("layouts"), dict):
        screen_entry["layouts"] = {}

    # 保存布局（序列化并清理冗余字段）
    layout_dict = layout.to_dict()
    layout_dict.pop("screenName", None)
    layout_dict.pop("screenFingerprint", None)
    payload["screen_layouts"][screen_name]["layouts"][layout_id] = layout_dict

    # 写入文件
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    return path


def delete_screen_layout(
    screen_name: str,
    layout_id: str,
    path_value: str = "ui-settings.yaml",
) -> bool:
    """删除指定屏幕的指定布局

    不能删除屏幕的最后一个布局。如果删除的是默认布局，
    会自动将剩余布局中的第一个标记为默认。

    Args:
        screen_name: 屏幕名称
        layout_id: 布局 ID
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        是否成功删除
    """
    path = _resolve_project_file(path_value)
    payload = _read_yaml_file(path)

    screen_entry = payload.get("screen_layouts", {}).get(screen_name, {})
    inner_layouts = screen_entry.get("layouts", {})

    if layout_id not in inner_layouts:
        return False

    # 不能删除最后一个布局
    if len(inner_layouts) <= 1:
        return False

    # 检查被删的布局是否是默认的
    deleted_is_default = inner_layouts[layout_id].get("isDefault", False)

    del inner_layouts[layout_id]

    # 如果删除的是默认布局，自动将剩余的第一个设为新默认
    if deleted_is_default and inner_layouts:
        first_remaining = next(iter(inner_layouts.values()), None)
        if first_remaining is not None:
            first_remaining["isDefault"] = True

    # 清理空结构
    if not inner_layouts:
        del screen_entry["layouts"]
    if not screen_entry:
        del payload["screen_layouts"][screen_name]
    if not payload["screen_layouts"]:
        del payload["screen_layouts"]

    # 写入文件
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    return True


def set_default_layout(
    screen_name: str,
    layout_id: str,
    path_value: str = "ui-settings.yaml",
) -> bool:
    """将指定布局设为该屏幕的默认布局

    Args:
        screen_name: 屏幕名称
        layout_id: 要设为默认的布局 ID
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        是否设置成功（找不到指定布局时返回 False）
    """
    path = _resolve_project_file(path_value)
    payload = _read_yaml_file(path)

    screen_entry = payload.get("screen_layouts", {}).get(screen_name, {})
    inner_layouts = screen_entry.get("layouts", {})

    if layout_id not in inner_layouts:
        return False

    # 将该屏幕所有布局的 isDefault 设为 False
    for lid in inner_layouts:
        if isinstance(inner_layouts[lid], dict):
            inner_layouts[lid]["isDefault"] = False

    # 将指定布局设为默认
    inner_layouts[layout_id]["isDefault"] = True

    # 写入文件
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    return True


def get_default_layout_for_screen(
    screen_name: str,
    path_value: str = "ui-settings.yaml",
) -> ScreenLayoutConfig | None:
    """获取指定屏幕的默认布局

    优先返回 isDefault=True 的布局，如果没有默认的，返回 __preset__ 布局。

    Args:
        screen_name: 屏幕名称
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        默认的 ScreenLayoutConfig 或 None
    """
    all_layouts = get_screen_layouts(path_value)
    screen_layouts = all_layouts.get(screen_name, {})

    # 优先查找 isDefault=True 的布局
    for layout_id, layout in screen_layouts.items():
        if layout.is_default:
            return layout

    # 没有默认的，返回 __preset__ 布局
    return screen_layouts.get("__preset__")


def ensure_preset_layout(screen_name: str, path_value: str = "ui-settings.yaml") -> bool:
    """确保指定屏幕至少有一个布局，如果没有则创建系统预设

    Args:
        screen_name: 屏幕名称
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        True 表示新创建了 preset，False 表示已存在不需要创建
    """
    all_layouts = get_screen_layouts(path_value)
    screen_layouts = all_layouts.get(screen_name, {})

    # 已有布局（任何布局），不需要创建
    if screen_layouts:
        return False

    # 屏幕没有任何布局，创建预设
    preset = ScreenLayoutConfig(
        screen_name=screen_name,
        config_name="系统预设",
        is_preset=True,
        is_default=True,
        created_at=datetime.now().isoformat(timespec="seconds"),
        terminals={},
    )

    save_screen_layout(screen_name, "__preset__", preset, path_value)
    return True


def get_layout_for_current_screens(path_value: str = "ui-settings.yaml") -> ScreenLayoutConfig | None:
    """获取当前屏幕配置对应的默认布局

    自动获取当前主屏幕名称并查找匹配的默认布局。

    Args:
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        ScreenLayoutConfig 或 None（如果当前屏幕配置没有保存的布局）
    """
    from .display import get_current_screen_config

    config = get_current_screen_config()
    return get_default_layout_for_screen(config.primary_screen_name, path_value)
