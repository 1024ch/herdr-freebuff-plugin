#!/bin/sh
# Freebuff herdr 插件共享辅助函数。
# 被 launch/setup/notify 脚本 source；在 herdr 外调用时安全降级（no-op）。

: "${HERDR_BIN_PATH:=herdr}"
HERDR="$HERDR_BIN_PATH"
PANE_ID="${HERDR_PANE_ID:-}"

# 插件根目录：herdr 为动作注入该变量；直接调用时回退到脚本自身位置。
: "${HERDR_PLUGIN_ROOT:=$(cd "$(dirname "$0")/.." && pwd)}"

# 是否运行在 herdr 托管窗格内。
in_herdr() { [ "${HERDR_ENV:-}" = "1" ]; }

# 把 freebuff 的 agent-detection 覆盖配置播种到 herdr 插件配置目录（一次）。
# herdr 会加载 $HERDR_PLUGIN_CONFIG_DIR/agent-detection/ 下的本地覆盖，
# 使侧边栏把 freebuff 进程识别为 agent（显示名称、状态徽标）。
ensure_agent_detection() {
  if ! in_herdr; then return 0; fi
  src="${HERDR_PLUGIN_ROOT}/config/agent-detection/freebuff.toml"
  if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ] && [ -f "$src" ]; then
    dest_dir="${HERDR_PLUGIN_CONFIG_DIR}/agent-detection"
    mkdir -p "$dest_dir" 2>/dev/null
    dest="${dest_dir}/freebuff.toml"
    if [ ! -f "$dest" ] || ! cmp -s "$src" "$dest"; then
      cp "$src" "$dest" 2>/dev/null
    fi
  fi
}
