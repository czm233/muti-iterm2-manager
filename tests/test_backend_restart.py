from __future__ import annotations

import sys

import pytest

from multi_iterm2_manager import server


def test_spawn_backend_restart_starts_project_script_detached(tmp_path, monkeypatch) -> None:
    start_script = tmp_path / "start.sh"
    start_script.write_text("#!/usr/bin/env zsh\n", encoding="utf-8")
    start_script.chmod(0o755)
    popen_calls: list[tuple[list[str], dict]] = []

    class FakePopen:
        pid = 4242

        def __init__(self, args, **kwargs) -> None:
            popen_calls.append((args, kwargs))

    monkeypatch.setattr(server, "_project_root", lambda: tmp_path)
    monkeypatch.setattr(server.subprocess, "Popen", FakePopen)

    result = server._spawn_backend_restart(delay_seconds=0.01)

    assert result == {"restartPid": 4242, "log": str(tmp_path / ".run" / "restart-via-ui.log")}
    assert len(popen_calls) == 1
    args, kwargs = popen_calls[0]
    assert args[0:2] == [sys.executable, "-c"]
    assert args[-2:] == [str(tmp_path), str(start_script)]
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["env"]["MITERM_RESTART_SOURCE"] == "web-ui"
    assert kwargs["stderr"] == server.subprocess.STDOUT
    assert kwargs["start_new_session"] is True
    assert kwargs["close_fds"] is True
    assert "restart requested from web UI" in (tmp_path / ".run" / "restart-via-ui.log").read_text(encoding="utf-8")


def test_spawn_backend_restart_requires_start_script(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(server, "_project_root", lambda: tmp_path)

    with pytest.raises(FileNotFoundError):
        server._spawn_backend_restart(delay_seconds=0.01)
