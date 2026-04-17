#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/multi-iterm2-manager.pid"
LOG_FILE="$RUN_DIR/multi-iterm2-manager.log"
STATUS_FILE="$RUN_DIR/start-status.txt"
SAFE_FLAG="$RUN_DIR/safe-restart"
START_LOCK_DIR="$RUN_DIR/start.lock"
START_LOCK_PID_FILE="$START_LOCK_DIR/pid"
PORT=8765
STOP_TIMEOUT_SEC=8
KILL_TIMEOUT_SEC=2
PORT_RELEASE_TIMEOUT_SEC=3
HEALTH_TIMEOUT_SEC=30
LOG_TAIL_LINES=40
START_STATUS_REPORTED=0

mkdir -p "$RUN_DIR"
cd "$ROOT_DIR"

cleanup_start_lock() {
  rm -rf "$START_LOCK_DIR"
}

write_status_file() {
  local state="$1"
  local message="$2"
  {
    echo "status=$state"
    echo "time=$(date '+%Y-%m-%d %H:%M:%S')"
    echo "message=$message"
  } > "$STATUS_FILE"
}

cleanup_stale_pid_file() {
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
    fi
  fi
}

show_log_tail() {
  if [[ -f "$LOG_FILE" ]]; then
    echo "最近日志（$LOG_FILE，最后 ${LOG_TAIL_LINES} 行）:"
    tail -n "$LOG_TAIL_LINES" "$LOG_FILE"
  else
    echo "日志文件不存在：$LOG_FILE"
  fi
}

fail_start() {
  local message="$1"
  local show_logs="${2:-1}"
  START_STATUS_REPORTED=1
  cleanup_stale_pid_file
  write_status_file "failed" "$message"
  echo
  echo "================ 启动失败 ================"
  echo "$message"
  if [[ "$show_logs" == "1" ]]; then
    echo
    show_log_tail
  fi
  echo
  echo "结论：这次没有启动成功。"
  echo "只有看到“启动成功”区块，才算真正启动完成。"
  exit 1
}

report_success() {
  local pid="$1"
  local health_json="$2"
  START_STATUS_REPORTED=1
  write_status_file "success" "服务已启动，PID=$pid"
  echo
  echo "================ 启动成功 ================"
  echo "服务地址: http://127.0.0.1:${PORT}"
  echo "PID: $pid"
  echo "日志: $LOG_FILE"
  echo "健康检查: $health_json"
  echo "提示：只有看到这一段，才算真正重启成功。"
  echo "如需完整清理环境请运行 ./stop.sh"
  exit 0
}

on_exit() {
  local rc="$1"
  cleanup_start_lock
  if [[ "$rc" != "0" && "$START_STATUS_REPORTED" == "0" ]]; then
    cleanup_stale_pid_file
    write_status_file "failed" "脚本异常退出，退出码=$rc"
    echo
    echo "================ 启动失败 ================"
    echo "脚本异常退出，退出码: $rc"
    echo
    show_log_tail
    echo
    echo "结论：这次没有启动成功。"
    echo "只有看到“启动成功”区块，才算真正启动完成。"
  fi
}

if [[ ! -d .venv ]]; then
  fail_start "未找到 .venv，请先在项目根目录安装依赖。" 0
fi

pid_exists() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

acquire_start_lock() {
  local lock_pid=""
  if mkdir "$START_LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$START_LOCK_PID_FILE"
    return 0
  fi

  if [[ -f "$START_LOCK_PID_FILE" ]]; then
    lock_pid="$(cat "$START_LOCK_PID_FILE" 2>/dev/null || true)"
  fi

  if [[ -n "$lock_pid" ]] && pid_exists "$lock_pid"; then
    fail_start "已有一个 start.sh 正在执行，请稍后再试。锁进程 PID: $lock_pid" 0
  fi

  rm -rf "$START_LOCK_DIR"
  if mkdir "$START_LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$START_LOCK_PID_FILE"
    return 0
  fi

  fail_start "无法获取启动锁，请稍后重试。" 0
}

pid_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null | sed -n '1p'
}

pid_cwd() {
  local pid="$1"
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ { sub(/^n/, ""); print; exit }'
}

is_project_service_pid() {
  local pid="$1"
  local cmd cwd
  pid_exists "$pid" || return 1
  cmd="$(pid_command "$pid")"
  [[ -n "$cmd" && "$cmd" == *"multi_iterm2_manager"* ]] || return 1
  cwd="$(pid_cwd "$pid")"
  [[ -n "$cwd" && "$cwd" == "$ROOT_DIR" ]] || return 1
}

describe_pid() {
  local pid="$1"
  local cmd cwd
  cmd="$(pid_command "$pid")"
  cwd="$(pid_cwd "$pid")"
  echo "PID: $pid"
  if [[ -n "$cmd" ]]; then
    echo "命令: $cmd"
  fi
  if [[ -n "$cwd" ]]; then
    echo "工作目录: $cwd"
  fi
}

wait_for_pid_exit() {
  local pid="$1"
  local timeout_sec="$2"
  local deadline=$((SECONDS + timeout_sec))
  while pid_exists "$pid"; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.25
  done
  return 0
}

listener_pids() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
}

wait_for_port_release() {
  local timeout_sec="$1"
  local deadline=$((SECONDS + timeout_sec))
  while [[ -n "$(listener_pids)" ]]; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.25
  done
  return 0
}

safe_stop_pid() {
  local pid="$1"
  local reason="$2"
  echo "$reason"
  kill "$pid" 2>/dev/null || true
  if wait_for_pid_exit "$pid" "$STOP_TIMEOUT_SEC"; then
    return 0
  fi
  echo "进程 $pid 未在 ${STOP_TIMEOUT_SEC} 秒内退出，强制终止。"
  kill -9 "$pid" 2>/dev/null || true
  if wait_for_pid_exit "$pid" "$KILL_TIMEOUT_SEC"; then
    return 0
  fi
  echo "无法停止进程 $pid。"
  describe_pid "$pid"
  fail_start "旧服务进程无法停止，已中止本次启动。" 0
}

fail_for_external_port_owner() {
  local pid="$1"
  echo "端口 $PORT 已被其他进程占用，未执行 kill。"
  describe_pid "$pid"
  fail_start "端口 $PORT 已被其他进程占用，本次没有启动任何新服务。" 0
}

trap 'on_exit $?' EXIT

acquire_start_lock
write_status_file "starting" "正在启动服务"

# 安全重启：创建标志文件，让旧进程 shutdown 时跳过 iTerm2 清理
touch "$SAFE_FLAG"

old_pid=""
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
fi

if [[ -n "$old_pid" ]]; then
  if pid_exists "$old_pid"; then
    if is_project_service_pid "$old_pid"; then
      safe_stop_pid "$old_pid" "发现旧服务进程 $old_pid，安全停止（不关闭 iTerm2）。"
    else
      echo "PID 文件指向的进程 $old_pid 仍在运行，但它不是当前项目服务，已忽略。"
      describe_pid "$old_pid"
    fi
  fi
  rm -f "$PID_FILE"
fi

port_pids_raw="$(listener_pids)"
if [[ -n "$port_pids_raw" ]]; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if is_project_service_pid "$pid"; then
      safe_stop_pid "$pid" "发现占用端口 $PORT 的孤儿服务进程 $pid，安全停止（不关闭 iTerm2）。"
    else
      fail_for_external_port_owner "$pid"
    fi
  done <<< "$port_pids_raw"
fi

if ! wait_for_port_release "$PORT_RELEASE_TIMEOUT_SEC"; then
  port_pids_raw="$(listener_pids)"
  if [[ -n "$port_pids_raw" ]]; then
    first_pid="$(printf '%s\n' "$port_pids_raw" | sed -n '1p')"
    if [[ -n "$first_pid" ]]; then
      fail_for_external_port_owner "$first_pid"
    fi
  fi
  fail_start "端口 $PORT 未在 ${PORT_RELEASE_TIMEOUT_SEC} 秒内释放。" 0
fi

source .venv/bin/activate

# 新进程也设置环境变量，启动时跳过清理
nohup env MITERM_BACKEND=iterm2 MITERM_SAFE_RESTART=1 python -m multi_iterm2_manager >"$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"

deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  if ! pid_exists "$new_pid"; then
    fail_start "服务进程 $new_pid 已退出。" 1
  fi

  health_json="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  if [[ -n "$health_json" ]]; then
    if python3 -c 'import json,sys; obj=json.loads(sys.argv[1]); raise SystemExit(0 if obj.get("ok") and obj.get("itermReady") else 1)' "$health_json"; then
      report_success "$new_pid" "$health_json"
    fi
  fi
  sleep 1
done

fail_start "服务启动超时（${HEALTH_TIMEOUT_SEC} 秒内未通过健康检查）。" 1
