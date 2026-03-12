#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/.run/multi-iterm2-manager.pid"
LOG_FILE="$ROOT_DIR/.run/multi-iterm2-manager.log"
SAFE_FLAG="$ROOT_DIR/.run/safe-restart"
FULL_CLEANUP_FLAG="$ROOT_DIR/.run/full-cleanup"

cd "$ROOT_DIR"

# 完整停止：删除安全标志 + 创建 full-cleanup 标志，让 shutdown 执行完整清理
rm -f "$SAFE_FLAG"
mkdir -p "$ROOT_DIR/.run"
touch "$FULL_CLEANUP_FLAG"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "停止服务进程 $pid（将执行完整清理，关闭受管终端）。"
    kill "$pid" 2>/dev/null || true
    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
      echo "进程未响应，强制终止。"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

lsof -ti :8765 | xargs kill 2>/dev/null || true
sleep 1

if [[ -d .venv ]]; then
  source .venv/bin/activate
  python - <<'PY'
import asyncio
from multi_iterm2_manager.backend.iterm2_backend import ITerm2Backend

async def main():
    backend = ITerm2Backend(connect_retries=2, retry_delay=0.5)
    try:
        await backend.start()
        count = await backend.cleanup_managed_terminals()
        await backend.maybe_quit_app()
        print(f"已清理托管 iTerm 会话：{count}")
    except Exception as exc:
        print(f"清理托管会话时出现提示：{exc}")
    finally:
        await backend.stop()

asyncio.run(main())
PY
fi

echo "服务已停止。"
echo "如需查看上次日志：$LOG_FILE"
