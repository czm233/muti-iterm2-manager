from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from multi_iterm2_manager.models import (
    TerminalFrame,
    TerminalHandle,
    TerminalProgramInfo,
    TerminalRecord,
    TerminalStatus,
)


class TerminalStateStore:
    """Small JSON-backed cache for fast terminal restoration on restart."""

    SCHEMA_VERSION = 1

    def __init__(self, path: Path) -> None:
        self.path = path

    @classmethod
    def default(cls) -> "TerminalStateStore":
        env_path = os.getenv("MITERM_TERMINAL_STATE_FILE", "").strip()
        if env_path:
            return cls(Path(env_path).expanduser())
        root = Path(__file__).resolve().parent.parent.parent
        return cls(root / ".run" / "terminal-state.json")

    def load(self) -> list[TerminalRecord]:
        if not self.path.is_file():
            return []
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return []
        if not isinstance(payload, dict):
            return []
        items = payload.get("terminals", [])
        if not isinstance(items, list):
            return []

        records: list[TerminalRecord] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            record = self._record_from_dict(item)
            if record is not None and record.status != TerminalStatus.closed:
                records.append(record)
        return records

    def save(self, records: Iterable[TerminalRecord]) -> None:
        active_records = [
            self._record_to_dict(record)
            for record in records
            if record.status != TerminalStatus.closed
        ]
        payload = {
            "schemaVersion": self.SCHEMA_VERSION,
            "savedAt": datetime.now().isoformat(timespec="seconds"),
            "terminals": active_records,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_name(f"{self.path.name}.tmp")
        tmp_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        tmp_path.replace(self.path)

    @classmethod
    def _record_to_dict(cls, record: TerminalRecord) -> dict[str, Any]:
        return {
            "id": record.id,
            "name": record.name,
            "handle": {
                "windowId": record.handle.window_id,
                "sessionId": record.handle.session_id,
                "tabId": record.handle.tab_id,
            },
            "command": record.command,
            "profile": record.profile,
            "status": record.status.value,
            "summary": record.summary,
            "screenText": record.screen_text,
            "screenHtml": record.screen_html,
            "frame": record.frame.to_dict() if record.frame else None,
            "markers": list(record.markers),
            "updatedAt": record.updated_at,
            "cwd": record.cwd,
            "hidden": record.hidden,
            "muted": record.muted,
            "tags": list(record.tags),
            "isPrimary": record.is_primary,
            "program": record.program.to_dict(),
            "contentHash": record.content_hash,
            "contentStableSince": record.content_stable_since,
            "aiSummary": record.ai_summary,
            "aiSummaryAt": record.ai_summary_at,
            "aiSummaryStatus": record.ai_summary_status,
            "aiSummaryReason": record.ai_summary_reason,
            "aiSummaryErrorDetail": record.ai_summary_error_detail,
            "aiSummaryFirst": record.ai_summary_first,
            "lastInteractionAt": record.last_interaction_at,
            "interactionContentHash": record.interaction_content_hash,
        }

    @classmethod
    def _record_from_dict(cls, data: dict[str, Any]) -> TerminalRecord | None:
        handle_data = data.get("handle")
        if not isinstance(handle_data, dict):
            handle_data = data

        session_id = cls._str_value(handle_data.get("sessionId") or handle_data.get("session_id"))
        window_id = cls._str_value(handle_data.get("windowId") or handle_data.get("window_id"))
        if not session_id or not window_id:
            return None

        terminal_id = cls._str_value(data.get("id")) or f"restored-{session_id}"
        status = cls._status_value(data.get("status"))
        screen_text = cls._str_value(data.get("screenText")) or ""
        content_hash = cls._str_value(data.get("contentHash")) or ""
        if screen_text and not content_hash:
            import hashlib

            content_hash = hashlib.md5(screen_text.encode()).hexdigest()

        program_data = data.get("program")
        program = TerminalProgramInfo()
        if isinstance(program_data, dict):
            program = TerminalProgramInfo(
                key=cls._str_value(program_data.get("key")) or "unknown",
                label=cls._str_value(program_data.get("label")) or "Unknown",
                source=cls._str_value(program_data.get("source")) or "none",
                pid=cls._int_value(program_data.get("pid")),
                command_line=cls._str_value(program_data.get("commandLine")),
            )

        return TerminalRecord(
            id=terminal_id,
            name=cls._str_value(data.get("name")) or terminal_id,
            handle=TerminalHandle(
                window_id=window_id,
                session_id=session_id,
                tab_id=cls._str_value(handle_data.get("tabId") or handle_data.get("tab_id")),
            ),
            command=cls._str_value(data.get("command")),
            profile=cls._str_value(data.get("profile")),
            status=status,
            summary=cls._str_value(data.get("summary")) or "",
            screen_text=screen_text,
            screen_html=cls._str_value(data.get("screenHtml")) or "",
            frame=cls._frame_value(data.get("frame")),
            markers=cls._str_list(data.get("markers")),
            updated_at=cls._str_value(data.get("updatedAt")) or datetime.now().isoformat(timespec="seconds"),
            is_live=False,
            last_error=None,
            cwd=cls._str_value(data.get("cwd")),
            hidden=bool(data.get("hidden")),
            muted=bool(data.get("muted")),
            tags=cls._str_list(data.get("tags")),
            is_primary=bool(data.get("isPrimary")),
            program=program,
            content_hash=content_hash,
            content_stable_since=cls._float_value(data.get("contentStableSince"), time.time() if screen_text else 0.0),
            ai_summary=cls._str_value(data.get("aiSummary")) or "",
            ai_summary_at=cls._float_value(data.get("aiSummaryAt"), 0.0),
            ai_summary_status=cls._str_value(data.get("aiSummaryStatus")) or "none",
            ai_summary_reason=cls._str_value(data.get("aiSummaryReason")) or "",
            ai_summary_error_detail=cls._str_value(data.get("aiSummaryErrorDetail")) or "",
            ai_summary_first=bool(data.get("aiSummaryFirst", True)),
            last_interaction_at=cls._float_value(data.get("lastInteractionAt"), 0.0),
            interaction_content_hash=cls._str_value(data.get("interactionContentHash")) or "",
        )

    @staticmethod
    def _status_value(value: object) -> TerminalStatus:
        try:
            return TerminalStatus(str(value))
        except Exception:
            return TerminalStatus.idle

    @staticmethod
    def _frame_value(value: object) -> TerminalFrame | None:
        if not isinstance(value, dict):
            return None
        try:
            return TerminalFrame(
                x=float(value.get("x", 0.0)),
                y=float(value.get("y", 0.0)),
                width=float(value.get("width", 0.0)),
                height=float(value.get("height", 0.0)),
            )
        except Exception:
            return None

    @staticmethod
    def _str_value(value: object) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return str(value)

    @staticmethod
    def _str_list(value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item) for item in value if item is not None]

    @staticmethod
    def _float_value(value: object, default: float) -> float:
        if value is None or isinstance(value, bool):
            return default
        try:
            return float(value)
        except Exception:
            return default

    @staticmethod
    def _int_value(value: object) -> int | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            return int(value)
        except Exception:
            return None
