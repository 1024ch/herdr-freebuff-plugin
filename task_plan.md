# 任务计划：重写 herdr-freebuff 插件

## 目标
在当前目录重写一个插件，使 herdr 能够：
1. 准确跟踪 freebuff 的运行状态（现有插件 github.com/TheMetalStorm/herdr-freebuff-plugin 存在此 bug）
2. 正确调用 freebuff

## 背景
- 现有插件 `TheMetalStorm/herdr-freebuff-plugin` 对 [herdr](https://github.com/herdrdev/herdr) 中使用 [freebuff](https://github.com/CodebuffAI/freebuff) 存在 bug：不能准确跟踪 freebuff 运行状态
- herdr 和 freebuff 本地已安装

## 阶段

### 阶段1：调研 herdr 的插件接口规范 `complete`
- [x] 克隆/查看 herdr 仓库源码
- [x] 找到插件加载/注册机制（herdr-plugin.toml + panes/actions + report-agent API）
- [x] 找到 herdr 如何跟踪 agent/进程状态（pane report-agent --state idle|working|blocked|unknown）
- [x] 记录插件必须实现的接口（详见 findings.md）

### 阶段2：调研 freebuff 的调用方式与状态输出 `complete`
- [x] 查看 freebuff 仓库源码与 CLI（仅 --continue/--cwd/login，无 headless）
- [x] 确定调用入口：plugin pane PTY 启动 TUI
- [x] 确定状态暴露：log.jsonl 同步写 + run-state/messages 每≈5s checkpoint + instance-owner(pid)

### 阶段3：分析现有插件 herdr-freebuff-plugin 的 bug `complete`
- [x] 克隆/查看源码 + 两份 DEBUG 文档
- [x] 定位根本原因：旧版「回合中途不落盘」+ TUI 刮屏脆弱 + find_newest_chat 多窗格串台
- [x] 记录 bug 清单与新版行为差异（findings.md）

### 阶段4：验证本地环境 `complete`
- [x] herdr 0.9.0 server 运行中；freebuff 0.0.175；node v24.19.0 可用
- [x] 本机真实 chat 数据验证：log.jsonl 同步落盘、含 pid；checkpoint ≈5s；instance-owner.json

### 阶段5：设计并重写插件 `complete`
- [x] 设计状态跟踪方案（findings.md「新插件设计方案」）
- [x] 实现插件：清单 + watcher(node) + launch/setup/notify/common + agent-detection + README/LICENSE
- [x] 实现 pid 绑定与 log tail 状态机（含 Esc 悬空块屏幕仲裁、checkpoint mtime 竞态守卫、回答后自动解除 blocked）

### 阶段6：测试验证 `complete`
- [x] 单元/冒烟测试 9/9 通过（herdr stub + fixture 数据目录，3 次稳定）
- [x] herdr plugin link 加载成功无警告；窗格启动验证 agent=freebuff status=idle
- [x] 端到端：发送 prompt → working 持续跟踪；watcher 退出无孤儿进程

### 收尾
- [x] 更新 progress.md；向用户总结

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| （暂无） | | |

## 决策记录
- 2026-09-16: 任务启动，规划文件已创建
