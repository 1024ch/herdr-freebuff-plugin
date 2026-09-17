#!/bin/sh
# 发送 herdr 通知（"完成后提醒我" 辅助动作）。
# 用法: notify.sh [标题] [正文]
. "$(dirname "$0")/common.sh"

title="${1:-Freebuff}"
body="${2:-}"

if ! in_herdr; then
  echo "notify.sh 必须在 herdr 窗格内运行（HERDR_ENV=1）" >&2
  exit 1
fi

"$HERDR" notification show "$title" --body "$body" --sound request
