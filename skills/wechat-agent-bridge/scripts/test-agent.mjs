import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent } from './agent.mjs'
const dir = mkdtempSync(join(tmpdir(), 'wechat-adapter-test-'))
const adapter = join(dir, 'adapter.mjs')
const config = join(dir, 'adapter.local.json')
writeFileSync(adapter, `let s='';for await(const c of process.stdin)s+=c;const q=JSON.parse(s);if(q.text==='fail')process.exit(2);if(q.text==='invalid'){console.log('not json');}else if(q.text==='wait'){setTimeout(()=>{},10000);}else {console.log(JSON.stringify({text:'reply:'+q.text,sessionId:q.sessionId||'test-session'}));}`)
process.env.WECHAT_AGENT_CONFIG = config
writeFileSync(config, JSON.stringify({ command: process.execPath, args: [adapter], timeoutMs: 2000 }))
assert.deepEqual(await runAgent({ cwd: dir, text: 'hello', sessionId: null }), { ok: true, text: 'reply:hello', sessionId: 'test-session' })
assert.equal((await runAgent({ cwd: dir, text: 'next', sessionId: 'existing' })).sessionId, 'existing')
assert.equal((await runAgent({ cwd: dir, text: 'fail' })).ok, false)
assert.equal((await runAgent({ cwd: dir, text: 'invalid' })).ok, false)
writeFileSync(config, JSON.stringify({ command: process.execPath, args: [adapter], timeoutMs: 100 }))
assert.equal((await runAgent({ cwd: dir, text: 'wait' })).ok, false)
delete process.env.WECHAT_AGENT_CONFIG
assert.equal((await runAgent({ cwd: dir, text: 'missing' })).ok, false)
console.log('6 adapter checks passed; no real account or agent used')
