/**
 * Tencent iLink bot protocol client (微信 ClawBot / 官方机器人平台).
 *
 * 适配自 dsh-wx-bridge (github:CMD128/dsh-wx-bridge, MIT)，
 * 其协议层参考 dsh-chatops api.ts（MIT，逆向自 xmanrui/dsh-im），协议版本 2.4.6。
 * 纯 HTTPS JSON over fetch — 零第三方依赖。
 */
import { randomBytes, randomUUID } from 'node:crypto'

export const ILINK_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/'
export const ILINK_PROTOCOL_VERSION = '2.4.6'
export const DEFAULT_BOT_TYPE = '3'

const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6)
const LOGIN_TIMEOUT_MS = 10_000
const LONG_POLL_TIMEOUT_MS = 35_000
const SHORT_TIMEOUT_MS = 15_000

export class ILinkError extends Error {
  constructor(code, message, options = {}) {
    super(message, options)
    this.name = 'ILinkError'
    this.code = code
    this.status = options.status
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function baseInfo() {
  return {
    channel_version: ILINK_PROTOCOL_VERSION,
    bot_agent: 'Agent/wechat-agent-bridge',
  }
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
  }
}

function authenticatedHeaders(token = null) {
  const headers = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function requestJson({ method, baseUrl, endpoint, token = null, body, timeoutMs = SHORT_TIMEOUT_MS, authenticated = true, signal }) {
  const url = new URL(endpoint, baseUrl).toString()
  const timeout = AbortSignal.timeout(timeoutMs)
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetch(url, {
      method,
      headers: authenticated === false ? commonHeaders() : authenticatedHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: sig,
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ILinkError('timeout', `iLink request timed out: ${endpoint}`, { cause: error })
    }
    const cause = error?.cause
    const detail = cause ? `${cause.code ?? ''}${cause.code ? ' ' : ''}${cause.message ?? cause}`.trim() : 'no-cause'
    throw new ILinkError('network-error', `iLink request failed: ${error?.message ?? error} [${detail}] (${endpoint})`, { cause: error })
  }
  if (!response.ok) {
    throw new ILinkError('http-error', `iLink HTTP ${response.status}: ${endpoint}`, { status: response.status })
  }
  try {
    return await response.json()
  } catch (error) {
    throw new ILinkError('invalid-response', `iLink returned non-JSON: ${endpoint}`, { cause: error })
  }
}

/** Extract first text/voice-transcript item from an inbound message. */
export function extractText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim()
      if (text) return text
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim()
      if (text) return text
    }
  }
  return null
}

/** 按字节预算切分文本，优先在换行处断。每段 ≤ maxBytes。 */
export function chunkText(text, maxBytes = 6000) {
  const chunks = []
  let rest = text
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    let cut = Math.min(rest.length, Math.floor(maxBytes / 3))
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > maxBytes && cut > 1) cut = Math.floor(cut * 0.9)
    const newline = rest.lastIndexOf('\n', cut)
    if (newline > cut * 0.5) cut = newline + 1
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Step ①: request a binding QR. */
export async function beginLogin({ localTokens = [], botType = DEFAULT_BOT_TYPE, signal } = {}) {
  const response = await requestJson({
    method: 'POST',
    baseUrl: ILINK_QR_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokens.slice(-10) },
    timeoutMs: LOGIN_TIMEOUT_MS,
    signal,
  })
  const qrcode = nonEmpty(response?.qrcode)
  if (!qrcode) throw new ILinkError('invalid-qr', 'iLink 没有返回二维码令牌')
  return { qrcode, qrcodeUrl: nonEmpty(response?.qrcode_img_content) }
}

/** Step ②: long-poll the scan status (35s). */
export async function pollLogin({ qrcode, baseUrl = ILINK_QR_BASE_URL, verifyCode, signal }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
  if (nonEmpty(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode.trim())}`
  const response = await requestJson({
    method: 'GET',
    baseUrl,
    endpoint,
    timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
    signal,
    authenticated: false,
  })
  const status = response?.status
  const result = { status }
  if (status === 'confirmed') {
    result.botToken = nonEmpty(response?.bot_token) ?? undefined
    result.botId = nonEmpty(response?.ilink_bot_id) ?? undefined
    result.ownerUserId = nonEmpty(response?.ilink_user_id) ?? undefined
    result.baseUrl = nonEmpty(response?.baseurl) ?? undefined
  }
  const redirectBase = nonEmpty(response?.baseurl)
  if (redirectBase && !result.baseUrl) result.baseUrl = redirectBase
  return result
}

/** Long-poll inbound messages. Timeout returns an empty batch. */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = '', signal }) {
  try {
    return await requestJson({
      method: 'POST',
      baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
      signal,
    })
  } catch (error) {
    if (error instanceof ILinkError && error.code === 'timeout') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
    }
    throw error
  }
}

/** Send a text message. contextToken keeps the conversation context. */
export async function sendText({ baseUrl, token, toUserId, text, contextToken, signal }) {
  const response = await requestJson({
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    token,
    signal,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `wechat-kimi-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(nonEmpty(contextToken) ? { context_token: contextToken.trim() } : {}),
      },
      base_info: baseInfo(),
    },
  })
  if (response?.ret !== undefined && response.ret !== 0) {
    throw new ILinkError('send-rejected', `iLink 拒绝了回复消息 (ret=${response.ret})`)
  }
  return true
}

/** Bot-online notification, called once when a listen loop starts. */
export async function notifyStart({ baseUrl, token, signal }) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    token,
    signal,
    timeoutMs: LOGIN_TIMEOUT_MS,
    body: { base_info: baseInfo() },
  })
}

/** Bot-offline notification, best-effort on shutdown. */
export async function notifyStop({ baseUrl, token, signal }) {
  return requestJson({
    method: 'POST',
    baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    token,
    signal,
    timeoutMs: LOGIN_TIMEOUT_MS,
    body: { base_info: baseInfo() },
  })
}
