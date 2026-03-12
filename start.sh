#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/.run/multi-iterm2-manager.pid"
LOG_FILE="$ROOT_DIR/.run/multi-iterm2-manager.log"
SAFE_FLAG="$ROOT_DIR/.run/safe-restart"
mkdir -p "$ROOT_DIR/.run"

cd "$ROOT_DIR"

if [[ ! -d .venv ]]; then
  echo "错误：未找到 .venv，请先在项目根目录安装依赖。"
  exit 1
fi

# 安全重启：创建标志文件，让旧进程 shutdown 时跳过 iTerm2 清理
touch "$SAFE_FLAG"

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "发现旧服务进程 $old_pid，安全停止（不关闭 iTerm2）。"
    kill "$old_pid" 2>/dev/null || true
    # 轮询等待旧进程退出，最多 5 秒
    waited=0
    while kill -0 "$old_pid" 2>/dev/null && (( waited < 10 )); do
      sleep 0.5
      (( waited++ ))
    done
    # 5 秒后仍未退出则强制杀死
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "旧进程未在 5 秒内退出，强制终止。"
      kill -9 "$old_pid" 2>/dev/null || true
      sleep 0.5
    fi
  fi
  rm -f "$PID_FILE"
fi

# 确保端口也释放
lsof -ti :8765 | xargs kill 2>/dev/null || true
sleep 0.5

source .venv/bin/activate

# 新进程也设置环境变量，启动时跳过清理
nohup env MITERM_BACKEND=iterm2 MITERM_SAFE_RESTART=1 python -m multi_iterm2_manager >"$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"

for _ in {1..30}; do
  health_json="$(curl -fsS http://127.0.0.1:8765/api/health 2>/dev/null || true)"
  if [[ -n "$health_json" ]]; then
    if python3 -c 'import json,sys; obj=json.loads(sys.argv[1]); raise SystemExit(0 if obj.get("ok") and obj.get("itermReady") else 1)' "$health_json"; then
      echo "服务已启动（安全模式）： http://127.0.0.1:8765"
      echo "PID: $new_pid"
      echo "日志: $LOG_FILE"
      echo "提示：iTerm2 窗口已保留。如需完整清理环境请运行 ./stop.sh"
      exit 0
    fi
  fi
  sleep 1
done

echo "服务启动超时，请查看日志：$LOG_FILE"
exit 1
