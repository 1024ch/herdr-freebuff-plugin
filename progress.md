# 进度日志（progress）

## 会话 2026-09-16/17

- [x] 加载 planning-with-files-zh 技能，创建规划文件
- [x] 阶段1-4：调研 herdr / freebuff / 旧插件 / 本地环境（详见 findings.md）
- [x] 阶段5：重写插件
  - `herdr-plugin.toml`（panes: task/resume-last; actions: setup/notify）
  - `scripts/status-watcher.js`（核心 watcher，node 实现）
  - `scripts/launch.sh` / `setup.sh` / `notify.sh` / `common.sh`
  - `config/agent-detection/freebuff.toml`、`README.md`、`LICENSE`
- [x] 阶段6：测试验证
  - `tests/test-watcher.sh`：9 断言（herdr stub + fixture 数据目录），3 次运行全部通过
  - `herdr plugin link` 加载成功，无 warnings
  - 端到端：窗格 wR:p3 显示 agent=freebuff status=idle；发送 prompt → working 跟踪 12s+
  - watcher 退出无孤儿进程

## 收尾

- [x] 更新任务计划与进度日志
- 最终验证：测试 9/9 通过（连续 3 次）；插件链接无警告；窗格启动为 `agent=freebuff status=idle`；发送 prompt 后持续跟踪为 `working`；watcher 退出无孤儿进程。
- 2026-09-17：按请求重新运行 `bash tests/test-watcher.sh`，结果为通过 9、失败 0。
- 2026-09-17：追加完成 `bash -n scripts/*.sh` 与 `node --check scripts/status-watcher.js`，语法检查通过。

## 遇到的错误与解决

| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| 测试中 watcher 立即上报 unknown | 1 | 测试用了不存在的 pid 424242；改用真实 `sleep 300 &` 进程 |
| watcher 启动即退出、无任何上报 | 1 | `setTimeout(...).unref()` 导致 Node 事件循环空转退出；移除 unref |
| 悬空 ask_user + 空屏幕被误判 blocked | 1 | pane read 失败与空画面未区分；readPaneText 改为 cb(ok, text)，空画面=无弹窗 |
| 回答后 step 行未解除 blocked | 1 | handleLogLine 的 step 分支未置 turnActive=true；补上 |
| 测试4 屏幕弹窗不生效 | 1 | HERDR_STUB_PANE_FILE 在 watcher 启动后才 export；改为启动前导出空文件、测试时写入内容 |
| 测试5 卡 blocked | 1 | fixture 不真实（回答后弹窗仍在屏幕上）；按现实时序清空 pane 文件 |
| checkpoint 屏幕仲裁竞态 | 1 | 回调返回时 checkpoint mtime 已变；加 evalMtime 守卫丢弃陈旧仲裁 |

## 关键决策

- 数据主导（log tail + checkpoint）+ 屏幕仅辅助，放弃旧插件「刮屏为主」路线
- Node 单进程 watcher 替代 shell 多进程轮询（freebuff 依赖 node 生态，可用性等同）
- pid 绑定（/proc fd + 日志行 pid 校验）解决多窗格串台
- launch.sh 直接拉 watcher，PATH wrapper 降级为可选

## 产物

```
/opt/workspaces/freebuff_herdr_plugin/
├── herdr-plugin.toml
├── README.md
├── LICENSE
├── config/agent-detection/freebuff.toml
├── scripts/{status-watcher.js,launch.sh,setup.sh,notify.sh,common.sh}
└── tests/test-watcher.sh
```
