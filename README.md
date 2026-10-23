# 在微信里使用你的 AI Agent

把微信收到的文字交给电脑上的 Agent，再把回答发回微信。你可以在外面发消息，让家里的电脑继续处理事情。

桥接程序通过微信 iLink 通道收发消息，用一个可配置的适配器调用 Agent。它不绑定 Kimi、Claude 或 Codex；但每种 Agent 的启动参数、输出格式和会话恢复方式不同，需要对应适配器，不能保证随便填一个 CLI 名称就能运行。

## 安装

需要 Node.js 20.11 或更新版本、能使用 iLink 扫码登录的微信账号，以及已安装和登录的 Agent。

```bash
npx -y skills add Ptothez/wechat-agent-bridge-skill -g --all
```

安装 Skill 后，让 Agent 按 `skills/wechat-agent-bridge/SKILL.md` 帮你配置。安装本身不会启动服务或读取微信凭据。

## 配置并启动

下面的 `<scripts>` 指安装后这个 Skill 的 scripts 目录。先在自己的电脑创建适配器配置文件：

```json
{
  "command": "node",
  "args": ["/absolute/path/to/your-adapter.mjs"],
  "timeoutMs": 300000
}
```

适配器就是一个把消息交给 Agent 的小程序。桥接向它的标准输入写入一行 JSON：

```json
{"text":"用户发来的消息","sessionId":null,"cwd":"工作目录"}
```

适配器完成后，在标准输出返回一个 JSON；运行日志写到标准错误：

```json
{"text":"要发回微信的回答","sessionId":"可选的会话编号"}
```

不支持会话恢复的 Agent 可以省略 sessionId。此时每条消息可能是新会话，不能宣称有连续记忆。适配器负责按照对应 CLI 的官方用法调用，不得默认开启跳过权限确认的模式。

PowerShell 中设置配置路径和工作目录，再扫码：

```powershell
$env:WECHAT_AGENT_CONFIG = '你的适配器配置文件的完整路径'
$env:WECHAT_WORKSPACE = '允许 Agent 工作的目录'
node <scripts>/bridge.mjs --login
node <scripts>/bridge.mjs --agent-test '只回复连接正常'
node <scripts>/bridge.mjs --serve
```

扫码成功后必须有绑定的账号标识才能接收指令，其他账号的消息会被忽略。`--serve` 持续运行才会收消息；关闭终端会停止。需要开机后台运行时，让 Agent 按你的操作系统配置用户级服务，Windows 启动必须隐藏窗口，并在重启后验证。

## 在微信里怎么用

直接发送文字。发送 `/ctx` 查看上下文，`/use 名称` 切换，`/newctx 名称 目录` 添加。不同上下文分别保存会话编号。`node <scripts>/bridge.mjs --status` 可在电脑检查绑定状态。

## 数据和限制

- 消息会发给你选择的 Agent 及其模型服务商。具有文件或命令权限的 Agent 可以实际操作电脑，权限由你配置的 Agent 和适配器控制。
- 凭据、消息收件箱和会话编号只存本机状态目录，不属于发布包。Windows 默认在 LOCALAPPDATA 下；其他系统默认在用户目录下。可用 WECHAT_BRIDGE_STATE_DIR 改到自己的私密目录，请勿放进公开仓库。
- 当前只支持文字；图片内容不会下载或识别。没有保证消息绝不丢失的任务队列，进程突然退出可能漏回消息；不要靠它执行需要严格交付保证的操作。
- 适配器超时会停止直接子进程，某些 CLI 的子孙进程可能仍在运行。失败后先检查执行结果再重试，避免重复操作。
- 本次用本地模拟适配器验证调用和失败处理；未替新用户扫码，也未逐一验证所有 Agent 的真实 CLI。

协议客户端来自 CMD128/dsh-wx-bridge 的 MIT 实现，保留在 LICENSE-upstream；这不是微信或任何 Agent 厂商的官方插件。
