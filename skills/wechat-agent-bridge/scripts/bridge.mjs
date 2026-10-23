#!/usr/bin/env node
/** WeChat iLink bridge. See README for setup and adapter protocol. */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runAgent } from "./agent.mjs"
import readline from 'node:readline'
import {
  ILinkError, beginLogin, pollLogin, getUpdates, sendText,
  notifyStart, notifyStop, extractText, chunkText,
} from './ilink.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEEN_RING_SIZE = 200
const MAX_CHUNK_BYTES = 6000

// ---------------------------------------------------------------- state --
// token 属密钥,状态目录放本机 %LOCALAPPDATA%(不进 OneDrive 同步范围)。
function stateDir() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || join(homedir(), '.local')
  const dir = process.env.WECHAT_BRIDGE_STATE_DIR || join(base, 'WechatAgentBridge')
  mkdirSync(dir, { recursive: true })
  return dir
}

function statePath() { return join(stateDir(), 'state.json') }
function inboxPath() { return join(stateDir(), 'inbox.jsonl') }

function loadState() {
  const empty = {
    token: null, botId: null, ownerUserId: null, baseUrl: null,
    getUpdatesBuf: '', seenMessageIds: [], contextToken: null,
    activeContext: null, contextSessions: {},
  }
  try {
    if (existsSync(statePath())) {
      return { ...empty, ...JSON.parse(readFileSync(statePath(), 'utf8')) }
    }
  } catch { /* 损坏则重建 */ }
  return empty
}

function saveState(state) {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), { mode: 0o600 })
}

function log(...args) { console.error('[wechat-agent-bridge]', ...args) }

// ------------------------------------------------------------ bootstrap --
// 只读使用,不打印任何密钥。
function bootstrap() { throw new Error("Use --login to pair a new account") }

// ------------------------------------------------------------- inbound --
function filterInbound(state, msgs) {
  const out = []
  for (const raw of msgs ?? []) {
    try {
      if (raw?.message_type === 2) continue // bot 自己的出站回声
      const id = raw?.message_id != null ? String(raw.message_id) : (raw?.client_id ?? null)
      const from = typeof raw?.from_user_id === 'string' ? raw.from_user_id.trim() : ''
      if (!id || !from) continue
      if (state.seenMessageIds.includes(id)) continue
      state.seenMessageIds.push(id)
      if (state.seenMessageIds.length > SEEN_RING_SIZE) {
        state.seenMessageIds = state.seenMessageIds.slice(-SEEN_RING_SIZE)
      }
      const contextToken = typeof raw?.context_token === 'string' ? raw.context_token.trim() : ''
      if (!state.ownerUserId || from !== state.ownerUserId) {
        out.push({ id, from, kind: 'ignored-non-owner' })
        continue
      }
      if (contextToken) state.contextToken = contextToken
      const text = extractText(raw)
      const isImage = (raw?.item_list ?? []).some((i) => i?.type === 2 || i?.image_item)
      if (isImage && !text) {
        out.push({ id, from, kind: 'image', text: '[图片消息:当前桥不接收入站图片内容]' })
        continue
      }
      if (!text) continue
      out.push({ id, from, kind: 'text', text, time: new Date().toISOString() })
    } catch (error) {
      log('inbound dispatch failed:', error?.message ?? error)
    }
  }
  return out
}

async function checkMessages(state) {
  if (!state.token || !state.baseUrl || !state.ownerUserId) throw new Error('未绑定:请先运行 --login')
  const response = await getUpdates({
    baseUrl: state.baseUrl, token: state.token, getUpdatesBuf: state.getUpdatesBuf,
  })
  const rejected = (response?.ret !== undefined && response.ret !== 0)
    || (response?.errcode !== undefined && response.errcode !== 0)
  if (rejected) {
    const code = response.errcode ?? response.ret
    if (code === -14) throw new ILinkError('stale-token', 'bot_token 已失效(-14),请运行 --login 重新扫码')
    throw new ILinkError('poll-rejected', `getupdates 被拒绝 (ret=${code})`)
  }
  const messages = filterInbound(state, response?.msgs ?? [])
  if (typeof response?.get_updates_buf === 'string' && response.get_updates_buf) {
    state.getUpdatesBuf = response.get_updates_buf
  }
  saveState(state)
  const fresh = messages.filter((m) => m.kind === 'text' || m.kind === 'image')
  if (fresh.length) {
    const lines = fresh.map((m) => JSON.stringify(m)).join('\n') + '\n'
    appendFileSync(inboxPath(), lines, 'utf8')
  }
  return messages
}

async function sendToOwner(state, text) {
  if (!state.token || !state.baseUrl || !state.ownerUserId) throw new Error('未绑定:请先运行 --login')
  const chunks = chunkText(text, MAX_CHUNK_BYTES)
  for (const chunk of chunks) {
    await sendText({
      baseUrl: state.baseUrl, token: state.token,
      toUserId: state.ownerUserId, text: chunk,
      contextToken: state.contextToken ?? undefined,
    })
  }
  return { sent: true, chunks: chunks.length }
}

// ----------------------------------------------------------- agent serve --
function resolveWorkspace() { return process.env.WECHAT_WORKSPACE || process.cwd() }
function contextsPath() { return join(stateDir(), "contexts.json") }
function loadContexts() {
 if (!existsSync(contextsPath())) writeFileSync(contextsPath(), JSON.stringify({default: "%WORKSPACE%"}), {mode: 0o600});
 return JSON.parse(readFileSync(contextsPath(), "utf8"));
}
function saveContexts(contexts) { writeFileSync(contextsPath(), JSON.stringify(contexts), {mode: 0o600}) }
async function handleBridgeCommand(state, text) {
  if (!text.startsWith('/')) return null
  const [cmd, ...rest] = text.split(/\s+/)
  const contexts = loadContexts()
  state.contextSessions ??= {}
  if (cmd === '/help') {
    return [
      '可用指令:',
      '/use 名称 — 切换到指定会话上下文',
      '/ctx — 列出全部上下文(带 * 为当前)',
      '/newctx 名称 路径 — 新增上下文(路径可用 %WORKSPACE% 指代工作区)',
      '/status — 查看桥接状态',
      '/help — 本帮助',
      '其余内容直接发给 Kimi 处理。',
    ].join('\n')
  }
  if (cmd === '/ctx') {
    const active = state.activeContext || 'default'
    const lines = Object.keys(contexts).map((n) => `${n === active ? '*' : '-'} ${n}`)
    return `上下文列表:\n${lines.join('\n')}`
  }
  if (cmd === '/use') {
    const name = rest.join(' ').trim()
    if (!name) return '用法: /use 名称(用 /ctx 看可选列表)'
    if (!contexts[name]) return `没有上下文「${name}」。用 /ctx 看现有列表,或 /newctx 新增。`
    state.activeContext = name
    saveState(state)
    return `已切换到「${name}」。后续消息由该项目的 Kimi 会话处理。`
  }
  if (cmd === '/newctx') {
    const name = rest[0]
    const rawPath = rest.slice(1).join(' ').trim()
    if (!name || !rawPath) return '用法: /newctx 名称 路径(路径可用 %WORKSPACE%)'
    const cwd = rawPath.replaceAll('%WORKSPACE%', resolveWorkspace())
    if (!existsSync(cwd)) return `路径不存在: ${cwd}`
    contexts[name] = rawPath
    saveContexts(contexts)
    return `已新增上下文「${name}」→ ${cwd}`
  }
  if (cmd === '/status') {
    const active = state.activeContext || 'default'
    const sid = state.contextSessions?.[active]
    return [
      `绑定: ${state.botId ?? '?'}`,
      `当前上下文: ${active}`,
      `上下文会话: ${sid ? '已建立(连续记忆)' : '未开始(首条消息后建立)'}`,
      `时间: ${new Date().toISOString()}`,
    ].join('\n')
  }
  return `未知指令: ${cmd}\n${await handleBridgeCommand(state, '/help')}`
}

async function handleServeMessage(state, message) {
  log(`处理消息 ${message.id}: ${String(message.text ?? '').slice(0, 30)}`)
  if (message.kind === 'image') {
    await sendToOwner(state, '收到图片了,但当前桥还不支持读图,请用文字描述或发文字。')
    return
  }
  const cmdReply = await handleBridgeCommand(state, message.text)
  if (cmdReply) {
    await sendToOwner(state, cmdReply)
    return
  }
  const contexts = loadContexts()
  const name = state.activeContext || 'default'
  const rawCwd = contexts[name]
  if (!rawCwd) {
    await sendToOwner(state, `当前上下文「${name}」已失效,请用 /ctx 查看并 /use 切换。`)
    return
  }
  const cwd = rawCwd.replaceAll('%WORKSPACE%', resolveWorkspace())
  if (!existsSync(cwd)) {
    await sendToOwner(state, `上下文「${name}」的目录不存在: ${cwd},请 /use 切换或 /newctx 重建。`)
    return
  }
  state.contextSessions ??= {}
  const pinned = state.contextSessions[name]
  let result = await runAgent({ cwd, text: message.text, sessionId: pinned })
  if (!result.ok && pinned) {
    log("Adapter failed; no automatic retry to avoid duplicate actions")
  }
  if (result.sessionId) {
    state.contextSessions[name] = result.sessionId
    saveState(state)
  }
  if (result.ok) {
    log('回传微信:', result.text.slice(0, 30), `(${result.text.length} 字)`)
    await sendToOwner(state, result.text)
    log('回传完成')
  } else {
    await sendToOwner(state, `处理失败: ${result.error}`)
  }
}

// ----------------------------------------------------------------- CLI --
async function cli(argv) {
  const flag = argv[2]
  const state = loadState()

  if (flag === '--legacy-bootstrap-disabled') {
    const result = bootstrap()
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (flag === '--status') {
    console.log(JSON.stringify({
      bound: Boolean(state.token && state.baseUrl && state.ownerUserId),
      botId: state.botId, ownerUserId: state.ownerUserId, baseUrl: state.baseUrl,
      hasToken: Boolean(state.token), cursorLoaded: Boolean(state.getUpdatesBuf),
      stateFile: statePath(), inboxFile: inboxPath(),
    }, null, 2))
    return
  }
  if (flag === '--check') {
    const messages = await checkMessages(state)
    console.log(JSON.stringify(messages))
    return
  }
  if (flag === '--send') {
    const text = argv.slice(3).join(' ')
    if (!text.trim()) throw new Error('--send 需要文本参数')
    console.log(JSON.stringify(await sendToOwner(state, text)))
    return
  }
  if (flag === '--listen') {
    log('listen 启动,写入', inboxPath())
    try { await notifyStart({ baseUrl: state.baseUrl, token: state.token }) } catch (e) { log('notifystart:', e?.message) }
    let failures = 0
    const abort = new AbortController()
    process.on('SIGINT', () => abort.abort())
    process.on('SIGTERM', () => abort.abort())
    while (!abort.signal.aborted) {
      try {
        const messages = await checkMessages(state)
        failures = 0
        for (const m of messages) {
          if (m.kind === 'text' || m.kind === 'image') console.log(JSON.stringify(m))
        }
      } catch (error) {
        if (abort.signal.aborted) break
        failures += 1
        log(`poll 失败(${failures}):`, error?.message ?? error)
        if (error instanceof ILinkError && error.code === 'stale-token') process.exit(2)
        await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (failures - 1), 30_000)))
      }
    }
    try { await notifyStop({ baseUrl: state.baseUrl, token: state.token }) } catch { /* best effort */ }
    return
  }
  if (flag === '--serve') {
    if (!state.activeContext) {
      state.activeContext = 'default'
      saveState(state)
    }
    log(`serve 启动:事件驱动模式,当前上下文「${state.activeContext}」`)
    try { await notifyStart({ baseUrl: state.baseUrl, token: state.token }) } catch (e) { log('notifystart:', e?.message) }
    let failures = 0
    let queue = Promise.resolve()
    const abort = new AbortController()
    process.on('SIGINT', () => abort.abort())
    process.on('SIGTERM', () => abort.abort())
    while (!abort.signal.aborted) {
      try {
        const messages = await checkMessages(state)
        failures = 0
        for (const m of messages) {
          if (m.kind !== 'text' && m.kind !== 'image') continue
          console.log(JSON.stringify(m))
          queue = queue.then(() =>
            handleServeMessage(state, m).catch((error) => {
              log('消息处理失败:', error?.message ?? error)
            }),
          )
        }
      } catch (error) {
        if (abort.signal.aborted) break
        failures += 1
        log(`poll 失败(${failures}):`, error?.message ?? error)
        if (error instanceof ILinkError && error.code === 'stale-token') process.exit(2)
        await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (failures - 1), 30_000)))
      }
    }
    await queue.catch(() => undefined)
    try { await notifyStop({ baseUrl: state.baseUrl, token: state.token }) } catch { /* best effort */ }
    return
  }
  if (flag === '--agent-test') {
        const text = argv.slice(3).join(' ')
    if (!text.trim()) throw new Error('--agent-test 需要文本参数')
    const contexts = loadContexts()
    const name = state.activeContext || 'default'
    const cwd = (contexts[name] ?? '%WORKSPACE%').replaceAll('%WORKSPACE%', resolveWorkspace())
    const result = await runAgent({ cwd, text, sessionId: state.contextSessions?.[name] })
    if (result.sessionId) {
      state.contextSessions ??= {}
      state.contextSessions[name] = result.sessionId
      saveState(state)
    }
    console.log(JSON.stringify({ context: name, cwd, ...result }, null, 2))
    return
  }
  if (flag === '--login') {
    await loginFlow()
    return
  }
  console.error(`未知参数: ${flag ?? '(空)'}\n用法见文件头注释`)
  process.exit(64)
}

async function loginFlow() {
  const state = loadState()
  const { qrcode, qrcodeUrl } = await beginLogin()
  console.log('请用微信扫描以下二维码(链接形式,粘贴到浏览器打开):')
  console.log(qrcodeUrl ?? qrcode)
  let baseUrl
  for (;;) {
    let result
    try {
      result = await pollLogin({ qrcode, baseUrl })
    } catch (error) {
      if (error?.code === 'timeout') continue
      throw error
    }
    if (result.status === 'scaned_but_redirect' || result.status === 'binded_redirect') {
      if (result.baseUrl) baseUrl = result.baseUrl
    } else if (result.status === 'expired') {
      console.log('二维码已过期,请重新运行 --login')
      return
    } else if (result.status === 'confirmed') {
      if (!result.botToken || !result.ownerUserId) throw new Error('confirmed 缺少 bot_token')
      state.token = result.botToken
      state.botId = result.botId ?? null
      state.ownerUserId = result.ownerUserId ?? null
      state.baseUrl = result.baseUrl ?? baseUrl ?? null
      state.getUpdatesBuf = ''
      state.seenMessageIds = []
      saveState(state)
      console.log(JSON.stringify({ ok: true, botId: state.botId, ownerUserId: state.ownerUserId }))
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// ----------------------------------------------------------------- MCP --
const MCP_TOOLS = [
  {
    name: 'wechat_status',
    description: '查看微信 ClawBot 桥接状态:是否已绑定、bot/owner 标识、状态文件位置。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wechat_poll',
    description: '收取微信新消息(长轮询,最长约 35 秒;无消息返回空数组)。只返回绑定 owner 的消息,其他人消息会被忽略。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wechat_send',
    description: '给微信 owner(owner)发送文字消息;超长自动分段。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要发送的文字' } },
      required: ['text'],
    },
  },
  {
    name: 'wechat_inbox',
    description: '读取最近收到的微信消息记录(listen 模式落盘的 inbox)。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最近 N 条,默认 20' } },
    },
  },
]

function mcpResult(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

function mcpError(message) {
  return { content: [{ type: 'text', text: `错误: ${message}` }], isError: true }
}

async function mcpCall(name, args) {
  const state = loadState()
  switch (name) {
    case 'wechat_status':
      return mcpResult({
        bound: Boolean(state.token && state.baseUrl && state.ownerUserId),
        botId: state.botId, ownerUserId: state.ownerUserId,
        hasToken: Boolean(state.token),
      })
    case 'wechat_poll':
      return mcpResult(await checkMessages(state))
    case 'wechat_send': {
      const text = typeof args?.text === 'string' ? args.text : ''
      if (!text.trim()) return mcpError('text 不能为空')
      return mcpResult(await sendToOwner(state, text))
    }
    case 'wechat_inbox': {
      const limit = Number.isFinite(args?.limit) ? args.limit : 20
      if (!existsSync(inboxPath())) return mcpResult([])
      const lines = readFileSync(inboxPath(), 'utf8').trim().split('\n').filter(Boolean)
      return mcpResult(lines.slice(-limit).map((l) => { try { return JSON.parse(l) } catch { return l } }))
    }
    default:
      return mcpError(`未知工具: ${name}`)
  }
}

function serveMcp() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try { msg = JSON.parse(trimmed) } catch { return }
    const reply = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...obj }) + '\n')
    try {
      if (msg.method === 'initialize') {
        reply({
          result: {
            protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'wechat-agent-bridge', version: '0.1.0' },
          },
        })
      } else if (msg.method === 'notifications/initialized' || msg.method === 'initialized') {
        /* no response */
      } else if (msg.method === 'ping') {
        reply({ result: {} })
      } else if (msg.method === 'tools/list') {
        reply({ result: { tools: MCP_TOOLS } })
      } else if (msg.method === 'tools/call') {
        try {
          reply({ result: await mcpCall(msg.params?.name, msg.params?.arguments ?? {}) })
        } catch (error) {
          reply({ result: mcpError(error?.message ?? String(error)) })
        }
      } else if (msg.id !== undefined) {
        reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
      }
    } catch (error) {
      log('mcp dispatch failed:', error?.message ?? error)
    }
  })
  log('MCP stdio 服务器已就绪')
}

// --------------------------------------------------------------- entry --
if (process.argv[2]) {
  cli(process.argv).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message ?? String(error) }))
    process.exit(1)
  })
} else {
  serveMcp()
}
