import Database from "better-sqlite3";

export const liveRequestLimit = 30;
export const liveUsdMicros = 900_000;
export const reviewCompletionTokens = 4096;

const publicProviderCatalog = "https://router-api.0g.ai/v1/providers";
const pinned = {
  "glm-5.3-flash": { address: "0x2161583F7Ba3A01C011987e418f8cE957649348c", input: 1_048_576, prompt: 150_000, completion: 500_000 },
  "0gm-1.0-35b-a3b-sia": { address: "0x15aDd680050Ecd0B25eb7d480e7BB1f48594Eabe", input: 32_768, prompt: 536_000, completion: 3_216_000 },
};
const microUsd = 1_000_000;
const usdPerMillion = (value) => (value / microUsd).toString();
const worstCaseMicros = (tokens, price) => Math.ceil(tokens * price / microUsd);

export class LiveBudgetError extends Error {
  constructor(message, code = "LIVE_BUDGET_INTEGRITY", status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function liveModelBounds(models, catalog) {
  if (models.length !== 2 || new Set(models).size !== 2 || models.some((model) => !Object.hasOwn(pinned, model))) {
    throw new LiveBudgetError("Bounded live review requires the two verified price-bounded providers.");
  }
  return models.map((model) => {
    const { address, input, prompt, completion } = pinned[model];
    if (catalog) {
      const selected = catalog.find((entry) => entry.canonical_id === model && entry.address.toLowerCase() === address.toLowerCase());
      const currentRates = ["prompt", "completion", "cached_prompt"].map((key) => Number(selected?.pricing_usd?.[key]));
      if (selected?.trust_mode !== "private" || selected.is_healthy !== true || !Number.isSafeInteger(selected.context_length)
        || selected.context_length > input || selected.max_completion_tokens < reviewCompletionTokens
        || !currentRates.every((rate) => Number.isFinite(rate) && rate >= 0)
        || currentRates[0] > prompt / 1e12 || currentRates[1] > completion / 1e12 || currentRates[2] > prompt / 1e12) {
        throw new LiveBudgetError("A pinned Router provider no longer fits the verified token and USD bounds.");
      }
    }
    return { model, input, output: reviewCompletionTokens, promptUsdMicrosPerMillion: prompt, completionUsdMicrosPerMillion: completion,
      usdMicros: worstCaseMicros(input, prompt)
      + worstCaseMicros(reviewCompletionTokens, completion), headers: {
      "X-0G-Provider-Address": address,
      "X-0G-Provider-Allow-Fallbacks": "false",
      "X-0G-Provider-Max-Price-Usd-Prompt": usdPerMillion(prompt),
      "X-0G-Provider-Max-Price-Usd-Completion": usdPerMillion(completion),
    } };
  });
}

export async function verifiedLiveBounds(models) {
  const response = await fetch(publicProviderCatalog, { redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new LiveBudgetError("The Router provider catalog could not be verified.");
  const { data } = await response.json();
  if (!Array.isArray(data)) throw new LiveBudgetError("The Router provider catalog is malformed.");
  return liveModelBounds(models, data);
}

export function validateLiveCharge(payload, bound) {
  const { usage, x_0g_trace: trace } = payload ?? {};
  const billing = trace?.billing;
  const costFields = [billing?.total_cost, billing?.input_cost, billing?.output_cost];
  if (billing?.currency !== "usd" || !costFields.every((value) => typeof value === "string" && /^\d{1,12}$/.test(value))
    || typeof trace?.request_id !== "string" || !trace.request_id.trim()
    || !Number.isSafeInteger(usage?.prompt_tokens) || usage.prompt_tokens < 0 || usage.prompt_tokens > bound.input
    || !Number.isSafeInteger(usage?.completion_tokens) || usage.completion_tokens < 0 || usage.completion_tokens > bound.output
    || (billing.total_cost_usd_micro !== undefined && billing.total_cost_usd_micro !== billing.total_cost)
    || ["web_search_cost", "web_fetch_cost"].some((field) => billing[field] != null && Number(billing[field]) !== 0)) {
    throw new LiveBudgetError("Router billing, request ID, or token evidence does not match the reserved USD scope.");
  }
  const [total, input, output] = costFields.map(Number);
  if (total !== input + output || total > bound.usdMicros || input > worstCaseMicros(usage.prompt_tokens, bound.promptUsdMicrosPerMillion)
    || output > worstCaseMicros(usage.completion_tokens, bound.completionUsdMicrosPerMillion)) {
    throw new LiveBudgetError("Router billing disagrees with reported charges or exceeds the worst-case reservation.");
  }
  return { id: trace.request_id, total, input, output, raw: billing };
}

export function openLiveBudget(database) {
  const db = new Database(database);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_run (id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT NOT NULL, commit_hash TEXT NOT NULL, fault TEXT);
    CREATE TABLE IF NOT EXISTS live_prior_charges (
      request_id TEXT PRIMARY KEY, model TEXT NOT NULL, billed_usd_micros INTEGER NOT NULL, source_run TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_reservations (
      proposal TEXT NOT NULL, model TEXT NOT NULL, reserved_usd_micros INTEGER NOT NULL,
      request_id TEXT UNIQUE, billed_usd_micros INTEGER, billing TEXT,
      PRIMARY KEY (proposal, model)
    );
  `);
  const selectRun = db.prepare("SELECT run_id AS runId, commit_hash AS commitHash, fault FROM live_run WHERE id=1");
  const faults = db.prepare("UPDATE live_run SET fault=COALESCE(fault,?) WHERE id=1");
  const totals = db.prepare(`WITH bills AS (
      SELECT request_id, billed_usd_micros, reserved_usd_micros FROM live_reservations
      UNION ALL SELECT request_id, billed_usd_micros, billed_usd_micros FROM live_prior_charges
    ) SELECT COUNT(*) AS requests, COALESCE(SUM(COALESCE(billed_usd_micros,reserved_usd_micros)),0) AS committedUsdMicros,
    COALESCE(SUM(billed_usd_micros),0) AS billedUsdMicros, COUNT(*)-COUNT(request_id) AS unsettled FROM bills`);
  const priorRequest = db.prepare("SELECT 1 FROM live_prior_charges WHERE request_id=?");
  const startAtomically = db.transaction((runId, commitHash, priorCharges) => {
    db.prepare("INSERT INTO live_run (id,run_id,commit_hash) VALUES (1,?,?)").run(runId, commitHash);
    const insert = db.prepare("INSERT INTO live_prior_charges VALUES (?,?,?,?)");
    for (const { id, model, total, sourceRun } of priorCharges) {
      if (typeof id !== "string" || !id.trim() || !Object.hasOwn(pinned, model) || !Number.isSafeInteger(total) || total < 0 || !sourceRun) {
        throw new LiveBudgetError("Invalid charge carried forward from the stopped run.");
      }
      insert.run(id, model, total, sourceRun);
    }
    const state = totals.get();
    if (state.requests > liveRequestLimit || state.committedUsdMicros > liveUsdMicros) {
      throw new LiveBudgetError("Carried charges exceed the original authorization.");
    }
  });
  const checkProposal = db.prepare("SELECT 1 FROM live_reservations WHERE proposal=?");
  const insert = db.prepare("INSERT INTO live_reservations(proposal,model,reserved_usd_micros) VALUES(?,?,?)");
  const update = db.prepare(`UPDATE live_reservations SET request_id=?,billed_usd_micros=?,billing=?
    WHERE proposal=? AND model=? AND request_id IS NULL AND reserved_usd_micros>=?`);
  const reserveAtomically = db.transaction((proposal, bounds, limit) => {
    if (!selectRun.get() || selectRun.get().fault) throw new LiveBudgetError("The live run has stopped.");
    if (checkProposal.get(proposal)) throw new LiveBudgetError("This exact proposal was already reviewed or reserved.", "LIVE_DUPLICATE_PROPOSAL", 409);
    const state = totals.get();
    const pair = bounds.reduce((sum, entry) => sum + entry.usdMicros, 0);
    if (state.requests + bounds.length > liveRequestLimit || state.committedUsdMicros + pair > limit) {
      throw new LiveBudgetError("Router budget exhausted before dispatch.", "ROUTER_BUDGET_EXHAUSTED", 429);
    }
    for (const { model, usdMicros } of bounds) insert.run(proposal, model, usdMicros);
  });
  return {
    start(runId, commitHash, priorCharges = []) {
      startAtomically.immediate(runId, commitHash, priorCharges);
    },
    state() { return { ...selectRun.get(), ...totals.get() }; },
    rows() { return db.prepare("SELECT * FROM live_reservations ORDER BY rowid").all(); },
    priorRows() { return db.prepare("SELECT * FROM live_prior_charges ORDER BY rowid").all(); },
    reserve(proposal, bounds, limit = liveUsdMicros) {
      if (bounds.length !== 2 || new Set(bounds.map(({ model }) => model)).size !== 2
        || !bounds.every(({ usdMicros }) => Number.isSafeInteger(usdMicros) && usdMicros > 0)
        || !Number.isSafeInteger(limit) || limit < 0 || limit > liveUsdMicros) throw new LiveBudgetError("Invalid live reservation bounds.");
      reserveAtomically.immediate(proposal, bounds, limit);
    },
    settle(proposal, model, { id, total, raw, transportRequestId }) {
      if (priorRequest.get(id)) throw new LiveBudgetError("A Router receipt repeats a previously settled request.");
      try {
        if (update.run(id, total, JSON.stringify({ ...raw, ...(transportRequestId && { transportRequestId }) }), proposal, model, total).changes === 1) return;
      } catch (error) {
        if (!String(error.code).startsWith("SQLITE_CONSTRAINT")) throw error;
      }
      throw new LiveBudgetError("A Router receipt is duplicate, missing its reservation, or exceeds it.");
    },
    stop(reason) { faults.run(reason); },
    close() { db.close(); },
  };
}
