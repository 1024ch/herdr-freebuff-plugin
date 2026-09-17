#!/bin/sh
# 在 herdr 插件 PANE 中启动 Freebuff。
#
# herdr 把插件窗格入口作为窗格自身的 PTY 进程运行，freebuff 拿到真实 TTY，
# 其交互式 TUI 可正常工作（动作/CLI 无 TTY，无法启动交互式 agent —— 这就是
# 用窗格而不是动作的原因）。
#
# 与旧版的关键差异：本脚本直接拉起状态监视器（不再依赖 setup 安装的
# PATH wrapper），开箱即用；watcher 以 freebuff 的实际 PID 绑定其数据目录，
# 多窗格互不干扰。
#
# 用法: launch.sh <task|resume-last> [conversation-id]

mode="${1:-task}"
name="$2"

. "$(dirname "$0")/common.sh"

ensure_agent_detection

# 解析真实 freebuff 二进制。
FREEBUFF_BIN="${FREEBUFF_BIN_PATH:-}"
if [ -z "$FREEBUFF_BIN" ]; then
  FREEBUFF_BIN=$(command -v freebuff 2>/dev/null)
fi
if [ -z "$FREEBUFF_BIN" ] || [ ! -x "$FREEBUFF_BIN" ]; then
  echo "未找到 freebuff 可执行文件（需要 freebuff 在 PATH 中）" >&2
  exit 1
fi

NODE_BIN=$(command -v node 2>/dev/null)
WATCHER="${HERDR_PLUGIN_ROOT}/scripts/status-watcher.js"

# 启动函数：先确定 freebuff 的 PID，再拉起 watcher，最后 exec freebuff。
# 做法：exec 前用子 shell 把自身 PID 即未来 freebuff 的 PID 传给 watcher。
# （exec 替换进程映像后 PID 不变。）
start_watcher() {
  [ -n "$NODE_BIN" ] || return 0
  [ -f "$WATCHER" ] || return 0
  if in_herdr && [ -n "$PANE_ID" ]; then
    # $$ = 当前 shell 的 PID；exec 后 freebuff 继承该 PID
    "$NODE_BIN" "$WATCHER" "$$" "$PANE_ID" >/dev/null 2>&1 &
  fi
}

case "$mode" in
  task)
    start_watcher
    exec "$FREEBUFF_BIN"
    ;;
  resume-last)
    start_watcher
    exec "$FREEBUFF_BIN" --continue
    ;;
  resume-named)
    if [ -z "$name" ]; then
      name=$(printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" 2>/dev/null \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(j.conversation_id||j.session_id||"")}catch{}})' 2>/dev/null)
    fi
    if [ -z "$name" ]; then
      echo "resume-named 需要一个会话 id（参数或上下文）" >&2
      exit 1
    fi
    start_watcher
    exec "$FREEBUFF_BIN" --continue "$name"
    ;;
  *)
    echo "未知启动模式: $mode" >&2
    exit 1
    ;;
esac
