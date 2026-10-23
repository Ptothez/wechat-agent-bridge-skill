# Use Your AI Agent Through WeChat

[简体中文](README.md) | [English](README.en.md)

Forward incoming WeChat text to an agent on your computer and send its answer back to WeChat. You can message the computer while away from your desk.

The bridge uses the WeChat iLink channel and a configurable agent adapter. It is not tied to Kimi, Claude, or Codex. Each agent has different startup arguments, output formats, and session handling, so it needs a suitable adapter. Entering an arbitrary CLI name does not make it compatible.

## Install

Requires Node.js 20.11 or newer, a WeChat account eligible for iLink QR login, and an installed, authenticated agent.

```bash
npx -y skills add Ptothez/wechat-agent-bridge-skill -g --all
```

Ask your agent to follow `skills/wechat-agent-bridge/SKILL.md`. Installing the skill does not start a service or read WeChat credentials.

## Configure and Start

`<scripts>` below means this skill's installed `scripts` directory. Create a local adapter configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/your-adapter.mjs"],
  "timeoutMs": 300000
}
```

The adapter is a small program that calls your agent. The bridge writes one JSON request to its standard input:

```json
{"text":"Incoming message","sessionId":null,"cwd":"Working directory"}
```

The adapter writes one JSON reply to standard output, and logs to standard error:

```json
{"text":"Reply to send to WeChat","sessionId":"Optional session identifier"}
```

An agent without session recovery can omit `sessionId`. Each message may then start a new session; do not claim continuous memory. The adapter must follow its CLI's official usage and must not bypass permission confirmation by default.

In PowerShell, set the configuration path and workspace, then pair your account:

```powershell
$env:WECHAT_AGENT_CONFIG = 'Full path to your adapter configuration'
$env:WECHAT_WORKSPACE = 'Directory the agent is allowed to work in'
node <scripts>/bridge.mjs --login
node <scripts>/bridge.mjs --agent-test 'Reply with connection OK only'
node <scripts>/bridge.mjs --serve
```

Receiving commands requires a bound owner identifier. Other accounts are ignored. `--serve` must remain running to receive messages; closing the terminal stops it. For background startup, ask your agent to configure a user-level service for your operating system. Windows startup must hide the window, and receiving messages must be verified after a restart.

## Use in WeChat

Send text normally. Use `/ctx` to list contexts, `/use name` to switch, and `/newctx name directory` to add one. Each context stores its own session identifier. On the computer, run `node <scripts>/bridge.mjs --status` to inspect binding status.

## Data and Limits

- Messages reach your chosen agent and its model provider. Agents with file or command permissions can operate the computer. Permissions depend on your agent and adapter configuration.
- Credentials, inbox messages, and session identifiers stay in the local state directory and are not part of this repository. The default is under LOCALAPPDATA on Windows or the user directory elsewhere. Override with WECHAT_BRIDGE_STATE_DIR; keep it outside public repositories.
- Text only: incoming image content is not downloaded or recognized. The bridge has no guaranteed-delivery task queue. An abrupt exit can lose a reply; do not rely on it for strict delivery guarantees.
- Timeouts stop the direct child process. Some CLIs may leave descendant processes running. Check the actual result before retrying to avoid repeating an action.
- Local mock-adapter tests cover invocation and failure handling. New-user QR pairing and every agent's real CLI have not been verified.

The protocol client derives from CMD128/dsh-wx-bridge under MIT; see LICENSE-upstream. This is not an official WeChat or agent-vendor plugin.

## License

MIT; see [LICENSE](LICENSE). Upstream terms are preserved in [LICENSE-upstream](LICENSE-upstream).
