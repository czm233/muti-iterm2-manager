#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/.run/multi-iterm2-manager.pid"
LOG_FILE="$ROOT_DIR/.run/multi-iterm2-manager.log"
mkdir -p "$ROOT_DIR/.run"

cd "$ROOT_DIR"

if [[ ! -d .venv ]]; then
  echo "错误：未找到 .venv，请先在项目根目录安装依赖。"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "发现旧服务进程 $old_pid，先停止它。"
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

lsof -ti :8765 | xargs -r kill 2>/dev/null || true
sleep 1

source .venv/bin/activate

nohup env MITERM_BACKEND=iterm2 python -m multi_iterm2_manager >"$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"

for _ in {1..30}; do
  health_json="$(curl -fsS http://127.0.0.1:8765/api/health 2>/dev/null || true)"
  if [[ -n "$health_json" ]]; then
    if python3 -c 'import json,sys; obj=json.loads(sys.argv[1]); raise SystemExit(0 if obj.get("ok") and obj.get("itermReady") else 1)' "$health_json"; then
      echo "服务已启动： http://127.0.0.1:8765"
      echo "PID: $new_pid"
      echo "日志: $LOG_FILE"
      echo "提示：系统会保留一个 iTerm 窗口作为 Python API 锚点，请不要手动关闭全部 iTerm 窗口。"
      exit 0
    fi
  fi
  sleep 1
done

echo "服务启动超时，请查看日志：$LOG_FILE"
exit 1
