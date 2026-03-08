from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    backend: str = "auto"
    demo_layout_columns: int = 2
    demo_layout_rows: int = 2


def load_settings() -> Settings:
    return Settings(
        host=os.getenv("MITERM_HOST", "127.0.0.1"),
        port=int(os.getenv("MITERM_PORT", "8765")),
        backend=os.getenv("MITERM_BACKEND", "auto").lower(),
        demo_layout_columns=int(os.getenv("MITERM_DEMO_COLUMNS", "2")),
        demo_layout_rows=int(os.getenv("MITERM_DEMO_ROWS", "2")),
    )
