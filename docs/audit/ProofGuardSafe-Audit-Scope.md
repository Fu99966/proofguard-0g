# ProofGuardSafe 第三方合约审计范围

第三方合约审计完成前，运行范围限 Base Sepolia 和测试资金。

## 冻结版本和待审范围

- 新版候选冻结于 `4aae9a6e535cfe16a7f29bbee0bee0670e7287e1`。本地冻结包包含源码、编译配置、相关 SDK、迁移说明、Foundry、LCOV、Slither 和逐文件校验和。新版仅在本地分叉部署和执行。 [冻结包](../../var/audit/issuer-rotation/ProofGuardSafe-4aae9a6.zip) · [ZIP 校验和](../../var/audit/issuer-rotation/ProofGuardSafe-4aae9a6.zip.sha256)
- 待审范围包括 `ProofGuardSafe`、`ISafeModuleExecutor`、两套 Safe v1.5.0 Guard 回调，以及签发和迁移边界。旧版源码快照在本地身份整理后的等价提交为 `63e2e11bb89f20f02a36e7baa453dad25aadb9b9`，两者文件树与原旧版冻结快照一致。独立审查 Safe、Permit2、路由器、代币、模型及完整 API 架构另计范围。 [Guard 源码](../../contracts/src/ProofGuardSafe.sol) · [迁移步骤](ProofGuardSafe-Migration.md)
- 新版 Guard 的 Git 源文件 blob 为 `1c551a8db5216cd1cfa9ec34bc1ae14e9bf0f9a1`，源文件 SHA-256 为 `759bbfac95078e8a40fdb7a67730a4f6df68a775454742a40e190eb1850f362d`。编译设置为 solc 0.8.30、`viaIR`、optimizer 200、`osaka`。 [构建清单](../../var/audit/issuer-rotation/build-manifest.json)

## 校验与信任边界

| 路径 | 校验与状态变化 |
| --- | --- |
| 部署与安装 | Guard 限制链 ID 84532，绑定 Safe 和 Agent，验证初始角色地址。Safe 同时安装 transaction guard、module guard 及对应模块。需保持 Agent、issuer 与 Safe Owner 分离。 |
| 普通 Owner 交易 | Safe 验证 Owner 签名门槛。Guard 检查操作类型、退款参数和准确的 Permit，限制过期与 nonce 重用。 |
| 模块交易 | 仅绑定的 Agent 可经已安装模块执行。暂停时拒绝提交。核对 Permit、目标、金额、calldata、回调和执行结果。失败回滚 nonce 与消费记录。 |
| Owner 恢复 | 仅允许 Safe 完成了既有 Owner 签名门槛后，以零金额、精确 calldata 调用 Guard 的恢复入口。Agent 和当前 issuer 的直接调用及以这两个地址提交恢复事务均被拒绝。单笔更换 issuer、递增代次、暂停 Agent，发出包含新旧 issuer 和代次的 `IssuerRecovered`。 |
| 代次失效与恢复运行 | EIP-712 域在第 0 代保留兼容格式，之后以代次作为 salt。Owner 登记按代次隔离。旧签名和登记不会在代次提升后复活，即使再次选中同一个 signer 地址。Owner 达到门槛后可单独恢复 Agent，普通交易仍检查 Permit。 |
| 服务端签发 | 服务端与 SDK 使用 `issuerEpoch` 构造签名域，审查模式仍由 `permitHash` 绑定。恢复后应重配签发 key 和代次并重启服务与 Agent。设置滞后的客户端可能产生链上无法使用的 Permit，部署前应验证读回值。 |

## 已知限制

- **旧部署迁移仍依赖旧 issuer。** 旧版 `issuer` 为 `immutable`，现有 Safe 的 Guard 与模块配置需要旧 issuer 签发管理 Permit。旧 issuer 已丢失时，没有经验证的独立卸载或迁移路径。历史复跑证实新签名被旧 Guard 判为 `InvalidSignature`，仅 Owner 授权会返回 `MissingPermit`。有权签发与有权提交属于分开的角色。已提交或已执行的交易不会因新版轮换而回滚。 [旧版复跑](../../var/handoff/issuer-recovery/foundry-current-recovery.log)
- 新版应复核 Safe 签名校验先于事务 Guard、控制入口的 calldata 白名单、Owner 管理交易和模块路径之间的隔离、轮换与并发交易排序、已登记 Permit 的代次隔离，以及暂停和恢复事件的监控。Owner 门槛仍是恢复信任根。
- 当前规则、报价源和模型证据位于签发前。Guard 校验签名和已签名的动作边界。第三方应分别复核下游标的、价格时效与链上排序。

## 验证证据

- **Foundry 29 项通过。** 18 项单元测试、10 项真实 Safe v1.5.0 分叉集成、1 项 invariant。分叉固定 Base Sepolia 区块 `61349084`，哈希 `0x8c3cfe69dc02b1ea8d827a531733049e8c8a01a0c143601960c3537035fd480d`。新增用例验证丢失、泄露后继续签发、Owner 签名未达门槛，以及旧代签名与登记重放。2-of-2 用例确认一个签名不足、两个有效签名可恢复。无有效 Permit 的 invariant 共 3,072 次调用。 [测试日志](../../var/audit/issuer-rotation/fork-tests.log)
- **Foundry 分支覆盖 24/24（100%）。** 行 76/82（92.68%），语句 135/141（95.74%），函数 15/15（100%）。统计基于 `--ir-minimum`，其源码映射警告保留在日志中。 [覆盖率日志](../../var/audit/issuer-rotation/fork-coverage.log) · [LCOV](../../var/audit/issuer-rotation/coverage.lcov)
- **迁移演练。** 在本地 Anvil 分叉从旧版部署字节码升级到新版，校验两套新 Guard 与旧模块停用。恢复并获 Owner 允许后，HTTP/API、SDK 和链上 Guard 完成第 1 代 rules-only Permit 的签发与执行。应用测试 116 项通过，构建成功，零 0G 请求。 [迁移 Gas 和链路记录](../../var/audit/issuer-rotation/migration-gas.log)
- **Slither。** 0.11.6 复跑 102 个检测器，结果为两条 Low impact、Medium confidence 的 `timestamp`，对应 `_verify` 和 `_consume` 的到期判断。JSON 记录分析成功。进程在报告发现项后退出 255。 [Slither 结果](../../var/audit/issuer-rotation/slither.json)

在冻结版本中先运行 `npm ci`。分叉与覆盖率复现命令如下。命令只读取公开 RPC，测试写入由 Foundry 在本地模拟。

```sh
export FOUNDRY_INVARIANT_RUNS=128 FOUNDRY_INVARIANT_DEPTH=24 FOUNDRY_INVARIANT_FAIL_ON_REVERT=true
npm run test:contracts -- --fork-url https://sepolia.base.org --fork-block-number 61349084 \
  --fuzz-seed 0x2d63284cb6cf36e8f6257ea26e7ea425fc47aff1fdf962570b58bc65b9ca7ad
node node_modules/@foundry-rs/forge/bin.mjs coverage --fork-url https://sepolia.base.org --fork-block-number 61349084 \
  --fuzz-seed 0x2d63284cb6cf36e8f6257ea26e7ea425fc47aff1fdf962570b58bc65b9ca7ad \
  --ir-minimum --exclude-tests --report summary --report lcov
```

## 第三方审计候选

周期用于排期比较。金额、预约等待、修复和复检周期由机构按最终范围确认。已核对公开资料，未联系机构。

| 机构 | 已有相关经验 | 报价方式 | 初审周期参考 |
| --- | --- | --- | --- |
| ChainSecurity | Makina Lite 的 Safe 模块授权、操作白名单和交易执行。 | 提交范围、约略代码行数、可交付日期后按项目定价，确认具体范围后给正式报价。 | 内部排期可先按约 2 个工作周估算。2022 年公开流程示例以第 2 周给初稿为节点，实际按冻结范围约定。 [案例](https://www.chainsecurity.com/security-audit/makina-lite) · [报价入口](https://www.chainsecurity.com/request-audit) · [公开流程示例](https://old.chainsecurity.com/wp-content/uploads/2022/08/ChainSecurity-brochure.pdf) |
| OpenZeppelin | Oxorio SAMM 同时包含 Safe module、`ModuleGuard` 及更广的密码学范围。 | 离散安全审计采用预先约定范围和固定项目报价。 | 同类公开案例为 2024-12-09 至 2025-01-03，约 4 个自然周。以该范围较大的案例作为排期参照。 [报价模式](https://www.openzeppelin.com/faqs/openzeppelin) · [案例和时间线](https://www.openzeppelin.com/news/oxorio-samm-module-audit-1) |
| Trail of Bits | 有小型 Guard 和权限控制审计，审计流程覆盖集成、不变量和复检。 | 按代码、部署和威胁模型定范围及投入。官网未提供该规模的固定价格。 | 小型 Guard 公开案例投入 1.6 人周。按单人连续投入推算初审约 1–2 个工作周，实际日历周期取决于人员安排和范围。 [Guard 案例](https://trailofbits.com/library/offchain-labs-osp-soundness-guard/) · [服务与工作量口径](https://trailofbits.com/services/blockchain/) · [报价入口](https://trailofbits.com/contact/) |
