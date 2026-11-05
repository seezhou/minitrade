/**
 * Price alert predicates. Run with `node --test "tests/js/*.test.mjs"`.
 *
 * The rules never leave the browser (Alpaca has no alert API), so this is the only
 * place that can prove a rule fires exactly once and only in the right direction.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALERT_OPS,
  activeRules,
  activeSymbols,
  describeTrigger,
  evaluate,
  normalizeRule,
  shouldTrigger,
} from "../../static/js/alert-rules.js";

function rule(overrides = {}) {
  return {
    id: "al-1",
    symbol: "AAPL",
    op: "above",
    price: 200,
    created_at: "2026-11-05T14:00:00.000Z",
    triggered_at: null,
    triggered_price: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeRule
// ---------------------------------------------------------------------------

test("normalizeRule uppercases the symbol and keeps a valid rule", () => {
  const row = normalizeRule({ id: "x", symbol: " aapl ", op: "above", price: "200.5" });
  assert.deepEqual(
    { symbol: row.symbol, op: row.op, price: row.price },
    { symbol: "AAPL", op: "above", price: 200.5 },
  );
});

test("normalizeRule rejects unusable rules instead of guessing", () => {
  assert.equal(normalizeRule({ symbol: "", op: "above", price: 1 }), null);
  assert.equal(normalizeRule({ symbol: "AAPL", op: "sideways", price: 1 }), null);
  assert.equal(normalizeRule({ symbol: "AAPL", op: "above", price: 0 }), null);
  assert.equal(normalizeRule({ symbol: "AAPL", op: "above", price: "abc" }), null);
  assert.equal(normalizeRule(null), null);
});

test("normalizeRule tolerates a missing triggered price", () => {
  assert.equal(normalizeRule({ symbol: "AAPL", op: "below", price: 100 }).triggered_price, null);
  assert.equal(normalizeRule({ symbol: "AAPL", op: "below", price: 100, triggered_price: "99.5" }).triggered_price, 99.5);
});

// ---------------------------------------------------------------------------
// shouldTrigger
// ---------------------------------------------------------------------------

test("above fires when the price reaches or exceeds the target", () => {
  assert.equal(shouldTrigger(rule({ price: 200 }), 199.99), false);
  assert.equal(shouldTrigger(rule({ price: 200 }), 200), true, "the target itself counts");
  assert.equal(shouldTrigger(rule({ price: 200 }), 205), true);
});

test("below fires when the price reaches or drops under the target", () => {
  const row = rule({ op: "below", price: 100 });
  assert.equal(shouldTrigger(row, 100.01), false);
  assert.equal(shouldTrigger(row, 100), true, "the target itself counts");
  assert.equal(shouldTrigger(row, 95), true);
});

test("a fired rule stays fired", () => {
  assert.equal(shouldTrigger(rule({ triggered_at: "2026-11-05T15:00:00.000Z" }), 500), false);
});

test("a missing or unusable price never triggers", () => {
  assert.equal(shouldTrigger(rule(), null), false);
  assert.equal(shouldTrigger(rule(), undefined), false);
  assert.equal(shouldTrigger(rule(), "n/a"), false);
  assert.equal(shouldTrigger(null, 500), false);
});

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

test("evaluate stamps the rule that fired and leaves the rest alone", () => {
  const rules = [rule({ id: "a", price: 200 }), rule({ id: "b", op: "below", price: 50 })];
  const { rules: next, triggered } = evaluate(rules, { AAPL: 201 }, 1_700_000_000_000);
  assert.equal(triggered.length, 1);
  assert.equal(triggered[0].id, "a");
  assert.equal(triggered[0].triggered_price, 201);
  assert.equal(triggered[0].triggered_at, new Date(1_700_000_000_000).toISOString());
  assert.equal(next[1].triggered_at, null);
});

test("evaluate does not fire the same rule twice", () => {
  const rules = [rule({ price: 200 })];
  const first = evaluate(rules, { AAPL: 210 }, 1_700_000_000_000);
  assert.equal(first.triggered.length, 1);
  const second = evaluate(first.rules, { AAPL: 220 }, 1_700_000_060_000);
  assert.equal(second.triggered.length, 0, "already fired");
  assert.equal(second.rules[0].triggered_at, first.rules[0].triggered_at);
});

test("evaluate skips symbols that have no quote", () => {
  const rules = [rule({ symbol: "AAPL" }), rule({ id: "b", symbol: "MSFT", price: 100 })];
  const { triggered, rules: next } = evaluate(rules, { MSFT: 150 });
  assert.deepEqual(triggered.map((item) => item.id), ["b"]);
  assert.equal(next[0].triggered_at, null);
});

test("evaluate keeps rule order and never drops rules", () => {
  const rules = [rule({ id: "a" }), rule({ id: "b", price: 999 }), rule({ id: "c", op: "below", price: 1 })];
  const { rules: next } = evaluate(rules, { AAPL: 300 });
  assert.deepEqual(next.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(next.length, 3);
});

test("evaluate on an empty rule list is a no-op", () => {
  assert.deepEqual(evaluate([], { AAPL: 200 }), { rules: [], triggered: [] });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("activeRules and activeSymbols only look at waiting rules", () => {
  const rules = [
    rule({ id: "a", symbol: "AAPL" }),
    rule({ id: "b", symbol: "MSFT" }),
    rule({ id: "c", symbol: "AAPL", triggered_at: "2026-11-05T15:00:00.000Z" }),
  ];
  assert.deepEqual(activeRules(rules).map((item) => item.id), ["a", "b"]);
  assert.deepEqual(activeSymbols(rules), ["AAPL", "MSFT"], "deduplicated and sorted");
  assert.deepEqual(activeSymbols([]), []);
});

test("describeTrigger names the direction and both prices", () => {
  assert.equal(ALERT_OPS.above, "高于");
  assert.equal(ALERT_OPS.below, "低于");
  const text = describeTrigger(rule({ price: 200, triggered_price: 201.5 }));
  assert.match(text, /AAPL/);
  assert.match(text, /高于/);
  assert.match(text, /\$200\.00/);
  assert.match(text, /\$201\.50/);
});

test("describeTrigger survives a rule without a fill price", () => {
  const text = describeTrigger(rule({ op: "below", price: 150, triggered_price: null }));
  assert.match(text, /低于/);
  assert.doesNotMatch(text, /现价/);
});
