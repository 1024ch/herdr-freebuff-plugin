#!/bin/sh
# status-watcher.js 单元冒烟测试（无真实 herdr 依赖：herdr 用 stub 替代）。
#
# 运行: sh tests/test-watcher.sh

set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WATCHER="$HERE/../scripts/status-watcher.js"

PASS=0
FAIL=0

assert_eq() {
  desc="$1"; expected="$2"; actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
    echo "  期望: $expected"
    echo "  实际: $actual"
  fi
}

FIX=$(mktemp -d)
PROJ="$FIX/manicode/projects/myproj"
CHAT="$PROJ/chats/chat-1"
mkdir -p "$CHAT"

# ---------- herdr stub：记录 report-agent 调用，回应 pane read ----------
STUB="$FIX/herdr-stub.sh"
cat > "$STUB" <<'EOF'
#!/bin/sh
LOG="${HERDR_STUB_LOG:?}"
echo "$*" >> "$LOG"
case "$1 $2 $3" in
  "pane read"*) cat "${HERDR_STUB_PANE_FILE:-/dev/null}" 2>/dev/null ;;
esac
exit 0
EOF
chmod +x "$STUB"

# ---------- 用真实存活进程充当 freebuff（watcher 会检查 pid 存活） ----------
sleep 300 &
FREEBUFF_PID_TEST=$!

write_log() {
  msg="$1"; ts="${2:-2026-09-17T04:00:00.000Z}"
  printf '{"level":"INFO","timestamp":"%s","pid":%s,"msg":"%s"}\n' \
    "$ts" "$FREEBUFF_PID_TEST" "$msg" >> "$CHAT/log.jsonl"
}

last_states() {
  grep -o '\-\-state [a-z]*' "$FIX/calls.log" 2>/dev/null \
    | awk '{print $2}' | tail -n "${1:-10}"
}

cleanup() {
  kill "$FREEBUFF_PID_TEST" 2>/dev/null
  rm -rf "$FIX"
}
trap cleanup EXIT

# ============ 测试 1：启动 → idle；回合开始 → working；结束 → idle ============
rm -f "$FIX/calls.log"
: > "$FIX/pane.txt" # 空 pane 文件（stub 从启动时就指向它，后续可写内容）
export FREEBUFF_CONFIG_DIR="$FIX/manicode"
export HERDR_ENV=1 HERDR_PANE_ID=pane-9 HERDR_BIN_PATH="$STUB"
export HERDR_STUB_LOG="$FIX/calls.log"
export HERDR_STUB_PANE_FILE="$FIX/pane.txt"
export FREEBUFF_WATCHER_POLL_MS=50 FREEBUFF_WATCHER_STALE_MS=400 FREEBUFF_WATCHER_CONFIRM_MS=100

node "$WATCHER" "$FREEBUFF_PID_TEST" pane-9 >/dev/null 2>&1 &
WPID=$!
sleep 0.8

# watcher 启动时日志为空 → 初始 idle
assert_eq "启动后上报 idle" "idle" "$(last_states 3 | head -1)"

write_log "[send-message] Sending message with sdk run config"
sleep 0.7
assert_eq "回合开始后上报 working" "working" "$(last_states 2 | tail -1)"

write_log "Main prompt finished"
sleep 0.7
assert_eq "回合结束后上报 idle" "idle" "$(last_states 2 | tail -1)"

# ============ 测试 2：pid 隔离（其他进程的日志不影响状态） ============
printf '{"level":"INFO","timestamp":"2026-09-17T04:01:00.000Z","pid":999999,"msg":"[send-message] Sending message with sdk run config"}\n' >> "$CHAT/log.jsonl"
sleep 0.6
assert_eq "其他 pid 的回合开始不改变状态" "idle" "$(last_states 2 | tail -1)"

# ============ 测试 3：checkpoint 悬空 ask_user + 屏幕无弹窗 → 不 blocked ============
node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify([
 {variant:"user",content:"hi"},
 {variant:"ai",blocks:[{type:"tool",toolName:"ask_user",input:{questions:[{question:"选一个",options:[{label:"A"},{label:"B"}]}]}}]}
]))
' "$CHAT/chat-messages.json"
sleep 1.0
assert_eq "悬空 ask_user 块 + 屏幕无弹窗 → 不 blocked" "idle" "$(last_states 2 | tail -1)"

# ============ 测试 4：屏幕弹窗可见 → blocked ============
printf '╭─ Some questions for you ─╮\n ○ 选项A\n ○ 选项B\n ↑↓ navigate • Enter select\n' > "$FIX/pane.txt"
touch "$CHAT/chat-messages.json" # mtime 变化触发重新仲裁
sleep 1.2
assert_eq "屏幕弹窗可见 → blocked" "blocked" "$(last_states 2 | tail -1)"

# ============ 测试 5：回答后新 step 行 → 解除 blocked 转 working ============
# 现实时序：用户回答 → 弹窗从屏幕消失 → 新步骤开始
: > "$FIX/pane.txt"
write_log "Start agent base3 step 2"
sleep 0.8
assert_eq "回答后新步骤行解除 blocked" "working" "$(last_states 2 | tail -1)"

# ============ 测试 6：回合结束 → idle；会话上报存在 ============
write_log "Main prompt finished"
sleep 0.7
assert_eq "最终 idle" "idle" "$(last_states 2 | tail -1)"

grep -q "report-agent-session" "$FIX/calls.log"
assert_eq "已上报会话标识" "0" "$?"

kill "$WPID" 2>/dev/null
wait "$WPID" 2>/dev/null

echo
echo "通过: $PASS  失败: $FAIL"
[ "$FAIL" = "0" ]
