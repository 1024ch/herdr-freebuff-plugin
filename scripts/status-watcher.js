#!/usr/bin/env node
/**
 * Freebuff -> Herdr 生命周期状态监视器（重写版）
 *
 * 相比旧版 shell watcher 的核心改进（详见 findings.md）：
 *
 * 1. pid 绑定归属：freebuff 把日志写入
 *    <configDir>/projects/<basename(cwd)>/chats/<chatId>/log.jsonl，
 *    每行 JSON 含 "pid" 字段。Linux 下优先用 /proc/<pid>/fd 反查当前 chat
 *    目录（精确），并校验行内 pid —— 修复旧版「全局取最新 mtime 目录」的
 *    多窗格串台 bug。macOS 等无 /proc 平台退化为「pid 匹配的最新日志」扫描。
 *
 * 2. log.jsonl 为主要信号源：freebuff 生产模式用 pino sync:true 同步落盘，
 *    近实时；按字节偏移增量读取。
 *      - 回合开始: "[send-message] Sending message with sdk run config"
 *      - 回合结束: "Main prompt finished"
 *
 * 3. blocked 由 checkpoint 数据权威判定：SDK 每约 5 秒在步骤边界触发
 *    onStateSnapshot，CLI 异步合并写 run-state.json / chat-messages.json，
 *    ask_user 等待期间定时器仍在运行 → 未回答的 ask-user 块会在弹窗后
 *    ≤5s 落盘（旧插件「回合中途完全不落盘」的前提在当前版本已不成立）。
 *    唯一歧义是「回合被 Esc 中断后遗留的悬空 ask_user 块」，用屏幕仲裁：
 *    弹窗可见才算 blocked，否则按 idle 处理（每次 checkpoint 变更仲裁一次）。
 *
 * 4. working 停滞保护：日志与 checkpoint 同时静止超过阈值时，
 *    用屏幕内容仲裁（弹窗 → blocked；出现中断标记 → idle；
 *    画面持续不变且无处理指示 → idle），避免 LLM 长思考被误判。
 *
 * 5. 状态推导为纯函数：blockedKnown > turnActive(working) > idle，
 *    变化时才上报；watcher 退出时上报 unknown 释放 herdr 侧权威。
 *
 * 用法: status-watcher.js <freebuff_pid> <pane_id>
 * 环境变量:
 *   HERDR_ENV=1 / HERDR_PANE_ID / HERDR_BIN_PATH   herdr 窗格内自动注入
 *   FREEBUFF_CONFIG_DIR                            自定义 freebuff 配置目录
 *   FREEBUFF_WATCHER_DEBUG=1                       调试日志到 stderr
 *   FREEBUFF_WATCHER_POLL_MS / _STALE_MS / _CONFIRM_MS   测试用覆写
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

/* ----------------------------- 配置常量 ----------------------------- */

const POLL_INTERVAL_MS = Number(process.env.FREEBUFF_WATCHER_POLL_MS || 500)
const STALE_WORKING_MS = Number(process.env.FREEBUFF_WATCHER_STALE_MS || 25_000)
const STALE_CHECK_EVERY_MS = Number(
  process.env.FREEBUFF_WATCHER_CONFIRM_MS || 10_000,
)
const SCREEN_LINES = 60
const CHECKPOINT_TAIL_BYTES = 24 * 1024 * 1024 // 超大转录只读尾部
const LOG_TAIL_BYTES = 4096 // pid 扫描回退时读取的日志尾部

function getConfigDir() {
  if (process.env.FREEBUFF_CONFIG_DIR) return process.env.FREEBUFF_CONFIG_DIR
  return path.join(os.homedir(), '.config', 'manicode')
}

/* ----------------------------- 调试日志 ----------------------------- */

const DEBUG = process.env.FREEBUFF_WATCHER_DEBUG === '1'
function debug(...args) {
  if (DEBUG) {
    process.stderr.write(
      `[freebuff-watcher ${new Date().toISOString()}] ${args.map(String).join(' ')}\n`,
    )
  }
}

/* --------------------------- herdr CLI 封装 -------------------------- */

const HERDR_BIN = process.env.HERDR_BIN_PATH || 'herdr'
const HERDR_ENV = process.env.HERDR_ENV === '1'
const FREEBUFF_PID = Number(process.argv[2] || 0)
const PANE_ID = process.argv[3] || process.env.HERDR_PANE_ID || ''

let seq = 0
function nextSeq() {
  if (seq === 0) seq = Date.now() * 1000
  return ++seq
}

/** 上报 agent 生命周期状态（仅在状态变化时调用） */
function report(state, message) {
  if (!HERDR_ENV || !PANE_ID) return
  const args = [
    'pane', 'report-agent', PANE_ID,
    '--source', 'freebuff',
    '--agent', 'freebuff',
    '--state', state,
    '--seq', String(nextSeq()),
  ]
  if (message) args.push('--message', message.slice(0, 500))
  execFile(HERDR_BIN, args, (err) => {
    if (err) debug('report-agent 失败:', err.message)
  })
  debug('上报状态:', state, message || '')
}

/** 上报会话标识（chat 目录），供 herdr 侧恢复/展示 */
function reportSession(chatId, chatDir) {
  if (!HERDR_ENV || !PANE_ID) return
  const args = [
    'pane', 'report-agent-session', PANE_ID,
    '--source', 'freebuff',
    '--agent', 'freebuff',
    '--seq', String(nextSeq()),
  ]
  if (chatId) args.push('--agent-session-id', chatId)
  if (chatDir) args.push('--agent-session-path', chatDir)
  execFile(HERDR_BIN, args, (err) => {
    if (err) debug('report-agent-session 失败:', err.message)
  })
}

/** 读取窗格可见文本；cb(ok, text) —— ok=false 表示读取失败，text 可为空 */
function readPaneText(cb) {
  if (!HERDR_ENV || !PANE_ID) return cb(false, '')
  execFile(
    HERDR_BIN,
    ['pane', 'read', PANE_ID, '--source', 'visible', '--lines', String(SCREEN_LINES)],
    { maxBuffer: 1024 * 1024 },
    (err, stdout) => cb(!err, err ? '' : String(stdout || '')),
  )
}

/* ----------------------- freebuff 数据目录定位 ----------------------- */

/** 项目数据目录根：<configDir>/projects */
function projectsRoot() {
  return path.join(getConfigDir(), 'projects')
}

/** Linux：通过 freebuff 进程打开的 fd 反查当前 chat 目录（精确） */
function chatDirByProcFd() {
  try {
    const root = projectsRoot()
    const fds = fs.readdirSync(`/proc/${FREEBUFF_PID}/fd`)
    let best = ''
    let bestM = 0
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`/proc/${FREEBUFF_PID}/fd/${fd}`)
        // fd 目标形如 <root>/<project>/chats/<chatId>/<file>，
        // chat 目录 = .../chats/<chatId>（两层深，需校验 'chats' 段）
        if (!target.startsWith(root + path.sep)) continue
        const segs = target.slice(root.length + 1).split(path.sep)
        if (segs.length < 4 || segs[1] !== 'chats') continue
        const dir = path.join(root, segs[0], 'chats', segs[2])
        const st = fs.statSync(dir)
        if (st.mtimeMs > bestM) {
          bestM = st.mtimeMs
          best = dir
        }
      } catch { /* fd 竞争消失，忽略 */ }
    }
    return best
  } catch {
    return '' // /proc 不可用（macOS）
  }
}

/**
 * 回退（macOS/无 /proc）：在所有项目的最新 chat 里找日志尾部含本 pid 的目录。
 * 免 /proc 但仍按 pid 隔离，不会串台。
 */
function chatDirByPidScan() {
  let best = ''
  try {
    const root = projectsRoot()
    const projects = fs.readdirSync(root)
    for (const proj of projects) {
      const chatsDir = path.join(root, proj, 'chats')
      let names = []
      try { names = fs.readdirSync(chatsDir) } catch { continue }
      // 本项目内按 mtime 取最新几个候选检查
      const stats = []
      for (const name of names) {
        const full = path.join(chatsDir, name)
        try {
          const st = fs.statSync(full)
          if (st.isDirectory()) stats.push({ full, m: st.mtimeMs })
        } catch { /* 忽略 */ }
      }
      stats.sort((a, b) => b.m - a.m)
      for (const cand of stats.slice(0, 3)) {
        if (logTailHasPid(cand.full)) return cand.full
        if (!best) best = cand.full // 记住最新的作为最后兜底
      }
    }
  } catch { /* 目录不存在 */ }
  return best
}

/** 读取日志尾部判断是否由本 freebuff 进程写入 */
function logTailHasPid(chatDir) {
  const p = path.join(chatDir, 'log.jsonl')
  let st
  try { st = fs.statSync(p) } catch { return false }
  const start = Math.max(0, st.size - LOG_TAIL_BYTES)
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const text = buf.toString('utf8')
      return text.includes(`"pid":${FREEBUFF_PID}`)
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

/** 解析当前 chat 目录：优先 /proc fd，其次 pid 扫描 */
function resolveChatDir() {
  return chatDirByProcFd() || chatDirByPidScan()
}

/* ------------------------------ 状态推导 ------------------------------ */

// 派生状态: blockedKnown ? 'blocked' : turnActive ? 'working' : 'idle'
let reportedState = ''
let turnActive = false
let blockedKnown = false

function deriveAndReport(message) {
  const next = blockedKnown ? 'blocked' : turnActive ? 'working' : 'idle'
  if (next !== reportedState) {
    reportedState = next
    report(next, message || null)
  }
}

/* --------------------------- log.jsonl 增量 tail --------------------------- */

// chatDir -> { offset, lineBuf }
const tailers = new Map()

/** 增量读取 log.jsonl 新增行；返回是否有新增 */
function tailLog(chatDir) {
  const logPath = path.join(chatDir, 'log.jsonl')
  let st
  try { st = fs.statSync(logPath) } catch { return false }

  let t = tailers.get(chatDir)
  if (!t) {
    // 首次绑定：从文件头回放。旧行的 pid 属于旧进程会被过滤；
    // 新进程的行能重建 turnActive（watcher 途中重启也能恢复正确状态）。
    t = { offset: 0, lineBuf: '' }
    tailers.set(chatDir, t)
  }
  if (st.size < t.offset) { t.offset = 0; t.lineBuf = '' } // 截断/轮转
  if (st.size === t.offset) return false

  let hadNew = false
  let fd
  try {
    fd = fs.openSync(logPath, 'r')
    const buf = Buffer.alloc(st.size - t.offset)
    fs.readSync(fd, buf, 0, buf.length, t.offset)
    t.offset = st.size
    const chunk = t.lineBuf + buf.toString('utf8')
    const lines = chunk.split('\n')
    t.lineBuf = lines.pop() || '' // 半行留待下次
    for (const line of lines) {
      if (line.trim()) { hadNew = true; handleLogLine(line) }
    }
    return hadNew
  } catch {
    return false
  } finally {
    if (fd) { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
  }
}

/** 解析单条日志行，驱动状态标志 */
function handleLogLine(line) {
  let msg = ''
  let pid = 0
  try {
    const j = JSON.parse(line)
    msg = String(j.msg || '')
    pid = Number(j.pid || 0)
  } catch { return }

  // pid 校验：只认本 freebuff 进程写的行（多窗格隔离核心）
  if (pid && pid !== FREEBUFF_PID) return

  lastActivityMs = Date.now()

  if (msg.startsWith('[send-message] Sending message')) {
    turnActive = true
    // 新回合开始 = 用户刚做出操作，任何待定的问题状态已解决
    // （回答 ask_user 会触发新回合或后续步骤）
    blockedKnown = false
    return
  }
  if (msg === 'Main prompt finished') {
    turnActive = false
    return
  }
  if (msg.startsWith('Start agent ') && / step \d+/.test(msg)) {
    // 步骤开始：turn 处于活跃状态（每步边界都会打印）。
    // ask_user 结束当前步骤；下一个 step 行只在用户回答后才出现：
    // blocked 期间出现 step 行 = 用户已回答 → 解除 blocked 并回到 working。
    // （若误判，下一次 checkpoint 仲裁会自动恢复 blocked —— 自愈。）
    turnActive = true
    blockedKnown = false
    return
  }
  // 其余行（工具日志等）只刷新活跃时间
}

/* ---------------------- checkpoint 数据 → blocked 判定 ---------------------- */

// checkpoint 仲裁记录: { mtimeMs, adjudicated } —— mtime 变了才重新仲裁
let checkpointEval = { mtimeMs: 0, adjudicated: false }

/**
 * 检查 chat-messages.json 末尾 AI 消息是否含「未回答」的 ask-user 块。
 * 大文件只读尾部（转录可达 MB 级）。
 */
function lastAiHasOpenAskUser(chatDir) {
  const p = path.join(chatDir, 'chat-messages.json')
  let st
  try { st = fs.statSync(p) } catch { return false }

  const size = st.size
  const start = Math.max(0, size - CHECKPOINT_TAIL_BYTES)
  let text
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return false }

  // 优先完整解析（截断从第一个 '[' 开始尽量恢复）
  let msgs = null
  try { msgs = JSON.parse(text.slice(text.indexOf('['))) } catch { msgs = null }

  if (Array.isArray(msgs)) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m || m.variant !== 'ai') continue
      return blocksHaveOpenAskUser(m.blocks)
    }
    return false
  }
  // 退化路径：尾部文本中存在未转换的 tool ask_user 调用
  return /"toolName"\s*:\s*"ask_user"/.test(text.slice(-65536))
}

/** 判定 blocks 数组是否含「未回答」的 ask-user 块 */
function blocksHaveOpenAskUser(blocks) {
  if (!Array.isArray(blocks)) return false
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'ask-user') {
      // 已回答: answers 存在；已跳过: skipped === true
      if (b.answers === undefined && b.skipped !== true) return true
      continue
    }
    if (b.type === 'tool' && b.toolName === 'ask_user') {
      // tool 块尚未转换为 ask-user 结果块 → 等待用户
      return true
    }
  }
  return false
}

/**
 * checkpoint 评估：mtime 变化时重新解析并在必要时做一次屏幕仲裁。
 * 仲裁规则：
 *   - 无 open ask_user → 不 blocked（working/idle 由其它信号决定）
 *   - 有 open ask_user：
 *       屏幕可见弹窗        → blocked（数据 + 屏幕一致）
 *       屏幕不可用/读取失败 → 信任数据 → blocked
 *       屏幕可见但无弹窗    → Esc 中断遗留的悬空块 → 不 blocked
 */
function evaluateCheckpoint(chatDir) {
  const p = path.join(chatDir, 'chat-messages.json')
  let st
  try { st = fs.statSync(p) } catch { return }
  if (st.mtimeMs === checkpointEval.mtimeMs) return
  checkpointEval.mtimeMs = st.mtimeMs
  checkpointEval.adjudicated = false

  const open = lastAiHasOpenAskUser(chatDir)
  if (!open) {
    blockedKnown = false
    checkpointEval.adjudicated = true
    return
  }
  // 数据说 blocked —— 用屏幕仲裁悬空块歧义
  // 守卫：回调返回时若 checkpoint 又变了（更新的仲裁已排队），放弃本次结果，
  // 避免陈旧仲裁覆盖较新的日志信号（竞态自愈在下一轮 mtime 变化时发生）。
  const evalMtime = st.mtimeMs
  readPaneText((ok, text) => {
    if (checkpointEval.mtimeMs !== evalMtime) return
    if (!ok) {
      blockedKnown = true // 屏幕不可用：信任数据（保守方向）
    } else if (screenShowsPopup(text)) {
      blockedKnown = true
    } else {
      // 屏幕可见但无弹窗（含空画面）→ Esc 中断遗留的悬空块 → 不 blocked
      debug('checkpoint 有悬空 ask_user 但屏幕无弹窗 → 判定为中断遗留')
      blockedKnown = false
    }
    checkpointEval.adjudicated = true
    deriveAndReport('等待回答 ask_user 问题')
  })
}

/* --------------------------- 屏幕刮取（辅助） --------------------------- */

/** 屏幕是否显示 ask_user 弹窗（这些提示串只出现在弹窗中） */
function screenShowsPopup(text) {
  return text.includes('Enter select') || text.includes('↑↓ navigate')
}

/** 屏幕是否显示「AI 正在处理」的持续指示 */
function screenShowsThinking(text) {
  return (
    text.includes('• Thinking') ||
    text.includes('Thinking...') ||
    text.includes('Working...')
  )
}

/** 屏幕是否显示「回合被中断」标记 */
function screenShowsInterrupted(text) {
  return text.includes('[response interrupted]')
}

let lastScreenHash = ''
let lastStaleCheckMs = 0

/**
 * working 停滞保护：日志与 checkpoint 都静止超过 STALE_WORKING_MS 时，
 * 用屏幕内容仲裁一次（每 STALE_CHECK_EVERY_MS 最多一次）：
 *   弹窗 → blocked；中断标记 → idle；
 *   画面变化（心跳）或处理指示 → 维持 working；画面长期不变 → idle。
 */
function staleWorkingGuard(chatDir) {
  const now = Date.now()
  if (reportedState !== 'working') { lastScreenHash = ''; return }
  const lastDataActivity = Math.max(lastActivityMs, checkpointEval.mtimeMs)
  if (now - lastDataActivity <= STALE_WORKING_MS) { lastScreenHash = ''; return }
  if (now - lastStaleCheckMs < STALE_CHECK_EVERY_MS) return
  lastStaleCheckMs = now

  readPaneText((ok, text) => {
    if (!ok) return // 屏幕不可用：维持现状，等待数据恢复
    if (screenShowsPopup(text)) {
      blockedKnown = true
      deriveAndReport('等待回答 ask_user 问题')
      return
    }
    if (screenShowsInterrupted(text)) {
      turnActive = false
      deriveAndReport('回合已中断')
      return
    }
    const hash = hashText(text)
    if (hash !== lastScreenHash || screenShowsThinking(text)) {
      // 画面在变化或显示处理指示 → 仍在工作
      lastActivityMs = Date.now()
      lastScreenHash = hash
      return
    }
    lastScreenHash = hash
    turnActive = false
    deriveAndReport('长时间无活动，回退 idle')
  })
}

function hashText(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return h
}

/* ------------------------------ 主循环 ------------------------------ */

let lastActivityMs = 0
let boundChatDir = ''
let sessionReported = ''

function loop() {
  // freebuff 进程退出 → 上报 unknown 并结束
  try { process.kill(FREEBUFF_PID, 0) } catch {
    if (reportedState !== 'unknown') {
      reportedState = 'unknown'
      report('unknown', 'freebuff 已退出')
    }
    process.exit(0)
  }

  // 1) 解析并绑定当前 chat 目录（pid 绑定，随新会话自动切换）
  const chatDir = resolveChatDir()
  if (chatDir && chatDir !== boundChatDir) {
    boundChatDir = chatDir
    turnActive = false
    blockedKnown = false
    checkpointEval = { mtimeMs: 0, adjudicated: false }
    lastScreenHash = ''
    const chatId = path.basename(chatDir)
    if (sessionReported !== chatId) {
      sessionReported = chatId
      reportSession(chatId, chatDir)
    }
    debug('绑定 chat 目录:', chatDir)
  }

  if (boundChatDir) {
    // 2) 增量 tail 日志（主要信号）
    tailLog(boundChatDir)

    // 3) checkpoint 评估（mtime 变化才解析；含屏幕仲裁）
    evaluateCheckpoint(boundChatDir)
  }

  // 4) 状态推导与上报（变化时才报）
  deriveAndReport()

  // 5) working 停滞保护
  staleWorkingGuard(boundChatDir)

  // 注意：不能 unref —— watcher 进程唯一职责就是轮询，
  // unref 会让 Node 在无其他活动句柄时立即退出。
  setTimeout(loop, POLL_INTERVAL_MS)
}

/* ------------------------------ 启动 ------------------------------ */

if (!HERDR_ENV || !PANE_ID) {
  debug('不在 herdr 窗格内（缺少 HERDR_ENV/HERDR_PANE_ID），退出')
  process.exit(0)
}
if (!FREEBUFF_PID) {
  debug('缺少 freebuff pid 参数，退出')
  process.exit(1)
}

debug(`watcher 启动: pid=${FREEBUFF_PID} pane=${PANE_ID}`)

// 优雅退出：上报 unknown 释放 herdr 侧生命周期权威
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (reportedState !== 'unknown') {
      reportedState = 'unknown'
      report('unknown', 'watcher 退出')
    }
    process.exit(0)
  })
}

loop()
