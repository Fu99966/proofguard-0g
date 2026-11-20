# Base Sepolia Guard 迁移步骤

状态为待批准部署。以下步骤已用旧版部署字节码和新版候选字节码在本地 Anvil 分叉演练，所有交易均停留在本地分叉。

## 前置条件

核对网络为 Base Sepolia（84532）、Safe 版本为 1.5.0、两套 Guard 指向预期旧地址、已启用模块列表、Owner 签名门槛和下一笔 Safe nonce。确认 Owner、Agent 和 issuer 各自的地址及职责，确保 Agent 和 issuer 都不在 Owner 列表。暂停 Agent 进程并清空待提交提案。部署前重新编译并与审计包核对字节码，使用新生成的测试网 issuer。

旧版 Guard 的事务检查仍要求原 issuer 签署替换交易的 Permit。如果原 issuer 已丢失，当前部署没有已验证的独立卸载或迁移路径。如果原 issuer 已泄露，暂停本地进程无法撤回旧签名，应先停止自动提交并重新评估现有 Safe 的风险，避免把本清单当作无原 issuer 的应急方案。

## 顺序和检查

1. 经批准后部署新版 Guard，构造参数为现有 Safe、专用 Agent、新 issuer。读回 `safe`、`agent`、`issuer`、`issuerEpoch`（应为 0），并核对 ERC-165 接口。
2. 从旧 issuer 取得针对 `enableModule(newGuard)` 的短期、零金额 Permit。提交登记，再由 Safe Owner 达到门槛执行并确认。当前 Guard 配置仍承担拦截。
3. 同样由旧 issuer 签发专用 Permit，让 Safe 先执行 `setModuleGuard(newGuard)`，再执行 `setGuard(newGuard)`。每笔用不同 nonce，收到成功回执后读回对应插槽再继续。模块 Guard 切换后旧模块的执行请求会被新版模块 Guard拒绝。两步之间维持 Agent 停止状态。
4. 用新 issuer 的第 0 代 Permit 让 Safe 执行 `disableModule(predecessor, oldGuard)`。按当时的模块列表读取 `predecessor`。旧 Guard 从两个 Guard 插槽移除并退出模块列表。
5. 读回两套 Guard、新旧模块使能状态、Owner 列表、阈值和 signer。以只读模拟验证旧 Permit、未登记的 Owner 交易以及未授权模块均被拒绝。更新本地服务的 Guard 地址、issuer key 和 `PROOFGUARD_TESTNET_ISSUER_EPOCH`，重启服务与 Agent。是否进行公开链 smoke 另按部署授权执行。

新版后续发生 issuer 丢失或泄露时，由 Safe Owner 达到门槛发起 `recoverIssuer(newIssuer)`，无需旧 issuer。确认 `IssuerRecovered`、代次提升和 Agent 暂停。更新本地签发配置并验证后，再由 Owner 用专用 `resumeAgent()` 事务恢复 Agent。正常 Owner 交易继续需要当前代次的 Permit。

## 测试 ETH 估算

Base Sepolia 分叉使用 1-of-1 Safe，迁移共 9 笔外层交易。实测共 `2,217,332 gas`，其中部署 `1,113,014 gas`，后续四组登记及 Owner 执行共 `1,104,318 gas`。在 Base Sepolia 区块 `61379404` 的只读报价为 `0.006 gwei`，按测得 gas 与 OP GasPriceOracle 数据费估算，合计约 **0.000014 测试 ETH**。实际费用随报价、签名门槛和交易字节数变化。 [GasPriceOracle 规范](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/predeploys.md#gaspriceoracle)

建议为付款钱包预留 **0.002 测试 ETH** 以覆盖迁移和复查。如果单独授权 Agent 上链 smoke，另给 Agent 付款钱包预留 **0.001 测试 ETH**。预留金额包含费用波动和重试余量，实际执行前还需重新估算。整个演练未支出测试网 ETH。
