# ProofGuard｜Demo 模式提交内容

> 当前状态：可运行 Web App、GitHub 代码与全部说明材料已完成；Demo 模式不发送官方 0G API 请求，因此尚未满足赛道“通过官方 API 调用”的硬性要求。

## 一句话

每一笔 AI Agent 发起的链上交易，都必须先通过两个 0G 安全审查角色和一套确定性 Owner Policy 的三票审查。

## 项目简介

ProofGuard 是链上 Agent 的交易防火墙。它在交易广播前拦截 Agent 生成的 EVM 交易，检查提示词注入、恶意合约、非白名单资产、无限授权、异常滑点和策略越界；只有所有审查票一致通过，才生成短时、限域、一次性的 Execution Permit。

## 0G Private Computer 集成

代码已经集成官方 OpenAI-compatible Router：

```text
POST https://router-api.0g.ai/v1/chat/completions
Authorization: Bearer $ZERO_G_API_KEY
X-0G-Provider-Trust-Mode: private
```

配置模型：

- `0GM-1.0-35B-A3B`：语义主审
- `0GM-1.0-35B-A3B-SIA`：红队复核

Live 适配器会并行调用两个模型，保存 response ID、实际模型、token usage、延迟以及 API 实际返回的 proof / attestation / verification 元数据。当前提交使用 `ZERO_G_FORCE_DEMO=true`，因此演示回执明确标记为 simulation，不声称是 0G TEE proof。

## 可运行 Demo

```bash
npm install
cp .env.example .env
# 将 ZERO_G_FORCE_DEMO 设置为 true
npm run dev
```

打开 `http://localhost:5173`，页面右上角显示 `DEMO / 0G READY`。

预置场景：

1. 正常换仓：三票通过并签发 Permit
2. Prompt Injection：恶意 memo 被隔离并阻断
3. 无限授权：超过 Owner Policy 上限
4. 滑点异常：9.8% 滑点触发拒绝
5. 篡改挑战：修改模型响应后 commitment 立即失配

## 技术架构

```text
Agent transaction
  -> Interceptor
  -> 0G semantic reviewer role
  -> 0G SIA red-team role
  -> Deterministic Owner Policy
  -> Unanimous decision compiler
  -> Scoped one-time Permit or BLOCK
```

技术栈：React 19、Vite、Express 5、ethers.js、Vitest、0G OpenAI-compatible Router。

## GitHub 提交字段

- Repository：`<替换为公开 GitHub URL>`
- Demo URL：`<替换为部署 URL>`
- Video URL：`<替换为 3 分钟内视频 URL>`
- Track：Build with 0G Private Computer
- Sponsor：0G Labs

## 合规状态

| 要求 | 当前状态 |
|---|---|
| 集成 0G 模型与官方 API 代码 | 已完成 |
| 真实成功调用官方 API | 未完成，Demo 模式不发出请求 |
| 可运行 Web App | 已完成 |
| GitHub + README | 本地内容已完成，待发布公开仓库 |
| 3 分钟内视频脚本 | 已完成，待录制与上传 |

若要让第一项硬性要求真正通过，必须关闭 `ZERO_G_FORCE_DEMO`、为 0G 账户充值并取得至少一个真实 response ID。

