from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .models import ScreenLayoutConfig, TerminalLayout


@dataclass
class UiSettings:
    dashboard_padding_px: int = 4
    dashboard_gap_px: int = 6
    monitor_grid_gap_px: int = 6
    wall_card_padding_px: int = 10
    wall_card_border_radius_px: int = 22
    wall_card_border_width_px: float = 1.0
    wall_card_terminal_border_width_px: float = 1.0
    split_resizer_hit_area_px: int = 14
    split_resizer_line_width_px: int = 2
    grid_resizer_hit_area_px: int = 16
    grid_resizer_line_width_px: int = 2
    # 屏幕设置
    target_screen: int = -1  # -1 表示"跟随当前/不指定"，0 表示屏幕1，1 表示屏幕2...
    # 默认窗口位置模板（None 表示使用 build_maximized_frame 生成）
    default_frame_x: float | None = None
    default_frame_y: float | None = None
    default_frame_width: float | None = None
    default_frame_height: float | None = None

    def to_dict(self) -> dict[str, float | int | None]:
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

    defaults = UiSettings()
    values: dict[str, Any] = {}
    for field_name in defaults.to_dict():
        if field_name in ui_payload:
            values[field_name] = ui_payload[field_name]
    return UiSettings(**values)


def save_ui_settings(path_value: str, ui_settings: UiSettings) -> Path:
    path = _resolve_project_file(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ui": {
            "dashboard_padding_px": ui_settings.dashboard_padding_px,
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
            # 屏幕设置
            "target_screen": ui_settings.target_screen,
            # 默认窗口位置模板
            "default_frame_x": ui_settings.default_frame_x,
            "default_frame_y": ui_settings.default_frame_y,
            "default_frame_width": ui_settings.default_frame_width,
            "default_frame_height": ui_settings.default_frame_height,
        }
    }
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
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


def _screen_layout_from_dict(fingerprint: str, data: dict[str, Any]) -> ScreenLayoutConfig:
    """从字典创建 ScreenLayoutConfig 对象"""
    terminals: dict[str, TerminalLayout] = {}
    terminals_data = data.get("terminals", {})
    for tid, tdata in terminals_data.items():
        terminals[tid] = _terminal_layout_from_dict(tid, tdata)

    return ScreenLayoutConfig(
        screen_fingerprint=fingerprint,
        config_name=data.get("configName", data.get("config_name", "")),
        created_at=data.get("createdAt", data.get("created_at", "")),
        terminals=terminals,
    )


def get_screen_layouts(path_value: str = "ui-settings.yaml") -> dict[str, ScreenLayoutConfig]:
    """获取所有屏幕布局配置

    Args:
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        指纹 -> ScreenLayoutConfig 的字典
    """
    path = _resolve_project_file(path_value)
    payload = _read_yaml_file(path)

    # 兼容两种结构：直接的 screen_layouts 字段，或嵌套在 ui 下的
    layouts_data = payload.get("screen_layouts", {})
    if not layouts_data:
        ui_data = payload.get("ui", {})
        layouts_data = ui_data.get("screen_layouts", {})

    result: dict[str, ScreenLayoutConfig] = {}
    for fingerprint, data in layouts_data.items():
        if isinstance(data, dict):
            result[fingerprint] = _screen_layout_from_dict(fingerprint, data)

    return result


def get_screen_layout(fingerprint: str, path_value: str = "ui-settings.yaml") -> ScreenLayoutConfig | None:
    """获取指定指纹的屏幕布局配置

    Args:
        fingerprint: 屏幕配置指纹 (8位)
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        ScreenLayoutConfig 或 None（如果不存在）
    """
    layouts = get_screen_layouts(path_value)
    return layouts.get(fingerprint)


def save_screen_layout(
    fingerprint: str,
    layout: ScreenLayoutConfig,
    path_value: str = "ui-settings.yaml"
) -> Path:
    """保存屏幕布局配置

    Args:
        fingerprint: 屏幕配置指纹 (8位)
        layout: 屏幕布局配置对象
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        保存的文件路径
    """
    path = _resolve_project_file(path_value)
    path.parent.mkdir(parents=True, exist_ok=True)

    # 读取现有配置
    payload = _read_yaml_file(path)

    # 确保 screen_layouts 字段存在
    if "screen_layouts" not in payload:
        payload["screen_layouts"] = {}

    # 保存布局（使用简化的键名格式，方便阅读）
    layout_dict = layout.to_dict()
    # 移除冗余的 screenFingerprint 字段（因为键已经是 fingerprint）
    layout_dict.pop("screenFingerprint", None)
    payload["screen_layouts"][fingerprint] = layout_dict

    # 写入文件
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    return path


def delete_screen_layout(fingerprint: str, path_value: str = "ui-settings.yaml") -> bool:
    """删除屏幕布局配置

    Args:
        fingerprint: 屏幕配置指纹 (8位)
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        是否成功删除
    """
    path = _resolve_project_file(path_value)
    payload = _read_yaml_file(path)

    layouts = payload.get("screen_layouts", {})
    if fingerprint not in layouts:
        return False

    del layouts[fingerprint]

    # 如果布局为空，删除整个字段
    if not layouts:
        del payload["screen_layouts"]

    # 写入文件
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )

    return True


def get_layout_for_current_screens(path_value: str = "ui-settings.yaml") -> ScreenLayoutConfig | None:
    """获取当前屏幕配置对应的布局

    自动获取当前屏幕指纹并查找匹配的布局配置。

    Args:
        path_value: 配置文件路径，默认为 ui-settings.yaml

    Returns:
        ScreenLayoutConfig 或 None（如果当前屏幕配置没有保存的布局）
    """
    from .display import generate_screen_fingerprint

    fingerprint = generate_screen_fingerprint()
    return get_screen_layout(fingerprint, path_value)
