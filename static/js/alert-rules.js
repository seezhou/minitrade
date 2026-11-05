/**
 * Price alert rules.
 *
 * Kept dependency-free and side-effect-free so `node --test` can exercise the exact
 * predicate the app uses. Storage and UI live in alerts.js; Alpaca has no alert API,
 * so these rules only ever exist in the browser.
 */

export const ALERT_OPS = { above: "高于", below: "低于" };

/** Coerce a stored/edited rule into a usable shape, or null when it is unusable. */
export function normalizeRule(value) {
  const symbol = String(value?.symbol || "").trim().toUpperCase();
  const op = value?.op === "above" || value?.op === "below" ? value.op : null;
  const price = Number(value?.price);
  if (!symbol || !op || !Number.isFinite(price) || price <= 0) return null;
  const triggeredPrice = Number(value?.triggered_price);
  return {
    id: String(value?.id || ""),
    symbol,
    op,
    price,
    created_at: value?.created_at || null,
    triggered_at: value?.triggered_at || null,
    triggered_price: Number.isFinite(triggeredPrice) ? triggeredPrice : null,
  };
}

/** True when `price` has crossed the rule's threshold. A fired rule never re-fires. */
export function shouldTrigger(rule, price) {
  if (!rule || rule.triggered_at) return false;
  const current = Number(price);
  const target = Number(rule.price);
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  if (rule.op === "above") return current >= target;
  if (rule.op === "below") return current <= target;
  return false;
}

/** Rules that are still waiting for the price to move. */
export function activeRules(rules) {
  return (rules || []).filter((rule) => !rule.triggered_at);
}

/** Symbols that still need a quote lookup. */
export function activeSymbols(rules) {
  return [...new Set(activeRules(rules).map((rule) => rule.symbol))].sort();
}

/**
 * Apply one batch of quotes to all rules.
 *
 * `prices` maps symbol -> price; symbols without a price are skipped rather than
 * treated as a trigger. Fired rules are stamped so they cannot fire twice.
 */
export function evaluate(rules, prices, at = Date.now()) {
  const stamp = new Date(at).toISOString();
  const triggered = [];
  const next = [];
  for (const rule of rules || []) {
    const current = prices?.[rule.symbol];
    if (shouldTrigger(rule, current)) {
      const hit = { ...rule, triggered_at: stamp, triggered_price: Number(current) };
      triggered.push(hit);
      next.push(hit);
      continue;
    }
    next.push(rule);
  }
  return { rules: next, triggered };
}

/** Matches the formatting of `fmt.price` in utils.js, without importing it. */
function money(value) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Human readable one-liner used by both the toast and the system notification. */
export function describeTrigger(rule) {
  const op = ALERT_OPS[rule?.op] || "触及";
  const target = Number(rule?.price);
  // Number(null) is 0, which would print "现价 $0.00" for an unfilled rule.
  const raw = rule?.triggered_price;
  const current = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
  const targetText = Number.isFinite(target) ? money(target) : "—";
  const currentText = Number.isFinite(current) ? `现价 ${money(current)}` : "";
  return `${rule?.symbol || ""} ${op} ${targetText} 已触发${currentText ? `（${currentText}）` : ""}`;
}
