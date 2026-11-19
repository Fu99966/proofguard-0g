import { expect, it } from "vitest";
import { liveModelBounds, liveUsdMicros, openLiveBudget, validateLiveCharge } from "./liveAcceptanceBudget.js";

const models = ["glm-5.3-flash", "0gm-1.0-35b-a3b-sia"];
const bounds = liveModelBounds(models);
const pair = bounds[0].usdMicros + bounds[1].usdMicros;

function bill(bound, id, promptTokens = bound.input, completionTokens = bound.output) {
  const input = Math.ceil(promptTokens * bound.promptUsdMicrosPerMillion / 1e6);
  const output = Math.ceil(completionTokens * bound.completionUsdMicrosPerMillion / 1e6);
  return { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    x_0g_trace: { request_id: id, billing: { currency: "usd", total_cost: String(input + output),
      input_cost: String(input), output_cost: String(output) } } };
}

it("reserves both maximum costs before dispatch and accounts for a missing receipt at its full cost", () => {
  const budget = openLiveBudget(":memory:");
  try {
    budget.start("fixture", "commit");
    expect(pair).toBe(190_072);
    expect(() => budget.reserve("refused", bounds, pair - 1)).toThrow("before dispatch");
    expect(budget.state()).toMatchObject({ requests: 0, committedUsdMicros: 0 });
    budget.reserve("first", bounds, pair);
    expect(budget.state()).toMatchObject({ requests: 2, committedUsdMicros: pair, unsettled: 2 });
    const full = validateLiveCharge(bill(bounds[0], "t1"), bounds[0]);
    budget.settle("first", bounds[0].model, full);
    expect(budget.state()).toMatchObject({ requests: 2, billedUsdMicros: full.total, committedUsdMicros: pair, unsettled: 1 });
    expect(() => budget.reserve("next", bounds, 2 * pair - 1)).toThrow("before dispatch");
    expect(() => budget.reserve("first", bounds, liveUsdMicros)).toThrow("already reviewed");
    expect(() => budget.settle("first", bounds[1].model, { ...full, total: 1 })).toThrow("duplicate");
  } finally { budget.close(); }
});

it("keeps the 30-request hard cap even when settled charges are zero", () => {
  const budget = openLiveBudget(":memory:");
  try {
    budget.start("fixture", "commit");
    for (let index = 0; index < 15; index++) {
      budget.reserve(String(index), bounds);
      for (const bound of bounds) budget.settle(String(index), bound.model, validateLiveCharge(bill(bound, `${index}-${bound.model}`, 0, 0), bound));
    }
    expect(budget.state()).toMatchObject({ requests: 30, billedUsdMicros: 0, unsettled: 0 });
    expect(() => budget.reserve("over", bounds)).toThrow("before dispatch");
  } finally { budget.close(); }
});

it("rejects mismatched totals, unknown currencies, and token or price overruns", () => {
  const [bound] = bounds;
  const corrupted = bill(bound, "bad");
  corrupted.x_0g_trace.billing.total_cost = String(bound.usdMicros + 1);
  expect(() => validateLiveCharge(corrupted, bound)).toThrow("billing disagrees");
  const wrongCurrency = bill(bound, "bad");
  wrongCurrency.x_0g_trace.billing.currency = "0g";
  expect(() => validateLiveCharge(wrongCurrency, bound)).toThrow("reserved USD scope");
  expect(() => validateLiveCharge(bill(bound, "bad", bound.input + 1), bound)).toThrow("reserved USD scope");
  expect(() => validateLiveCharge(bill(bound, "bad", 0, bound.output + 1), bound)).toThrow("reserved USD scope");
});

it("carries both previously reconciled charges across an authorized restart without resetting either cap", () => {
  const budget = openLiveBudget(":memory:");
  try {
    const [flash, sia] = bounds;
    budget.start("resumed", "commit", [
      { id: "prior-flash", model: flash.model, total: 782, sourceRun: "stopped" },
      { id: "prior-sia", model: sia.model, total: 7143, sourceRun: "stopped" },
    ]);
    expect(budget.state()).toMatchObject({ requests: 2, billedUsdMicros: 7925, unsettled: 0 });
    expect(() => budget.reserve("over", bounds, pair + 7924)).toThrow("before dispatch");
    for (let index = 0; index < 14; index++) {
      budget.reserve(String(index), bounds);
      for (const bound of bounds) budget.settle(String(index), bound.model, validateLiveCharge(bill(bound, `${index}-${bound.model}`, 0, 0), bound));
    }
    expect(() => budget.reserve("over-count", bounds)).toThrow("before dispatch");
    expect(budget.state()).toMatchObject({ requests: 30, billedUsdMicros: 7925, unsettled: 0 });
  } finally { budget.close(); }
});
