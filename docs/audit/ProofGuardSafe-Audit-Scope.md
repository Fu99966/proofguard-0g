# ProofGuardSafe 第三方合约审计范围

准备日期 2026-11-21。第三方合约审计完成前，运行范围限 Base Sepolia 和测试资金。

## 冻结版本和待审范围

- 合约、测试及构建配置冻结在本地提交 `d718af16d6af16cb2dd6d327b34eead9dddafd38`，Guard 源码最后一次修改在 `fb1e785c2064423784dd1d8200691409d028028f`。审计交接以冻结包中的 Git 源文件和随附证据为准。
- 待审合约是 `ProofGuardSafe` 及同文件的 `ISafeModuleExecutor` ABI。合约文件 Git blob 是 `1401bec4032244a33465bbc409664b200a07da3c`，SHA-256 是 `32c9632f4a2a3e1c13ef64ac4f547e800634d0f2b471bb74a97ca1304def0dad`。[合约源码](../../contracts/src/ProofGuardSafe.sol)
- 复核 Safe v1.5.0 的 owner guard、module guard 及 module 接口如何调用 ProofGuardSafe。把部署与安装配置、签名工具、链 ID、Safe 代理、单例及 factory 校验作为集成证据。独立复审 Safe、Permit2、路由器及代币合约另计范围。[部署脚本](../../scripts/deploy-testnet-safe.js) · [Safe 安装检查](../../sdk/safeSetup.js) · [签名封装](../../sdk/guard.js)
- 模型、规则引擎、报价源及公网 API 的全面安全评估另计范围。Permit 签发接口、密钥权限和链上信任关系纳入本次审计的边界检查。新版 Permit 把审查模式、模拟标志和证据摘要纳入 `permitHash`，SDK 重算哈希，链上通过 EIP-712 签名校验该哈希。[Permit 承诺](../../sdk/permit.js) · [审查模式验证](../../sdk/review.js)
- 冻结包从固定提交的白名单路径打包，附 Foundry、LCOV、Slither、字节码复核证据、复现说明和逐文件哈希。ZIP 的 SHA-256 为 `b5c41a1c7fa486d46e99d1b5f2c27c40de82db302dd027253f63d47dafb510b8`。[冻结包](../../var/audit/2026-11-21-release/ProofGuardSafe-d718af1.zip) · [逐文件哈希](../../var/audit/2026-11-21-release/MANIFEST.sha256)

## Guard 的校验逻辑

| 路径 | 校验与状态变化 |
| --- | --- |
| 部署与安装 | 合约构造函数限制在链 ID 84532 部署，要求 Safe 地址有代码，Safe、Agent、issuer 互异且非零。安装流程核对官方 Safe v1.5.0 部署配置，启用该模块并把同一合约设为 owner guard 和 module guard。 |
| EIP-712 Permit | 签名域绑定 `ProofGuard`、版本 `1`、链 ID 和本 Guard 地址。结构体绑定 Safe `from`、`to`、`value`、`dataHash`、`deadline`、`nonce` 及 `permitHash`。校验签发者、65 字节签名、低 `s`、`v`、Safe 地址、非零哈希、未到期及未消费 nonce。 |
| Agent | 仅注册 Agent 调用 `executeGuarded`。直接目标不得为 Safe 或 Guard 自身。Permit 必须匹配目标、原生代币金额和 calldata 哈希。Guard 使用 nonce 后，通过 Safe 模块执行 `CALL` 并核对同一动作的 guard 回调与执行结果。 |
| Safe owner | `authorizeOwnerTransaction` 可由任意提交者登记有效签名，按 `to`、`value`、calldata 哈希索引。Safe 进入 `checkTransaction` 时仅允许 `CALL`，检查零退款配置、登记的 Permit、当前有效期及 nonce，同时消费 nonce 并删除登记。 |
| Safe 回调 | 仅固定 Safe 可调用 guard hooks。模块回调还要求 module 为本 Guard 且匹配待执行动作。owner 和 module 的执行后回调遇到失败会 revert。审计需验证真实 Safe 下回调顺序及失败时 nonce、待执行动作和交易状态是否原子回滚。 |

## 威胁模型和已知限制

| 边界或故障 | 第三方审计重点 |
| --- | --- |
| Agent、Safe owner 或外部调用者未持有有效许可 | 检查双 guard 注册和 owner、模块、Safe 管理路径实际受控。验证未经授权的操作、交易字段变更、重放、过期和异常调用被拒绝。 |
| 两笔相同动作、并发 owner 登记、nonce 争用和执行失败 | 检查同一动作的有效许可可覆盖预登记记录时，是否仍只执行准确授权的动作，评估时效、撤销需求、观察到的链上事件和可用性。验证失败回滚与重试行为。 |
| issuer 密钥泄露或无法签名 | issuer 是链上最终审批信任根，合约用 `ecrecover`、固化 issuer 地址，当前没有签发端轮换、撤销、独立暂停或 EIP-1271 支持。复核权限隔离、操作恢复和更换 Guard 的路径，特别是恢复操作自身需要 Permit 的依赖。 |
| calldata、路由器状态、行情源或下游合约状态变化 | 链上校验覆盖已签名的交易动作及其时限。报价真实性、持仓 mandate、模型判决、0G/Router 证明及标的合约行为由签发前的系统和集成假设约束。检查允许范围、升级和部署时的 trust assumptions。 |
| 时间边界与链上环境变化 | 检查签发与消费阶段的 `block.timestamp` 边界、Permit 短时有效期和排序延迟，明确跨链或未来网络迁移时的构造和安装变更。 |

## Foundry 测试和实际部署

从冻结锁文件在独立目录执行 `npm ci`。Foundry 1.7.1 使用已锁定的 solc-js `0.8.30+commit.73712a01`、`viaIR`、optimizer 200 和 `osaka`。编译器的开发依赖 `tmp` 由作用域限定的 override 锁定在 0.2.7，对应修复 CVE-2025-54798、CVE-2026-44705 和 CVE-2026-49982。本次 `npm audit` 报告 0 项发现。 [依赖维护者公告](https://github.com/raszi/node-tmp/security) · [依赖审查证据](../../var/audit/2026-11-21-release/npm-audit.json)

分叉测试全部 24 项通过，含 17 项本地测试、6 项真实 Safe 集成测试及 1 项状态不变量测试。[本地测试](../../contracts/test/ProofGuardSafe.t.sol) · [分叉和不变量](../../contracts/test/fork/ProofGuardSafeFork.t.sol) · [分叉日志](../../var/audit/2026-11-21-release/fork-foundry.log)

- 分叉固定在 Base Sepolia 区块 `61349084`，区块哈希 `0x8c3cfe69dc02b1ea8d827a531733049e8c8a01a0c143601960c3537035fd480d`。测试校验链 ID 84532、区块号、Safe v1.5.0 singleton 和 factory 的 runtime 哈希，并通过链上 factory 在本地分叉创建测试 Safe。测试使用固定测试角色，写入均在本地分叉，链上只读。
- ERC-165 测试检查两个 Guard 接口可安装，也检查拒绝无效接口 ID。Owner 和 module 路径分别验证真实 Safe 的前后回调、Permit 消费事件和 nonce。被调用方失败后，Safe nonce、Permit nonce 及目标状态回滚，恢复后同一个 Permit 可执行一次。
- Guard 替换测试验证当前 issuer 的签名是更换的前提。通过有效签名更换两个 guard slot、停用旧模块后，新 issuer 可恢复 owner 和 module 两条路径。原 issuer 签名失效且只有 owner 授权无法更换，issuer 已丢失时无法用这一套部署恢复。
- 不变量用 128 轮、每轮 24 步测试无有效 Permit 时真实 Safe 的执行路径。3,072 次调用含 1,532 次 owner 和 1,540 次 module，覆盖缺失、过期、签名错误、calldata 不符和已消费 nonce。每次预期的内部 revert 由测试处理器捕获。断言实际调用回滚，Safe nonce 和目标状态不变，过期许可未被消费。

| 合约 | 行 | 语句 | 分支 | 函数 |
| --- | --- | --- | --- | --- |
| `ProofGuardSafe.sol` | 59/63，93.65% | 106/110，96.36% | 20/20，100.00% | 13/13，100.00% |

覆盖率统计使用 `--ir-minimum`，达到 80% 分支门槛。数字采用 Foundry 对冻结项目合约的插桩口径，IR 位置映射警告保留在日志。正式字节码复核使用常规 optimizer 200 构建。离线运行可重复 17 项本地测试，分叉验证需要能读取指定区块的 RPC。[覆盖率日志](../../var/audit/2026-11-21-release/fork-coverage.log) · [LCOV](../../var/audit/2026-11-21-release/coverage.lcov) · [离线日志](../../var/audit/2026-11-21-release/offline-foundry.log)

此前实测部署在同一区块的只读核对确认 Safe 版本为 `1.5.0`，交易和模块 guard slot 均指向 `0xF8969fd65bDBb525d66B5e191759fcB59034310C`，该模块已启用。当前冻结源码按部署配置编译的 creation 和 runtime 字节码及 metadata 与部署工件一致。屏蔽编译器声明的 immutable 地址位置后，部署地址的 runtime 与工件完全匹配。[链上 Guard](https://sepolia.basescan.org/address/0xF8969fd65bDBb525d66B5e191759fcB59034310C) · [构建与只读证据](../../var/audit/2026-11-21-release/build-equivalence.json)

在冻结版本的仓库运行以下命令可复现测试。

```sh
npm ci
export FOUNDRY_INVARIANT_RUNS=128 FOUNDRY_INVARIANT_DEPTH=24 FOUNDRY_INVARIANT_FAIL_ON_REVERT=true
npm run test:contracts -- --fork-url https://sepolia.base.org --fork-block-number 61349084 \
  --fuzz-seed 0x2d63284cb6cf36e8f6257ea26e7ea425fc47aff1fdf962570b58bc65b9ca7ad
node node_modules/@foundry-rs/forge/bin.mjs coverage --fork-url https://sepolia.base.org --fork-block-number 61349084 \
  --fuzz-seed 0x2d63284cb6cf36e8f6257ea26e7ea425fc47aff1fdf962570b58bc65b9ca7ad \
  --ir-minimum --exclude-tests --report summary --report lcov
```

## Slither 结果

Slither `0.11.6`、crytic-compile `0.4.2` 和 Foundry 使用 `0.8.30` 分析 2 个合约条目（含接口）、运行 102 个检测器，输出 2 条 `timestamp`，级别为 Low impact、Medium confidence。JSON 记录分析成功，进程在报告发现项后以 255 退出。当前锁文件重新编译后，已核对合约源码 SHA-256 与实际构建字节码一致，沿用此静态分析证据。[Slither 报告](../../var/audit/2026-11-21-release/package-d718af1/evidence/slither.json) · [版本与哈希核对](../../var/audit/2026-11-21-release/source-version.json)

| 发现 | 位置 | 初步核对 |
| --- | --- | --- |
| `timestamp` | `_verify` 第 119 行 | 验证签名 Permit 是否仍在有效期，审计复核精确边界和链上排序影响。 |
| `timestamp` | `_consume` 第 131 行 | 消费时再次判断到期，适用于预先登记、稍后执行的 owner 路径。同样复核 TTL 和执行边界。 |

本次静态分析没有 High 或 Medium impact 结果。两条检测涉及有意保留的到期检查，第三方仍需判断其时效假设和实际风险。[Slither 时间戳检测器](https://github.com/crytic/slither/wiki/Detector-Documentation#block-timestamp)

## 第三方审计候选

周期用于排期比较。金额、预约等待、修复和复检周期由机构按最终范围确认。已核对公开资料，未联系机构。

| 机构 | 已有相关经验 | 报价方式 | 初审周期参考 |
| --- | --- | --- | --- |
| ChainSecurity | Makina Lite 的 Safe 模块授权、操作白名单和交易执行。 | 提交范围、约略代码行数、可交付日期后按项目定价，确认具体范围后给正式报价。 | 内部排期可先按约 2 个工作周估算。2022 年公开流程示例以第 2 周给初稿为节点，实际按冻结范围约定。 [案例](https://www.chainsecurity.com/security-audit/makina-lite) · [报价入口](https://www.chainsecurity.com/request-audit) · [公开流程示例](https://old.chainsecurity.com/wp-content/uploads/2022/08/ChainSecurity-brochure.pdf) |
| OpenZeppelin | Oxorio SAMM 同时包含 Safe module、`ModuleGuard` 及更广的密码学范围。 | 离散安全审计采用预先约定范围和固定项目报价。 | 同类公开案例为 2024-12-09 至 2025-01-03，约 4 个自然周。以该范围较大的案例作为排期参照。 [报价模式](https://www.openzeppelin.com/faqs/openzeppelin) · [案例和时间线](https://www.openzeppelin.com/news/oxorio-samm-module-audit-1) |
| Trail of Bits | 有小型 Guard 和权限控制审计，审计流程覆盖集成、不变量和复检。 | 按代码、部署和威胁模型定范围及投入。官网未提供该规模的固定价格。 | 小型 Guard 公开案例投入 1.6 人周。按单人连续投入推算初审约 1–2 个工作周，实际日历周期取决于人员安排和范围。 [Guard 案例](https://trailofbits.com/library/offchain-labs-osp-soundness-guard/) · [服务与工作量口径](https://trailofbits.com/services/blockchain/) · [报价入口](https://trailofbits.com/contact/) |
