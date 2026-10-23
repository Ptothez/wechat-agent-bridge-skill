import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Adapter contract: one JSON request on stdin, one JSON reply on stdout.
// The adapter owns CLI-specific arguments, permissions and session handling.
export function runAgent({ cwd, text, sessionId }) {
  return new Promise((resolve) => {
    let config
    try {
      if (!process.env.WECHAT_AGENT_CONFIG) throw new Error('Set WECHAT_AGENT_CONFIG to your local adapter JSON file')
      config = JSON.parse(readFileSync(process.env.WECHAT_AGENT_CONFIG, 'utf8'))
      if (typeof config.command !== 'string' || !config.command || !Array.isArray(config.args) || !config.args.every(x => typeof x === 'string')) throw new Error('Adapter needs command and string args[]')
    } catch (error) { resolve({ ok: false, error: error.message }); return }
    let done = false
    let output = ''
    let timer
    const child = spawn(config.command, config.args, { cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result) } }
    timer = setTimeout(() => { child.kill(); finish({ ok: false, error: 'Adapter timed out; check its child processes before retrying' }) }, Math.min(Math.max(Number(config.timeoutMs) || 300000, 100), 1800000))
    child.stdin.on('error', () => {})
    child.on('error', () => finish({ ok: false, error: 'Cannot start adapter; check command and args locally' }))
    child.stdout.on('data', data => {
      output += data
      if (Buffer.byteLength(output) > 1048576) { child.kill(); finish({ ok: false, error: 'Adapter output exceeds 1 MiB' }) }
    })
    child.stderr.resume()
    child.on('close', code => {
      if (code !== 0) return finish({ ok: false, error: `Adapter exited with code ${code}` })
      try {
        const reply = JSON.parse(output)
        if (typeof reply.text !== 'string' || !reply.text.trim()) throw new Error('No reply text')
        if (reply.sessionId != null && typeof reply.sessionId !== 'string') throw new Error('Invalid sessionId')
        finish({ ok: true, text: reply.text, sessionId: reply.sessionId || null })
      } catch { finish({ ok: false, error: 'Adapter must return JSON with nonempty text and optional sessionId' }) }
    })
    child.stdin.end(JSON.stringify({ text, sessionId: sessionId || null, cwd }) + '\n')
  })
}
