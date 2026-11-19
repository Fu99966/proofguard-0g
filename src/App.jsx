import { TypedDataEncoder } from "ethers";
import { baseSepolia } from "../sdk/network.js";
import { permitTypedData } from "../sdk/permit.js";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Copy,
  Cpu,
  ExternalLink,
  Fingerprint,
  Gauge,
  Hexagon,
  KeyRound,
  LockKeyhole,
  Network,
  OctagonX,
  Play,
  Radar,
  RefreshCw,
  ScanLine,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wallet,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const modeLabels = {
  live: "LIVE 0G CONFIGURED",
  demo: "DEMO / NO 0G CALLS",
  unavailable: "0G CONFIG ERROR",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortHash = (value, start = 12, end = 8) => value ? `${value.slice(0, start)}…${value.slice(-end)}` : "—";
const money = (value) => `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function App() {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState("safe-swap");
  const [reviewMode, setReviewMode] = useState("demo");
  const [phase, setPhase] = useState("idle");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [view, setView] = useState("firewall");
  const [wallet, setWallet] = useState("");
  const [signature, setSignature] = useState("");
  const [execution, setExecution] = useState(null);
  const [tamper, setTamper] = useState(null);
  const [logs, setLogs] = useState([
    { type: "neutral", text: "Policy POL-7F3A loaded into deterministic gate" },
    { type: "neutral", text: "Waiting for autonomous agent transaction" },
  ]);

  useEffect(() => {
    fetch("/api/demo")
      .then((response) => {
        if (!response.ok) throw new Error("ProofGuard API unavailable");
        return response.json();
      })
      .then(setData)
      .catch((reason) => setError(reason.message));
  }, []);

  const scenario = useMemo(
    () => data?.scenarios.find((item) => item.id === selectedId),
    [data, selectedId],
  );

  function appendLog(text, type = "active") {
    setLogs((current) => [...current, { type, text }].slice(-8));
  }

  function selectScenario(id) {
    if (phase !== "idle" && phase !== "complete" && phase !== "error") return;
    setSelectedId(id);
    setReviewMode("demo");
    setResult(null);
    setSignature("");
    setExecution(null);
    setTamper(null);
    setError("");
    setPhase("idle");
    setLogs([
      { type: "neutral", text: `Scenario ${id.toUpperCase()} armed` },
      { type: "neutral", text: "Waiting for review command" },
    ]);
  }

  async function runReview(proposal) {
    const custom = Boolean(proposal?.transaction);
    setReviewMode(custom ? data.status.agentReviewMode : "demo");
    setResult(null);
    setSignature("");
    setExecution(null);
    setTamper(null);
    setError("");
    setLogs([]);
    try {
      setPhase("intercept");
      appendLog("Transaction intercepted before wallet broadcast");
      await sleep(520);
      appendLog("Untrusted proposal fields isolated for review");
      setPhase("inference");
      appendLog(custom ? "Submitting decoded-calldata review" : "Running two simulated reviews locally");

      const response = await fetch(custom ? "/api/review" : "/api/demo/review", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(custom ? { Authorization: `Bearer ${proposal.apiKey}` } : {}) },
        body: JSON.stringify(custom ? { transaction: proposal.transaction } : { scenarioId: selectedId }),
        signal: AbortSignal.timeout(100_000),
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Review failed");

      setPhase("policy");
      appendLog("AI verdict compiled with deterministic owner policy");
      await sleep(620);
      appendLog(
        payload.decision === "ALLOW" ? "Scoped execution permit sealed" : "Execution blocked; no permit emitted",
        payload.decision === "ALLOW" ? "success" : "danger",
      );
      setResult(payload);
      setPhase("complete");
    } catch (reason) {
      setError(reason.message);
      appendLog(reason.message, "danger");
      setPhase("error");
    }
  }

  async function connectWallet() {
    setError("");
    try {
      if (!window.ethereum) throw new Error("未检测到兼容的 EVM 钱包。");
      const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setWallet(account || "");
      return account;
    } catch (reason) {
      setError(reason.message || "钱包连接失败");
    }
  }

  async function signPermit() {
    try {
      setError("");
      const account = await connectWallet();
      if (!account) return;
      if (account.toLowerCase() !== result.permit.owner.toLowerCase()) {
        throw new Error("当前钱包不是策略指定的签名钱包。");
      }
      const { domain, types, message } = permitTypedData(result.permit, result.transaction);
      const signed = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [account, JSON.stringify(TypedDataEncoder.getPayload(domain, types, message))],
      });
      setWallet(account);
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          permitHash: result.permit.permitHash,
          transaction: result.transaction,
          signature: signed,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Execution adapter rejected the permit");
      setSignature(signed);
      setExecution(payload);
      appendLog("Signature verified; one-time permit consumed", "success");
    } catch (reason) {
      setError(reason.message || "Wallet signature rejected");
    }
  }

  async function testTamper() {
    const modified = `${result.inference.rawDecision} `;
    try {
      setError("");
      const response = await fetch("/api/verify-commitment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: modified, expectedHash: result.evidence.responseCommitment }),
      });
      const verification = await response.json();
      if (!response.ok || verification.valid !== false) throw new Error("Unconfirmed mismatch");
      setTamper(verification);
      appendLog("Tampered model response rejected: commitment mismatch", "danger");
    } catch {
      setError("未能确认篡改检测结果。");
    }
  }

  if (!data) {
    return (
      <div className="boot-screen">
        <div className="boot-mark"><Shield size={28} /><ScanLine className="scan" size={46} /></div>
        <p>{error || "BOOTING PROOFGUARD FIREWALL"}</p>
      </div>
    );
  }

  const isRunning = ["intercept", "inference", "policy"].includes(phase);

  return (
    <div className="app-shell">
      <div className="noise" />
      <header className="topbar">
        <button className="brand" onClick={() => setView("firewall")}>
          <span className="brand-glyph"><ShieldCheck size={22} /></span>
          <span><b>PROOF</b>GUARD<small>VERIFIABLE AGENT FIREWALL</small></span>
        </button>
        <nav>
          <button className={view === "firewall" ? "active" : ""} onClick={() => setView("firewall")}>防火墙</button>
          <button className={view === "evidence" ? "active" : ""} onClick={() => setView("evidence")}>证据室</button>
          <button className={view === "architecture" ? "active" : ""} onClick={() => setView("architecture")}>架构</button>
        </nav>
        <div className="top-actions">
          <span className={`network-badge ${data.status.mode}`}>
            <i /> {modeLabels[data.status.mode]}
          </span>
          <button className="wallet-button" onClick={connectWallet}>
            <Wallet size={15} /> {wallet ? shortHash(wallet, 6, 4) : "连接钱包"}
          </button>
        </div>
      </header>

      <main>
        {view === "firewall" && (
          <FirewallView
            data={data}
            scenario={scenario}
            selectedId={selectedId}
            selectScenario={selectScenario}
            phase={phase}
            reviewMode={result?.inference.mode || reviewMode}
            result={result}
            error={error}
            logs={logs}
            runReview={runReview}
            isRunning={isRunning}
            signPermit={signPermit}
            signature={signature}
            execution={execution}
            testTamper={testTamper}
            tamper={tamper}
          />
        )}
        {view === "evidence" && <EvidenceView data={data} result={result} tamper={tamper} onBack={() => setView("firewall")} />}
        {view === "architecture" && <ArchitectureView data={data} />}
      </main>
    </div>
  );
}

function CustomReview({ onReview, isRunning }) {
  function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (field) => form.get(field).trim();
    const transaction = { chainId: baseSepolia.chainId, from: value("from"), to: value("to"),
      value: value("value"), data: value("calldata") };
    void onReview({ transaction, apiKey: value("apiKey") });
  }

  return <details className="custom-review">
    <summary>审查自定义交易</summary>
    <form onSubmit={submit} autoComplete="off">
      <p>Base Sepolia。服务端会核对登记钱包、calldata 和独立价格。</p>
      <label>Agent 钱包<input name="from" pattern="0x[0-9a-fA-F]{40}" title="40 位十六进制 EVM 地址" required /></label>
      <label>目标地址<input name="to" pattern="0x[0-9a-fA-F]{40}" title="40 位十六进制 EVM 地址" required /></label>
      <label>原生币金额（wei）<input name="value" pattern="0|[1-9][0-9]{0,77}" inputMode="numeric" defaultValue="0" required /></label>
      <label>Calldata<textarea name="calldata" rows="4" spellCheck={false} autoCapitalize="off" placeholder="0x…" required maxLength={50_000} /></label>
      <label>Agent API 密钥<input name="apiKey" type="password" autoComplete="off" required minLength={16} /></label>
      <button type="submit" className="primary-action" disabled={isRunning}>{isRunning ? "正在审查" : "提交交易审查"}</button>
    </form>
  </details>;
}

function FirewallView({ data, scenario, selectedId, selectScenario, phase, reviewMode, result, error, logs, runReview, isRunning, signPermit, signature, execution, testTamper, tamper }) {
  return (
    <div className="firewall-page">
      <section className="hero">
        <div className="hero-copy">
          <span className="kicker"><CircleDot size={13} /> AUTONOMOUS AGENT SAFETY LAYER</span>
          <h1>让第二个可信大脑，<br /><em>拦在交易之前。</em></h1>
          <p>Agent 提交交易提案，经双模型委员会和确定性策略复核。三票全部通过，才签发限时模拟执行许可。</p>
        </div>
        <div className="hero-stat">
          <span>DEMO TREASURY</span>
          <strong>$2.48M</strong>
          <small><i /> Illustration</small>
        </div>
      </section>

      <section className="scenario-strip">
        <div className="strip-label"><Radar size={17} /><span>攻击模拟器<small>选择一笔 Agent 交易</small></span></div>
        {data.scenarios.map((item, index) => (
          <button key={item.id} className={`${selectedId === item.id ? "active" : ""} tone-${item.tone}`} onClick={() => selectScenario(item.id)}>
            <span>0{index + 1}</span><b>{item.label}</b><small>{item.shortLabel}</small>
          </button>
        ))}
      </section>

      <section className="command-grid">
        <div className="transaction-panel panel">
          <PanelHeader icon={Bot} label="INTERCEPTED AGENT INTENT" meta={data.agent.session} />
          <div className="agent-identity">
            <div className="agent-orb"><Bot size={24} /><span /></div>
            <div><strong>{data.agent.name}</strong><small>{data.agent.mandate}</small></div>
            <span className="pending-pill">AWAITING REVIEW</span>
          </div>
          <div className="intent-summary">
            <div><span>动作</span><strong>{scenario.display.method.startsWith("approve") ? "TOKEN APPROVAL" : "SWAP"}</strong></div>
            <ArrowRight size={18} />
            <div><span>资产路径</span><strong>{scenario.display.assetIn} → {scenario.display.assetOut}</strong></div>
            <div className="value"><span>价值</span><strong>{money(scenario.display.valueUsd)}</strong></div>
          </div>
          <div className="transaction-fields">
            <Field label="CHAIN" value={`Base / ${scenario.transaction.chainId}`} />
            <Field label="TARGET" value={shortHash(scenario.transaction.to, 10, 7)} mono />
            <Field label="METHOD" value={scenario.display.method} mono />
            <Field label="SLIPPAGE" value={`${scenario.display.slippageBps / 100}%`} danger={scenario.display.slippageBps > data.policy.maxSlippageBps} />
          </div>
          <div className={`untrusted-field ${scenario.id === "prompt-injection" ? "hostile" : ""}`}>
            <span><AlertTriangle size={14} /> UNTRUSTED MEMO</span>
            <code>{scenario.transaction.memo}</code>
          </div>
          <p className="scenario-description">{scenario.description}</p>
          <CustomReview onReview={runReview} isRunning={isRunning} />
        </div>

        <div className="review-panel panel">
          <PanelHeader icon={Cpu} label={reviewMode === "demo" ? "SIMULATED COMMITTEE" : "0G COMMITTEE"} meta={`${data.status.models.length} MODELS / UNANIMOUS`} />
          <div className="pipeline">
            <PipelineStep number="01" title="Intercept" caption="Isolate proposal" active={phase === "intercept"} done={["inference", "policy", "complete"].includes(phase)} />
            <PipelineStep number="02" title="0G Committee" caption={reviewMode === "demo" ? "Local simulation" : "Private Router requests"} active={phase === "inference"} done={["policy", "complete"].includes(phase)} />
            <PipelineStep number="03" title="Policy" caption="Deterministic gate" active={phase === "policy"} done={phase === "complete"} />
            <PipelineStep number="04" title="Seal" caption="Permit or block" active={phase === "complete"} done={phase === "complete"} />
          </div>

          {!result && !isRunning && (
            <div className="ready-state">
              <div className="radar-visual"><ScanLine size={40} /><i /><i /><i /></div>
              <span>TRANSACTION HELD AT GATE</span>
              <h2>尚未广播到链上</h2>
              <p>原始交易将在隔离区内接受对抗式审查。</p>
            </div>
          )}
          {isRunning && <ScanningState phase={phase} mode={reviewMode} />}
          {result && <Decision result={result} />}

          {error && <div className="inline-error" role="alert"><XCircle size={16} />{error}</div>}

          <div className="review-actions">
            {!result && (
              <button className="primary-action" onClick={runReview} disabled={isRunning}>
                {isRunning ? <RefreshCw className="spin" size={18} /> : <Play size={18} fill="currentColor" />}
                {isRunning ? "正在审查" : "启动演示审查"}
              </button>
            )}
            {result?.permit && !result.permit.owner && <span>未指定签名钱包，当前仅审查。</span>}
            {result?.permit?.owner && !signature && (
              <button className="primary-action safe" onClick={signPermit}><KeyRound size={18} />签署并模拟执行</button>
            )}
            {signature && <div className="signed-banner"><Fingerprint size={18} /><span>{execution ? "PERMIT CONSUMED" : "OWNER SIGNED"}<small>{execution ? shortHash(execution.txHash, 14, 10) : shortHash(signature, 14, 10)}</small></span></div>}
            {result && !tamper && (
              <button className="tamper-button" onClick={testTamper}><ShieldAlert size={16} />模拟篡改响应</button>
            )}
            {tamper && <div className="tamper-alert"><OctagonX size={18} /><span>COMMITMENT MISMATCH<small>响应与原始承诺不一致</small></span></div>}
          </div>
        </div>

        <aside className="policy-panel panel">
          <PanelHeader icon={LockKeyhole} label="OWNER POLICY" meta={`${data.policy.id} / v${data.policy.version}`} />
          <div className="policy-score">
            <span>POLICY INTEGRITY</span><strong>100<small>/100</small></strong>
            <div><i /></div>
          </div>
          <div className="policy-rules">
            <PolicyRule icon={Gauge} label="单笔上限" value={money(data.policy.maxValueUsd)} />
            <PolicyRule icon={Activity} label="最大滑点" value={`${data.policy.maxSlippageBps / 100}%`} />
            <PolicyRule icon={Hexagon} label="资产白名单" value={Object.values(data.policy.allowedAssets).map(({ symbol }) => symbol).join(" · ")} />
            <PolicyRule icon={Network} label="允许网络" value="Base 演示 · Base Sepolia" />
            <PolicyRule icon={LockKeyhole} label="推理模式" value={data.status.mode === "demo" ? "DEMO" : "PRIVATE / TeeML"} accent />
          </div>
          <div className="policy-hash"><span>POLICY COMMITMENT</span><code>{shortHash(data.policyHash, 16, 10)}</code><Copy size={13} /></div>
          <div className="live-log">
            <div><Terminal size={14} /> LIVE SECURITY LOG <i /></div>
            {logs.map((log, index) => <p className={log.type} key={`${log.text}-${index}`}><time>{String(index + 1).padStart(2, "0")}</time>{log.text}</p>)}
          </div>
        </aside>
      </section>

      {result && <EvidenceRibbon result={result} />}
    </div>
  );
}

function PanelHeader({ icon: Icon, label, meta }) {
  return <div className="panel-header"><span><Icon size={15} />{label}</span><code>{meta}</code></div>;
}

function Field({ label, value, mono, danger }) {
  return <div className={danger ? "danger" : ""}><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>;
}

function PipelineStep({ number, title, caption, active, done }) {
  return (
    <div className={`${active ? "active" : ""} ${done ? "done" : ""}`}>
      <span>{done ? <Check size={13} /> : number}</span><b>{title}</b><small>{caption}</small>
    </div>
  );
}

function PolicyRule({ icon: Icon, label, value, accent }) {
  return <div><Icon size={15} /><span>{label}</span><strong className={accent ? "accent" : ""}>{value}</strong></div>;
}

function ScanningState({ phase, mode }) {
  const copy = {
    intercept: ["INTERCEPTING", "正在隔离提案中的不可信字段"],
    inference: mode === "demo" ? ["SIMULATED REVIEW", "正在本地运行模拟审查"] : ["PRIVATE REVIEW", "等待 0G Router 返回两份裁决"],
    policy: ["COMPILING POLICY", "正在将 AI 判断与确定性规则合并"],
  }[phase];
  return (
    <div className="scanning-state">
      <div className="scan-core"><Shield size={35} /><span /><span /><span /></div>
      <b>{copy[0]}</b><p>{copy[1]}</p><div className="scan-progress"><i /></div>
    </div>
  );
}

function Decision({ result }) {
  const allowed = result.decision === "ALLOW";
  return (
    <div className={`decision ${allowed ? "allow" : "block"}`}>
      <div className="decision-icon">{allowed ? <ShieldCheck size={38} /> : <OctagonX size={38} />}</div>
      <span>{allowed ? "EXECUTION PERMIT ISSUED" : "TRANSACTION BLOCKED"}</span>
      <h2>{allowed ? "三票一致审查通过" : "审查未通过"}</h2>
      <p>{result.deterministic.passed ? result.inference.summary : `未通过确定性策略：${result.deterministic.checks.filter((check) => !check.passed).map((check) => check.label).join("、")}`}</p>
      <div className="decision-metrics">
        <div><span>RISK</span><strong>{result.inference.riskScore}</strong></div>
        <div><span>VOTES</span><strong>{result.inference.committee.filter((reviewer) => reviewer.decision === "ALLOW").length}/{result.inference.committee.length}</strong></div>
        <div><span>LATENCY</span><strong>{result.inference.latencyMs}ms</strong></div>
      </div>
      <div className={`receipt-status ${result.inference.receipt.verified ? "verified" : "simulated"}`}>
        {result.inference.receipt.verified ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        {result.inference.receipt.label}
      </div>
    </div>
  );
}

function EvidenceRibbon({ result }) {
  return (
    <section className={`evidence-ribbon ${result.decision.toLowerCase()}`}>
      <div><ShieldCheck size={22} /><span>DECISION</span><strong>{result.decision}</strong></div>
      <div><span>0G COMMITTEE</span><strong>{result.inference.models.length} MODELS</strong></div>
      <div><span>TRUST</span><strong>{result.inference.mode === "demo" ? "SIMULATION" : result.inference.trustMode.toUpperCase()}</strong></div>
      <div><span>TX COMMITMENT</span><code>{shortHash(result.evidence.transactionHash)}</code></div>
      <div><span>PERMIT</span><code>{shortHash(result.permit?.permitHash)}</code></div>
    </section>
  );
}

function EvidenceView({ data, result, tamper, onBack }) {
  if (!result) {
    return <EmptyView icon={Fingerprint} title="证据室等待第一份收据" text="先运行一笔交易审查，ProofGuard 会在这里展开完整证据链。" action="返回防火墙" onClick={onBack} />;
  }
  return (
    <div className="secondary-page">
      <section className="page-title"><span>IMMUTABLE EVIDENCE</span><h1>一次决策，三份承诺。</h1><p>交易、策略与模型响应分别哈希；任意一字被修改，即可通过重算与原始承诺对照。</p></section>
      <div className="evidence-grid">
        <EvidenceCard index="01" icon={Bot} title="Transaction commitment" hash={result.evidence.transactionHash} detail={result.deterministic.facts?.method ?? "Calldata blocked"} />
        <EvidenceCard index="02" icon={LockKeyhole} title="Policy commitment" hash={result.evidence.policyHash} detail={`${data.policy.id} · v${data.policy.version}`} />
        <EvidenceCard index="03" icon={Cpu} title="Committee commitment" hash={result.evidence.responseCommitment} detail={`${result.inference.models.length} reviewers · ${result.inference.mode === "demo" ? "simulation" : result.inference.trustMode}`} />
      </div>
      <section className="receipt-sheet">
        <div className="receipt-head"><div><Fingerprint size={25} /><span>PROOFGUARD RECEIPT<small>{result.permit?.version || "NO PERMIT"}</small></span></div><strong className={result.decision.toLowerCase()}>{result.decision}</strong></div>
        <ReceiptRow label="Permit hash" value={result.permit?.permitHash || "Not issued"} />
        <ReceiptRow label="0G response ID" value={result.inference.receipt.responseId || "Not exposed by router"} />
        <ReceiptRow label="Attestation status" value={result.inference.receipt.label} />
        <ReceiptRow label="Committee" value={result.inference.committee.map((reviewer) => `${reviewer.role}:${reviewer.model}:${reviewer.decision}`).join(" | ")} />
        {result.permit && (
          <>
            <ReceiptRow label="Issued / expires" value={`${result.permit.issuedAt}  →  ${result.permit.expiresAt}`} />
            <ReceiptRow label="Scoped target" value={result.permit.scope.target} />
          </>
        )}
        {result.inference.mode === "live" && result.inference.receipt.responses.map((receipt) => (
          <ReceiptRow key={receipt.role} label={`${receipt.role} Router request`} value={receipt.requestId || "Not exposed by router"} />
        ))}
        {tamper && <div className="receipt-tamper"><OctagonX size={18} /><span>TAMPER TEST FAILED CLOSED</span><code>{shortHash(tamper.actualHash, 18, 12)}</code></div>}
      </section>
    </div>
  );
}

function EvidenceCard({ index, icon: Icon, title, hash, detail }) {
  return <article className="evidence-card"><span>{index}</span><Icon size={23} /><h3>{title}</h3><p>{detail}</p><code>{hash}</code></article>;
}

function ReceiptRow({ label, value }) {
  return <div className="receipt-row"><span>{label}</span><code>{value}</code></div>;
}

function ArchitectureView({ data }) {
  return (
    <div className="secondary-page architecture-page">
      <section className="page-title"><span>ZERO-TRUST PIPELINE</span><h1>任何一个 AI 都没有最终决定权。</h1><p>0G 主审模型理解复杂意图，0G SIA 模型负责红队复核，Owner Policy 执行不可协商的边界；三票一致才允许钱包签名。</p></section>
      <section className="architecture-flow">
        <ArchitectureNode icon={Bot} eyebrow="UNTRUSTED" title="Agent Intent" text="EVM transaction + calldata" />
        <FlowArrow label="INTERCEPT" />
        <ArchitectureNode icon={Cpu} eyebrow="PRIVATE / VERIFIABLE" title="0G Committee" text={data.status.models.join(" + ")} accent />
        <FlowArrow label="VERDICT" />
        <ArchitectureNode icon={LockKeyhole} eyebrow="DETERMINISTIC" title="Policy Gate" text={`${data.policy.id} · fail closed`} />
        <FlowArrow label="SEAL" />
        <ArchitectureNode icon={Fingerprint} eyebrow="SCOPED" title="Execution Permit" text="hash + expiry + nonce" safe />
      </section>
      <section className="architecture-notes">
        <article><span>01</span><h3>隐私不是 UI 开关</h3><p>API key 只在服务端，单次请求强制携带 Private trust mode；敏感交易意图不进入公开链。</p></article>
        <article><span>02</span><h3>任一审查票都能否决</h3><p>主审模型、SIA 红队模型与确定性规则必须三票一致；任一模型输出异常、不可用或 BLOCK 都不会生成 Permit。</p></article>
        <article><span>03</span><h3>证明与承诺分开展示</h3><p>官方返回的 attestation 原样保存；本地哈希只证明内容未被篡改，不冒充 TEE Proof。</p></article>
      </section>
      <a className="docs-link" href="https://pc.0g.ai/" target="_blank" rel="noreferrer">OPEN 0G PRIVATE COMPUTER <ExternalLink size={15} /></a>
    </div>
  );
}

function ArchitectureNode({ icon: Icon, eyebrow, title, text, accent, safe }) {
  return <article className={`${accent ? "accent" : ""} ${safe ? "safe" : ""}`}><span>{eyebrow}</span><Icon size={28} /><h3>{title}</h3><p>{text}</p></article>;
}

function FlowArrow({ label }) {
  return <div className="flow-arrow"><span>{label}</span><ChevronRight size={22} /></div>;
}

function EmptyView({ icon: Icon, title, text, action, onClick }) {
  return <div className="empty-view"><Icon size={42} /><span>NO RECEIPT YET</span><h1>{title}</h1><p>{text}</p><button onClick={onClick}>{action}<ArrowRight size={16} /></button></div>;
}

export default App;

