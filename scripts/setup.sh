#!/bin/sh
# Freebuff herdr 集成安装/卸载。
#
# 1) 播种 agent-detection 覆盖（侧边栏把 freebuff 识别为 agent）
# 2) 可选安装 PATH wrapper 到 ~/.local/bin/freebuff：
#    用户在任意 herdr 窗格手动输入 `freebuff` 时也能自动拉起状态监视器。
#    （插件窗格入口 launch.sh 已内置 watcher，不依赖 wrapper。）
#
# 用法: setup.sh [--uninstall] [--help]

set -e
. "$(dirname "$0")/common.sh"

WRAPPER_DEST="${HOME}/.local/bin/freebuff"

install_wrapper() {
  mkdir -p "$(dirname "$WRAPPER_DEST")"

  # 生成 wrapper：把真实 freebuff 二进制路径写死进去，避免 wrapper 递归
  real=$(command -v freebuff 2>/dev/null || true)
  if [ -z "$real" ]; then
    echo "未找到 freebuff，跳过 wrapper 安装" >&2
    return 0
  fi
  NODE_BIN=$(command -v node 2>/dev/null || true)
  WATCHER="${HERDR_PLUGIN_ROOT}/scripts/status-watcher.js"

  {
    echo '#!/bin/sh'
    echo '# Freebuff herdr 生命周期包装器（由 freebuff.integration setup 生成）'
    echo "REAL=\"$real\""
    echo "NODE=\"$NODE_BIN\""
    echo "WATCHER=\"$WATCHER\""
    echo 'if [ -n "${HERDR_ENV:-}" ] && [ -n "${HERDR_PANE_ID:-}" ] && [ -x "$NODE" ] && [ -f "$WATCHER" ]; then'
    echo '  "$NODE" "$WATCHER" "$$" "$HERDR_PANE_ID" >/dev/null 2>&1 &'
    echo 'fi'
    echo 'exec "$REAL" "$@"'
  } > "$WRAPPER_DEST"
  chmod +x "$WRAPPER_DEST"
  echo "已安装生命周期 wrapper: $WRAPPER_DEST"

  case ":${PATH}:" in
    *:"${HOME}/.local/bin":*) ;;
    *) echo "警告: ${HOME}/.local/bin 不在 PATH 中，请加入 shell 配置" >&2 ;;
  esac
}

uninstall_wrapper() {
  if [ -f "$WRAPPER_DEST" ]; then
    # 安全检查：只删除我们生成的 wrapper（含标记注释）
    if grep -q "freebuff.integration setup" "$WRAPPER_DEST" 2>/dev/null; then
      rm -f "$WRAPPER_DEST"
      echo "已移除 wrapper: $WRAPPER_DEST"
    else
      echo "$WRAPPER_DEST 不是本插件生成的 wrapper，未删除" >&2
    fi
  else
    echo "未发现 wrapper: $WRAPPER_DEST"
  fi
}

case "${1:-}" in
  --uninstall)
    uninstall_wrapper
    ;;
  --help)
    echo "用法: setup.sh [--uninstall]"
    echo "  （无参数）安装 freebuff -> herdr 集成（agent-detection + PATH wrapper）"
    echo "  --uninstall  移除 PATH wrapper（agent-detection 配置保留）"
    exit 0
    ;;
  *)
    ensure_agent_detection
    install_wrapper
    echo "Freebuff <-> Herdr 集成就绪。"
    ;;
esac
