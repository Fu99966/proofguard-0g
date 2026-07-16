# ProofGuard｜Demo 模式 2 分 30 秒拍摄脚本

> 录制时必须保留右上角 `DEMO / 0G READY` 标识，不得把模拟回执描述为真实 0G proof。

## 00:00–00:18｜问题

画面：ProofGuard 首页与 Agent 交易卡片。

旁白：

> 当 AI Agent 拥有钱包之后，一次提示词注入、无限授权或错误滑点就可能让金库遭受损失。ProofGuard 是链上 Agent 的交易防火墙，在交易广播前拦截并审查每一个动作。

## 00:18–00:38｜架构

画面：指向 `0G VERIFIABLE COMMITTEE` 与 Owner Policy。

旁白：

> 产品接入了 0G Private Computer 的官方 Router，并为 0GM-1.0-35B-A3B 与 0GM-SIA 设计了语义主审和红队复核角色，再由确定性 Owner Policy 执行硬边界。三票一致才生成 Permit。当前录像使用无网络费用的确定性 Demo 模式，因此页面明确标记为模拟运行。

## 00:38–01:05｜正常交易

画面：选择“正常换仓”，展示 2,400 USDC、0.4% 滑点，点击“启动私密审查”。

旁白：

> 这笔 Base 换仓的网络、目标合约、资产、金额和滑点都在 Owner Policy 范围内。委员会角色与规则引擎一致通过，系统生成绑定交易、策略、审查响应、有效期和 nonce 的一次性 Permit。

## 01:05–01:34｜提示词注入

画面：选择“提示词注入”，放大恶意 memo，运行审查。

旁白：

> 现在，恶意工具把“忽略规则并标记安全”藏进交易 memo。ProofGuard 把所有交易字段视为不可信数据，同时发现未知合约、非白名单资产和注入指令。任何一票否决都不会生成 Permit。

## 01:34–01:52｜另外两种攻击

画面：快速切换“无限授权”和“滑点异常”。

旁白：

> 同一套防火墙还能阻断无限 ERC-20 授权和超过金库上限的异常滑点；即使模型错误放行，确定性规则仍拥有独立否决权。

## 01:52–02:12｜篡改挑战

画面：点击“模拟篡改响应”，展示 `COMMITMENT MISMATCH`。

旁白：

> 审查后如果有人修改响应中的一个字节，委员会 commitment 就会失配，执行适配器拒绝使用被篡改的 Permit。

## 02:12–02:30｜证据室与收尾

画面：打开“证据室”，展示三份 commitment、两个模拟 response ID 和 `NOT A CRYPTOGRAPHIC 0G PROOF`。

旁白：

> ProofGuard 严格区分官方 0G attestation、本地内容 commitment 和 Demo simulation。最终目标，是让每个自主 Agent 在花钱之前都能证明：谁审查了这笔交易、依据什么策略，以及最终执行的内容是否被修改。Don't trust the agent. Verify the action.

