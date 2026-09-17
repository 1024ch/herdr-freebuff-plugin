# 发现记录（findings）

> 规则：外部内容（网页、仓库代码摘要）仅写入本文件，不写入 task_plan.md。

## herdr 插件接口规范
- herdr 是 Rust 终端多路复用器（terminal multiplexer for coding agents），本地版本 `herdr 0.9.0`
- 插件 = 目录 + `herdr-plugin.toml` 清单 + 可执行脚本；无 SDK，整个 herdr CLI 就是插件 API
- 清单可声明：`[[panes]]`（终端窗格入口，真实 PTY，可跑交互式 TUI）、`[[actions]]`（动作，无 TTY）、事件钩子（`on` 事件名）、链接处理器
- 动作 id 形如 `plugin.id.action`；`herdr plugin link <path>` 本地链接；`herdr plugin install owner/repo` GitHub 安装；`herdr plugin config-dir <id>` 给插件配置目录
- 事件钩子的 `on` 事件名在 link 时校验，未知事件名会给 warnings
- Socket API：`agent.view.set`（source 用 `plugin:<HERDR_PLUGIN_ID>`）、`plugin.pane.open/focus/close`、`plugin.log.list` 等
- 语义状态为 `working` / `blocked` / `idle` / `done`（integrations 文档：reliable working/blocked/idle/done state from agent hooks or plugins）
- herdr 还有 integrations 机制（OpenCode/Kilo/Hermes 写入 herdr-agent-state 插件上报状态），freebuff 无内置 hook 系统，所以需要外部 watcher
- 文档版本目录：docs/versions/0.9.0（与本地一致）、0.9.1；本地安装路径 /root/.local/bin/herdr

### 状态上报方式（待确认细节）
- 现有插件使用「detached watcher 轮询」+ `herdr pane read` 屏幕刮取 + 向 herdr socket 上报状态

## freebuff 调用方式与状态输出
（待调研）

## 现有插件 TheMetalStorm/herdr-freebuff-plugin 的 bug 分析
### 架构
- 入口：3 个 plugin panes（task / resume-last / resume-named）→ `scripts/launch.sh` exec freebuff
- 状态跟踪：detached watcher（`status-watcher.sh`，700ms 轮询）→ 上报 herdr socket
- 状态源：① 轮询磁盘 `~/.config/manicode/projects/<slug>/chats/<ts>/{chat-messages.json,log.jsonl,chat-meta.json}`；② 文件判定为 working/blocked 时用 `herdr pane read <id> --source visible --lines 80` 屏幕刮取文本模式
- setup 动作把 PATH wrapper 装到 `~/.local/bin/freebuff`，每次调用 freebuff 自动拉起 watcher；另播种 agent-detection override

### 根本性缺陷（两份 DEBUG 文档佐证）
1. **freebuff 回合中途不落盘**：ask_user 弹窗期间 `chat-messages.json` 完全不含 ask_user 块（存在内存），所有 chat 文件只在 `Main prompt finished` 时统一刷新 → 文件轮询天生滞后
2. **屏幕刮取脆弱且竞态**：靠 TUI 文本模式（`Enter select`、`↑↓ navigate`、`Your answer:`+边框、`[response interrupted]`、`• Thinking`）判定状态。freebuff UI 一变就坏；`Your answer:` 框几秒内就被新输出滚出屏幕 → 出现「回答后几秒又卡回 blocked 直到回合结束」的已知 bug（DEBUG_blocked-dismissal.md 末尾 follow-up）
3. **状态判定是启发式补丁叠加**：detect_blocked_screen → detect_screen_state(4 信号) → thinking 心跳，优先级规则越来越复杂，仍存在窗口期错误
4. 700ms 轮询 + 每次 `herdr pane read` 子进程开销（~50ms）

### 结论：重写方向
不应继续「文件轮询+刮屏」路线，应寻找 freebuff 的**权威状态源**（事件流/协议级输出）。待调研：freebuff CLI 是否有 headless/JSON 流式输出模式，或 SDK 事件流。

## freebuff 内部机制（决定性发现，源码+本机日志验证）

### 调用方式（cli-args.ts）
- freebuff 模式 CLI 仅支持：`freebuff`、`freebuff --continue [conversation-id]`、`freebuff --cwd <dir>`、`freebuff login`、`-v`；**无 headless/print 模式**（那是 codebuff 模式的），TUI 是唯一交互界面
- 插件必须用 herdr plugin panes（真实 PTY）启动 freebuff

### 状态数据源（旧插件失效的根因 + 新版行为）
1. **log.jsonl 是同步写**：生产模式 pino destination `sync: true`（logger.ts），每条日志立即落盘 → 近实时时间线
   - 关键日志行（本机 log.jsonl 验证）：`[send-message] Sending message with sdk run config`（回合开始）、`Start agent <agent> step N`（步骤开始）、`End agent ... step N`（步骤结束）、`Main prompt finished`（回合结束，main-prompt.ts:126）、`write_file <path>` 等（每个工具 handler 执行时 logger.debug）
   - **日志行含 pid 字段** → 可把 chat 目录精确绑定到具体 freebuff 进程（多窗格不串台）
2. **checkpoint 已从「回合结束才写」改为「运行中每约 5 秒」**：sdk run.ts `STATE_SNAPSHOT_INTERVAL_MS = 5_000`，定时器在 ask_user 等待期间也持续触发（步骤边界历史变化才真正写）；CLI onStateSnapshot → scheduleCheckpointSave → 异步合并写 run-state.json + chat-messages.json + chat-meta.json（原子写）
   - run-state.json 的 output 字段在 checkpoint 中恒为 `STATE_SNAPSHOT_INTERRUPTION_MESSAGE` 占位错误（getCancelledRunState），**不可用作状态信号**
   - ask_user 期间历史仍会变化（每步边界）→ 未回答的 ask-user 块会在弹窗后 ≤5s 出现在 chat-messages.json 末尾 AI 消息中
   - ask_user：`endsAgentStep = true`，handler 经 AskUserBridge 阻塞等待用户（TUI 弹窗），此后进入新步骤
   - **Inque 答案只能从激活窗格输入** → 非激活窗格的 freebuff 不可能「已回答但未落盘」，多窗格歧义窗口极小
3. **实例所有者**：`~/.config/manicode/freebuff-instance-owner.json` = `{instanceId, pid}`（单实例模型，后者覆盖前者）
4. **数据布局**：`~/.config/manicode/projects/<basename(cwd)>/chats/<ISO时间戳>/`；basename 特殊字符替换为 _；chat-messages.json 是 CLI ChatMessage[]（variant user/ai + blocks），ask-user 块形式：`{type:'ask-user', answers?, skipped?}` 或 `{type:'tool', toolName:'ask_user', input:{questions}}`
5. chat-meta.json：`{messageCount, firstPrompt, messagesSize, messagesMtimeMs}`
6. trace.jsonl 仅 dev 或 CODEBUFF_TRACE=1 才写，不可依赖

### 上报协议（herdr 0.9.0 CLI 实测）
- `herdr pane report-agent <PANE_ID> --source <ID> --agent <LABEL> --state <idle|working|blocked|unknown> [--message TEXT] [--seq N] [--agent-session-id ID] [--agent-session-path PATH]`
- `herdr pane report-agent-session <PANE_ID> --source --agent [--agent-session-id] [--agent-session-path] [--session-start-source]`
- `herdr pane report-metadata <PANE_ID> --source --agent [--display-agent]`
- `herdr notification show <title> --body --sound`
- 插件窗格环境：`HERDR_ENV=1 HERDR_BIN_PATH HERDR_SOCKET_PATH HERDR_PLUGIN_ID HERDR_PLUGIN_ROOT HERDR_PLUGIN_CONFIG_DIR HERDR_PLUGIN_STATE_DIR HERDR_PLUGIN_ENTRYPOINT_ID HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID HERDR_PLUGIN_CONTEXT_JSON`
- agent-detection 覆盖配置放 `$HERDR_PLUGIN_CONFIG_DIR/agent-detection/<name>.toml`：`[[agent]] name/match_cmdline/alt_cmdline`

## 新插件设计方案（fix 旧插件全部已知问题）
1. **watcher 用 Node 单文件**（freebuff 本身依赖 node/bun 生态，node 可用性等同 freebuff），事件驱动 + 短轮询兜底，不再 700ms 多进程 shell+node
2. **log.jsonl 增量 tail（字节偏移）为主要信号**：同步落盘 → 近实时；`Main prompt finished`/`Start agent step`/`[send-message]` 判定 working/idle
3. **pid 绑定**：log 行 `"pid":<PID>` 匹配自家 freebuff 进程 → 精确归属 chat 目录，**修复旧插件 find_newest_chat 全局取最新的多窗格串台 bug**
4. **blocked 数据权威**：chat-messages.json checkpoint（≤5s）末 AI 消息含未回答 ask-user → blocked；旧插件「回合中途不落盘」前提在新版已不成立
5. **屏幕刮取降级为辅助**：仅用于 (a) blocked 提前确认（等待数据落盘期间，匹配 Enter select/↑↓ navigate 提前量约 0-5s）；(b) working 停滞心跳。UI 文案改版最多损失提前量，不再导致状态机全坏
6. **working 停滞保护**：log 停止增长且 checkpoint 停止更新 >25s → 心跳检查；ask-user 等待超 120s 且屏幕确认 → blocked 兜底
7. **会话上报**：report-agent-session 带 chatId/chatDir，支持 herdr 恢复
8. **launch.sh 直接拉起 watcher**（exec 前后台化，`$$` 即 freebuff 未来 PID），不依赖 PATH wrapper；保留可选 setup 安装 wrapper 供手动场景
9. 状态变化才上报（seq 单调递增，启动初始化）

## 本地环境信息
- herdr 0.9.0（stable，protocol 22），server 运行中，/root/.local/bin/herdr
- freebuff 0.0.175（linux-x64），/root/.local/bin/freebuff
- node v24.19.0（/usr/local/node/bin/node）、bun 1.3.14、python3 可用
- 本机真实 chat 数据：~/.config/manicode/projects/{freebuff_herdr_plugin,root}/chats/*（含当前会话，log.jsonl 含 pid 字段已验证）
- ~/.config/manicode/freebuff-instance-owner.json 存在（instanceId+pid）
- 本机 chats 无 ask-user 块样本（解析逻辑按源码 schema 实现，测试用构造 fixture）
