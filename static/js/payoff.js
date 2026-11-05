/**
 * Expiry payoff math for the option strategy desk.
 *
 * Deliberately dependency-free: the browser imports it like any other module, and
 * `node --test` imports the very same file, so the numbers on the chart are the
 * numbers under test. Prices are per share; each contract multiplies by 100.
 */

export const CONTRACT_MULTIPLIER = 100;

/** Shares of stock a strategy of `qty` contracts needs (100 per contract). */
export function requiredShares(qty) {
  const contracts = Math.floor(Number(qty) || 0);
  return contracts > 0 ? contracts * CONTRACT_MULTIPLIER : 0;
}

/**
 * Build the expiry payoff curve.
 *
 * @param {object}   input
 * @param {Array}    input.legs      option legs: `{ kind: "call"|"put", side: "buy"|"sell", strike }`
 * @param {number}   input.entry     absolute net premium per share (never signed)
 * @param {number}   input.qty       number of contracts
 * @param {number}   input.spot      current underlying price, sets the x range
 * @param {number}   [input.shares]  stock held alongside the options (0 for none)
 * @param {number}   [input.basis]   stock cost basis; defaults to spot
 * @param {boolean}  [input.credit]  true when the premium is received, not paid
 * @param {boolean}  [input.unbounded] true when profit has no upper bound
 * @param {number}   [input.steps]   resolution of the sampled curve
 */
export function payoffCurve({
  legs = [],
  entry = 0,
  qty = 1,
  spot = 0,
  shares = 0,
  basis = null,
  credit = false,
  unbounded = false,
  steps = 120,
} = {}) {
  const center = Number(spot) || 0;
  const contracts = Number(qty) || 0;
  if (!center || !legs.length || contracts <= 0) {
    return { points: [], maxProfit: null, maxLoss: null, breakevens: [] };
  }

  const premium = (credit ? 1 : -1) * Math.abs(Number(entry) || 0) * CONTRACT_MULTIPLIER * contracts;
  const stock = Math.abs(Number(shares) || 0);
  const stockBasis = basis === null || basis === undefined ? center : Number(basis) || 0;

  const low = center * 0.6;
  const high = center * 1.4;
  const step = (high - low) / steps;
  const points = [];

  for (let price = low; price <= high + step / 2; price += step) {
    let value = premium;
    if (stock) value += (price - stockBasis) * stock;
    for (const leg of legs) {
      const strike = Number(leg.strike);
      if (!Number.isFinite(strike)) continue;
      const intrinsic = leg.kind === "call"
        ? Math.max(0, price - strike)
        : Math.max(0, strike - price);
      value += (leg.side === "buy" ? 1 : -1) * intrinsic * CONTRACT_MULTIPLIER * contracts;
    }
    points.push({ price, value });
  }

  const values = points.map((point) => point.value);
  const breakevens = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if ((previous.value < 0 && current.value >= 0) || (previous.value > 0 && current.value <= 0)) {
      const ratio = Math.abs(previous.value) / (Math.abs(previous.value) + Math.abs(current.value) || 1);
      breakevens.push(previous.price + (current.price - previous.price) * ratio);
    }
  }

  return {
    points,
    maxProfit: unbounded ? null : Math.max(...values),
    maxLoss: Math.min(...values),
    breakevens,
  };
}
