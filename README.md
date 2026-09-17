# herdr-freebuff-plugin（重写版）

prompts  
```text-plain

对话交互、文档、代码注释使用中文

/planning-with-files-zh

已知github.com/TheMetalStorm/herdr-freebuff-plugin的实现对[herdr](https://github.com/herdrdev/herdr)中使用[freebuff](https://github.com/CodebuffAI/freebuff)存在bug，不能准确的跟踪freebuff运行状态，请在当前目录重写一个插件，要求支持herdr支持跟踪freebuff运行状态和调用freebuff，herdr和freebuff本地已安装

```

让 [Freebuff](https://freebuff.com) 成为 [Herdr](https://herdr.dev) 中的一等公民 agent：**准确的生命周期状态跟踪** + 窗格启动 + 会话上报。

本插件是 [TheMetalStorm/herdr-freebuff-plugin](https://github.com/TheMetalStorm/herdr-freebuff-plugin) 的重写版，修复了其状态跟踪不准的根本缺陷。

## 与旧版的关键差异

| 维度             | 旧版（shell watcher）                                 | 本版（node watcher）                                                   |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| 主要信号         | 700ms 轮询磁盘文件（freebuff 旧版只在回合结束才落盘） | **增量 tail `log.jsonl`**（pino `sync:true` 同步落盘，近实时）         |
| blocked 判定     | 屏幕刮取 TUI 文案（脆弱，UI 一改就坏）                | **checkpoint 数据权威**（`chat-messages.json` 每≈5s 落盘），屏幕仅辅助 |
| 多窗格归属       | 全局取最新 mtime 的 chat 目录（**串台 bug**）         | **pid 绑定**：`/proc/<pid>/fd` 反查 + 日志行 pid 校验                  |
| 回答后卡 blocked | 已知 bug（`Your answer:` 滚出屏幕后状态机卡死）       | 数据驱动：回答触发新回合/新步骤行 → 自动解除，checkpoint 仲裁自愈      |
| Esc 中断         | 屏幕刮取 `[response interrupted]`                     | 屏幕仲裁悬空 ask_user 块（数据+屏幕双源一致性检查）                    |
| 开箱即用         | 需先运行 setup 安装 PATH wrapper                      | 窗格入口直接拉起 watcher；setup 仅可选（手动 `freebuff` 场景）         |
| 进程模型         | 每 700ms 起多个 shell/node 子进程                     | 常驻 node 进程，事件驱动 + 500ms 轻轮询                                |

## 状态判定逻辑

```
blockedKnown（checkpoint 数据 + 屏幕仲裁）
  > turnActive（log.jsonl 时间线：回合开始/结束、步骤行）
    > idle
```

| 状态      | 数据信号（权威）                                       | 屏幕信号（辅助）                        |
| --------- | ------------------------------------------------------ | --------------------------------------- |
| `working` | `[send-message]`（回合开始）、`Start agent ... step N` | `• Thinking` 心跳（停滞保护用）         |
| `blocked` | `chat-messages.json` 末尾 AI 消息含未回答 ask_user 块  | `Enter select` / `↑↓ navigate` 弹窗提示 |
| `idle`    | `Main prompt finished`（回合结束）                     | —                                       |
| `unknown` | watcher 退出 / freebuff 进程消失                       | —                                       |

数据源（freebuff 0.0.175 验证）：

- `~/.config/manicode/projects/<basename(cwd)>/chats/<chatId>/log.jsonl` —— 同步落盘的事件时间线（每行含 `pid`）
- 同目录 `chat-messages.json` / `run-state.json` —— SDK 每约 5s 步骤边界 checkpoint（原子写）
- `~/.config/manicode/freebuff-instance-owner.json` —— 当前实例 `{instanceId, pid}`

## 安装

```bash
herdr plugin link /path/to/this-plugin
herdr plugin action invoke freebuff.integration.setup   # 可选：agent-detection + PATH wrapper
```

或从 GitHub：

```bash
herdr plugin install <owner>/herdr-freebuff-plugin
```

## 使用

打开插件窗格：

```bash
herdr plugin pane open --plugin freebuff.integration --entrypoint task
herdr plugin pane open --plugin freebuff.integration --entrypoint resume-last
```

快捷键绑定（`~/.config/herdr/config.toml`）：

```toml
[[keys.command]]
key = "prefix+f"
type = "plugin_pane"
command = "freebuff.integration.task"
description = "Freebuff: 新任务"
```

发送通知：

```bash
herdr plugin action invoke freebuff.integration.notify "构建完成" "api 工作区"
```

## 文件

| 文件                                   | 职责                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `herdr-plugin.toml`                    | 清单：窗格入口（task / resume-last）、setup / notify 动作   |
| `scripts/status-watcher.js`            | 核心：pid 绑定 + log 增量 tail + checkpoint 仲裁 + 状态上报 |
| `scripts/launch.sh`                    | 窗格入口：拉起 watcher 后 exec freebuff                     |
| `scripts/setup.sh`                     | 可选安装：agent-detection 播种 + PATH wrapper               |
| `scripts/common.sh`                    | 共享辅助（环境封装、agent-detection 播种）                  |
| `scripts/notify.sh`                    | herdr 通知动作                                              |
| `config/agent-detection/freebuff.toml` | 侧边栏 agent 识别覆盖                                       |
| `tests/test-watcher.sh`                | watcher 冒烟测试（herdr stub，9 断言）                      |

## 环境变量（watcher 调试/测试）

| 变量                                                     | 说明                                                |
| -------------------------------------------------------- | --------------------------------------------------- |
| `FREEBUFF_WATCHER_DEBUG=1`                               | 调试日志到 stderr                                   |
| `FREEBUFF_CONFIG_DIR`                                    | 覆盖 freebuff 配置目录（默认 `~/.config/manicode`） |
| `FREEBUFF_WATCHER_POLL_MS` / `_STALE_MS` / `_CONFIRM_MS` | 轮询/停滞阈值覆写（测试用）                         |

## 已知边界

- 非激活窗格无法回答 ask_user（freebuff 限制），watcher 会持续显示 blocked 直到窗格被聚焦
- `run-state.json` 的 `output` 字段是 checkpoint 占位错误，不作为状态信号
- macOS 无 `/proc`：目录解析退化为「pid 匹配的最新日志扫描」，仍按 pid 隔离不串台
- freebuff 大版本更改日志格式/文件布局时需同步更新本插件（所有模式串在 `status-watcher.js` 顶部注释中列明）

## License

MIT —— 见 [LICENSE](LICENSE)。
