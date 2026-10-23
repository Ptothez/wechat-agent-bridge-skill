---
name: wechat-agent-bridge
description: 帮用户把微信文字消息转交给电脑上的 AI Agent，并把回答发回微信。用户要求从微信使用 Agent、配置微信连接或排查桥接时使用。支持可配置适配器，不限定 Agent 品牌。
---

# 微信连接 Agent

English: Forward WeChat text to a locally configured AI agent and return its reply. Configure and verify a JSON adapter for the chosen agent; support is not tied to one vendor.

用户提供想连接的 Agent、工作目录和允许的操作范围；你配置收发程序及适配器，验证后交付启动、停止和故障检查方法。

1. 先询问或从已知信息确认 Agent 和工作目录，读取该 CLI 的官方说明，核实非交互输入、回答输出、会话恢复与权限处理方式。
2. 使用 `scripts/bridge.mjs` 和 `scripts/agent.mjs`。适配器按仓库 README 的 JSON 输入输出约定实现；敏感配置仅存用户本机私密目录。不读取其他工具的凭据，不复制作者本机配置。
3. 先用 `--agent-test` 验证回答、非零退出、超时及会话恢复；未验证连续会话时明确说明每次可能重新开始。
4. 请用户本人执行 `--login` 扫码；不展示或上传 token。确认 owner 绑定后启动 `--serve`，用一条无副作用消息验证真实微信往返。
5. 需要后台常驻时，使用用户自己的服务管理器，提供停止方式。Windows 用隐藏窗口启动，验证重启后仍能接收，不能只凭服务注册成功宣称完成。
6. 失败先核实是否已实际执行；不自动重发有副作用的操作。用户要求维护时才改配置，不更换现有正在使用的连接。

安全边界：只接受绑定账号；Agent 按用户授权工作，不默认绕过权限确认。图片不识别。不把模拟测试称为真实微信或所有 Agent 的兼容测试。咨询、交易、发布等行为仍遵守宿主 Agent 的限制。
