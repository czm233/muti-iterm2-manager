from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml


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

    def to_dict(self) -> dict[str, float | int]:
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
    target_screen: int = -1  # -1 表示"跟随当前/不指定"，0 表示屏幕1，1 表示屏幕2...


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
        target_screen=int(os.getenv("MITERM_TARGET_SCREEN", "-1")),
    )
