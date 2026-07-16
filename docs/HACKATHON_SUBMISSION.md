# ProofGuard｜黑客松提交稿

## 基本信息

- 赛道：赛道二 — Build with 0G Private Computer
- 合作方：0G Labs
- 产品形态：Web App + Agent transaction firewall API
- 一句话：每一笔 AI Agent 发起的链上交易，都必须先通过两个 0G 可验证 AI 和一套确定性策略的三票安全审查。
- GitHub：`<提交前替换为公开仓库 URL>`
- Demo：`<提交前替换为部署 URL>`
- 演示视频：`<提交前替换为 3 分钟内视频 URL>`

## 项目简介

ProofGuard 是链上 Agent 的交易防火墙。Agent 生成 EVM 交易后，系统在广播前拦截交易，把意图、目标合约、资产路径、授权、滑点和不可信 memo 交给 0G Private Computer。`0GM-1.0-35B-A3B` 负责语义主审，`0GM-1.0-35B-A3B-SIA` 负责独立红队复核；Owner Policy 同时执行确定性硬规则。三票一致才签发绑定交易哈希、策略哈希、委员会响应哈希、有效期和 nonce 的一次性 Permit。

## Sponsor 技术接入

- 官方端点：`POST https://router-api.0g.ai/v1/chat/completions`
- 主审模型：`0GM-1.0-35B-A3B`
- 红队模型：`0GM-1.0-35B-A3B-SIA`
- 请求模式：`X-0G-Provider-Trust-Mode: private`
- 证据：保存两个真实 response ID、实际模型名、token usage、延迟，以及响应中实际返回的 proof / attestation / verification 和相关响应头
- 安全边界：绝不把本地 SHA-256 commitment 或 Demo receipt 冒充 0G TEE proof

## 核心亮点

1. Sponsor-native：核心决策链直接依赖两个 0G 自研模型，而不是把 0G 当装饰性 API。
2. 可验证推理有业务价值：验证结果决定链上交易能否获得执行 Permit。
3. Web3 原生：面向 DAO 金库、DeFi 策略和自主钱包 Agent 的交易执行安全。
4. 多模型协作：语义主审与安全红队角色分离，单票否决并 fail closed。
5. 可演示：正常换仓、提示词注入、无限授权、滑点异常四个一键场景，以及响应篡改挑战。

## 评审现场 90 秒黄金路径

1. 指向右上角 `LIVE 0G` 和中间 `2 MODELS / UNANIMOUS`，证明真实 0G 双模型模式。
2. 运行“正常换仓”，展示三票一致、Permit、两个 response ID 和委员会 commitment。
3. 运行“提示词注入”，展示恶意 memo、`BLOCK` 和无 Permit。
4. 点击“模拟篡改响应”，展示 `COMMITMENT MISMATCH`。
5. 打开“证据室”，说明 0G attestation、本地 commitment 和 Demo receipt 三者严格分层。

## 提交前硬性检查

- [ ] `.env` 已配置有效 `ZERO_G_API_KEY`，且密钥未提交 Git
- [ ] `npm run smoke:0g` 成功返回两个真实 0G response ID
- [ ] 页面右上角为 `LIVE 0G`，不是 `DEMO / 0G READY`
- [ ] `npm test` 与 `npm run build` 均通过
- [ ] GitHub 仓库公开，README 安装与 0G 接入步骤可复现
- [ ] 部署链接可在无本机环境下打开
- [ ] 演示视频少于 3 分钟，画面能看清 `LIVE 0G`、模型名和 response ID
- [ ] 视频、GitHub、Demo 三个 URL 已替换本文占位符

## 后续迭代

- Safe Module / ERC-7579 validator，把 Permit 变为链上强制执行条件
- RPC state simulation、价格预言机和 bytecode reputation
- 官方 verifier 接口开放后接入链上 attestation 校验
- 持久化 nonce registry、审计日志、速率限制和多租户 Policy SDK

