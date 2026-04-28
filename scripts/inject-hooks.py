#!/usr/bin/env python3
"""向所有 Claude Code 环境的 settings.json 注入 hook-status 回调。

将 Stop 和 UserPromptSubmit 事件的通知注入到：
- ~/.claude
- ~/.claude-glm
- ~/.claude-glm51
- ~/.claude-glmt5t

幂等：已注入过（命令包含 hook-status）则跳过。
"""

from __future__ import annotations

import json
from pathlib import Path

# 要注入的 Claude 环境目录名
CLAUDE_DIRS = [
    ".claude",
    ".claude-glm",
    ".claude-glm51",
    ".claude-glmt5t",
]

# Hook 服务器地址
HOOK_PORT = 8765

# 注入的 hook 条目
HOOK_ENTRIES = {
    "Stop": {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": (
                    f"curl -s -X POST http://localhost:{HOOK_PORT}/api/terminals/hook-status"
                    " -d '{\"iterm_session_id\":\"'$ITERM_SESSION_ID'\",\"status\":\"done\"}' &"
                ),
            }
        ],
    },
    "UserPromptSubmit": {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": (
                    f"curl -s -X POST http://localhost:{HOOK_PORT}/api/terminals/hook-status"
                    " -d '{\"iterm_session_id\":\"'$ITERM_SESSION_ID'\",\"status\":\"running\"}' &"
                ),
            }
        ],
    },
}

# 幂等检测关键词
IDEMPOTENT_KEYWORD = "hook-status"


def _has_hook_already(settings: dict, event: str) -> bool:
    """检查指定事件是否已包含 hook-status 命令"""
    hooks_section = settings.get("hooks", {})
    entries = hooks_section.get(event, [])
    for entry in entries:
        for hook in entry.get("hooks", []):
            cmd = hook.get("command", "")
            if IDEMPOTENT_KEYWORD in cmd:
                return True
    return False


def _inject_event(settings: dict, event: str, entry: dict) -> bool:
    """向指定事件注入 hook 条目，已存在则跳过。返回是否实际注入了。"""
    if _has_hook_already(settings, event):
        return False
    if "hooks" not in settings:
        settings["hooks"] = {}
    if event not in settings["hooks"]:
        settings["hooks"][event] = []
    settings["hooks"][event].append(entry)
    return True


def inject_for_dir(base_path: Path) -> str:
    """对单个 Claude 环境目录执行注入。返回结果描述。"""
    settings_file = base_path / "settings.json"
    if not base_path.is_dir():
        return "跳过（目录不存在）"

    # 读取或初始化 settings.json
    settings: dict = {}
    if settings_file.exists():
        try:
            settings = json.loads(settings_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            return f"跳过（读取失败: {exc}）"
        if not isinstance(settings, dict):
            return "跳过（settings.json 不是 JSON 对象）"

    injected = []
    skipped = []
    for event, entry in HOOK_ENTRIES.items():
        if _inject_event(settings, event, entry):
            injected.append(event)
        else:
            skipped.append(event)

    if not injected:
        return f"无需注入（{', '.join(skipped)} 已存在）"

    # 写回文件
    try:
        settings_file.write_text(
            json.dumps(settings, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        return f"失败（写入失败: {exc}）"

    return f"已注入: {', '.join(injected)}" + (
        f"；跳过: {', '.join(skipped)}" if skipped else ""
    )


def main() -> None:
    home = Path.home()
    print("=== Hook 注入工具 ===\n")

    for dirname in CLAUDE_DIRS:
        base_path = home / dirname
        label = f"~/{dirname}"
        result = inject_for_dir(base_path)
        print(f"  {label}: {result}")

    print("\n注入完成。")


if __name__ == "__main__":
    main()
