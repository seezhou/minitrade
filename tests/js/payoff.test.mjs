/**
 * Payoff maths for the option strategy desk.
 *
 * Run with `node --test tests/js` (no dependencies, no build step). These cases are
 * the contract between the chart and the order ticket: the chart must show what the
 * position actually pays at expiry, including the stock leg of covered strategies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { payoffCurve, requiredShares, CONTRACT_MULTIPLIER } from "../../static/js/payoff.js";

function close(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

function pointNear(points, price) {
  return points.reduce((best, point) => (
    Math.abs(point.price - price) < Math.abs(best.price - price) ? point : best
  ));
}

/**
 * The curve is sampled, so assert against the expectation evaluated at the *sampled*
 * price. That keeps the test exact without pinning the sampling step.
 */
function assertValue(points, price, expectation, label) {
  const point = pointNear(points, price);
  close(point.value, expectation(point.price), `${label} @ ${point.price.toFixed(2)}`);
  return point.value;
}

const EMPTY = { points: [], maxProfit: null, maxLoss: null, breakevens: [] };

// ---------------------------------------------------------------------------
// Existing debit strategies must keep their numbers
// ---------------------------------------------------------------------------

test("long call loses only the premium and has unlimited upside", () => {
  const curve = payoffCurve({
    legs: [{ kind: "call", side: "buy", strike: 100 }],
    entry: 5,
    qty: 1,
    spot: 100,
    unbounded: true,
  });
  assertValue(curve.points, 100, () => -500, "at the money");
  assertValue(curve.points, 140, (price) => -500 + (price - 100) * 100, "deep in the money");
  close(curve.maxLoss, -500, "max loss");
  assert.equal(curve.maxProfit, null, "upside is unbounded");
  assert.equal(curve.breakevens.length, 1);
  close(curve.breakevens[0], 105, "breakeven");
});

test("bull call spread caps profit at the strike width minus the debit", () => {
  const curve = payoffCurve({
    legs: [
      { kind: "call", side: "buy", strike: 100 },
      { kind: "call", side: "sell", strike: 110 },
    ],
    entry: 3,
    qty: 1,
    spot: 100,
  });
  close(curve.maxLoss, -300, "max loss");
  close(curve.maxProfit, 700, "max profit");
  close(curve.breakevens[0], 103, "breakeven");
});

test("long put is limited to the premium but profits on the way down", () => {
  const curve = payoffCurve({
    legs: [{ kind: "put", side: "buy", strike: 100 }],
    entry: 4,
    qty: 1,
    spot: 100,
  });
  assertValue(curve.points, 140, () => -400, "above the strike");
  assertValue(curve.points, 60, (price) => -400 + (100 - price) * 100, "at the low end of the sampled range");
  close(curve.maxProfit, 3600, "bounded by the sampled range, not by the payoff");
  close(curve.maxLoss, -400, "max loss");
});

test("contract count scales the payoff", () => {
  const one = payoffCurve({ legs: [{ kind: "call", side: "buy", strike: 100 }], entry: 5, qty: 1, spot: 100 });
  const three = payoffCurve({ legs: [{ kind: "call", side: "buy", strike: 100 }], entry: 5, qty: 3, spot: 100 });
  close(three.maxLoss, one.maxLoss * 3, "max loss scales with qty");
  assert.equal(three.breakevens.length, 1);
  close(three.breakevens[0], 105, "breakeven does not move with qty");
});

// ---------------------------------------------------------------------------
// Credit strategies: premium received, bounded risk
// ---------------------------------------------------------------------------

test("bull put spread caps profit at the credit and loss at the width", () => {
  const curve = payoffCurve({
    legs: [
      { kind: "put", side: "sell", strike: 95 },
      { kind: "put", side: "buy", strike: 90 },
    ],
    entry: 1.5,
    qty: 1,
    spot: 100,
    credit: true,
  });
  assertValue(curve.points, 100, () => 150, "keeps the credit above the short strike");
  close(curve.maxProfit, 150, "the credit is the cap");
  close(curve.maxLoss, -350, "5 points wide minus the 1.5 credit");
  close(curve.breakevens[0], 93.5, "short strike minus the credit");
});

test("bear call spread is the mirror image of the put spread", () => {
  const curve = payoffCurve({
    legs: [
      { kind: "call", side: "sell", strike: 105 },
      { kind: "call", side: "buy", strike: 110 },
    ],
    entry: 1.5,
    qty: 1,
    spot: 100,
    credit: true,
  });
  assertValue(curve.points, 80, () => 150, "keeps the credit below the short strike");
  close(curve.maxProfit, 150, "the credit is the cap");
  close(curve.maxLoss, -350, "5 points wide minus the 1.5 credit");
  close(curve.breakevens[0], 106.5, "short strike plus the credit");
});

test("iron condor collects the credit and loses at most one wing width", () => {
  const curve = payoffCurve({
    legs: [
      { kind: "put", side: "buy", strike: 90 },
      { kind: "put", side: "sell", strike: 95 },
      { kind: "call", side: "sell", strike: 105 },
      { kind: "call", side: "buy", strike: 110 },
    ],
    entry: 2,
    qty: 1,
    spot: 100,
    credit: true,
  });
  assertValue(curve.points, 100, () => 200, "flat between the short strikes");
  close(curve.maxProfit, 200, "the credit is the cap");
  close(curve.maxLoss, -300, "5 wide minus the 2 credit, on either side");
  assert.equal(curve.breakevens.length, 2);
  close(curve.breakevens[0], 93, "lower breakeven");
  close(curve.breakevens[1], 107, "upper breakeven");
});

test("a condor quoted as a debit would invert the whole curve", () => {
  const credit = payoffCurve({
    legs: [
      { kind: "put", side: "buy", strike: 90 },
      { kind: "put", side: "sell", strike: 95 },
      { kind: "call", side: "sell", strike: 105 },
      { kind: "call", side: "buy", strike: 110 },
    ],
    entry: 2,
    qty: 1,
    spot: 100,
    credit: true,
  });
  const debit = payoffCurve({
    legs: [
      { kind: "put", side: "buy", strike: 90 },
      { kind: "put", side: "sell", strike: 95 },
      { kind: "call", side: "sell", strike: 105 },
      { kind: "call", side: "buy", strike: 110 },
    ],
    entry: 2,
    qty: 1,
    spot: 100,
    credit: false,
  });
  close(debit.maxProfit - credit.maxProfit, -400, "the sign of the premium flips 400");
  close(debit.maxLoss - credit.maxLoss, -400, "and shifts the whole floor");
});

// ---------------------------------------------------------------------------
// Covered call: stock leg + short call, premium received
// ---------------------------------------------------------------------------

test("covered call collects the premium and caps upside at the strike", () => {
  const curve = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2,
    qty: 1,
    spot: 100,
    shares: 100,
    basis: 100,
    credit: true,
  });
  const expected = (price) => 200 + (price - 100) * 100 - Math.max(0, price - 105) * 100;
  assertValue(curve.points, 105, expected, "at the strike");
  assertValue(curve.points, 140, expected, "upside is given away");
  close(curve.maxProfit, 700, "premium + 5 points of stock");
  close(curve.maxLoss, -3800, "stock falls to the low end of the sampled range");
  close(curve.breakevens[0], 98, "basis minus premium");
});

test("covered call premium shrinks the loss instead of adding to it", () => {
  const withoutPremium = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 0, qty: 1, spot: 100, shares: 100, basis: 100, credit: true,
  });
  const withPremium = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2, qty: 1, spot: 100, shares: 100, basis: 100, credit: true,
  });
  close(withPremium.maxLoss - withoutPremium.maxLoss, 200, "premium offsets the loss");
  close(withPremium.maxProfit - withoutPremium.maxProfit, 200, "premium lifts the cap");
});

test("without shares a covered call is a naked short call", () => {
  const curve = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2,
    qty: 1,
    spot: 100,
    shares: 0,
    credit: true,
  });
  assertValue(curve.points, 140, (price) => 200 - Math.max(0, price - 105) * 100, "loss runs away");
  close(curve.maxProfit, 200, "premium only");
});

test("stock basis changes the shape of the covered call curve", () => {
  const atCost = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2, qty: 1, spot: 100, shares: 100, basis: 100, credit: true,
  });
  const cheaper = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2, qty: 1, spot: 100, shares: 100, basis: 90, credit: true,
  });
  close(cheaper.maxProfit - atCost.maxProfit, 1000, "a lower basis adds 10 * 100");
  close(cheaper.breakevens[0], 88, "breakeven follows the basis");
});

test("more shares than contracts keeps the extra stock exposed", () => {
  const extra = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2, qty: 1, spot: 100, shares: 200, basis: 100, credit: true,
  });
  // 200 premium + 5 points on 200 shares capped, but the second hundred is free
  assertValue(extra.points, 140, (price) => 200 + (price - 100) * 200 - Math.max(0, price - 105) * 100, "uncovered shares keep running");
  close(extra.maxProfit, 200 + 40 * 200 - 35 * 100, "max profit at the top of the range");
});

// ---------------------------------------------------------------------------
// Protective put: stock leg + long put, premium paid
// ---------------------------------------------------------------------------

test("protective put floors the loss and keeps the upside", () => {
  const curve = payoffCurve({
    legs: [{ kind: "put", side: "buy", strike: 95 }],
    entry: 3,
    qty: 1,
    spot: 100,
    shares: 100,
    basis: 100,
    unbounded: true,
  });
  assertValue(curve.points, 95, () => -800, "the floor holds");
  assertValue(curve.points, 60, () => -800, "below the strike the loss is frozen");
  assertValue(curve.points, 140, (price) => -300 + (price - 100) * 100, "upside is intact");
  close(curve.maxLoss, -800, "max loss");
  assert.equal(curve.maxProfit, null, "upside stays open while holding shares");
  close(curve.breakevens[0], 103, "basis plus premium");
});

test("protective put costs a little more than the stock alone when nothing happens", () => {
  const stockOnly = payoffCurve({
    legs: [{ kind: "put", side: "buy", strike: 95 }],
    entry: 0, qty: 1, spot: 100, shares: 100, basis: 100,
  });
  const hedged = payoffCurve({
    legs: [{ kind: "put", side: "buy", strike: 95 }],
    entry: 3, qty: 1, spot: 100, shares: 100, basis: 100,
  });
  close(hedged.maxLoss - stockOnly.maxLoss, -300, "the hedge is paid for");
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("an unsigned entry is used as an absolute premium", () => {
  const positive = payoffCurve({ legs: [{ kind: "call", side: "buy", strike: 100 }], entry: 5, qty: 1, spot: 100 });
  const negative = payoffCurve({ legs: [{ kind: "call", side: "buy", strike: 100 }], entry: -5, qty: 1, spot: 100 });
  close(negative.maxLoss, positive.maxLoss, "sign of entry does not flip the ticket");
});

test("missing inputs produce an empty curve instead of throwing", () => {
  assert.deepEqual(payoffCurve({}), EMPTY);
  assert.deepEqual(payoffCurve({ legs: [{ kind: "call", side: "buy", strike: 100 }], spot: 0 }), EMPTY);
  assert.deepEqual(payoffCurve({ legs: [], spot: 100 }), EMPTY);
  assert.deepEqual(payoffCurve({ legs: [{ kind: "call", side: "buy", strike: 100 }], spot: 100, qty: 0 }), EMPTY);
});

test("legs without a finite strike are skipped", () => {
  const curve = payoffCurve({
    legs: [{ kind: "call", side: "buy", strike: Number.NaN }],
    entry: 5,
    qty: 1,
    spot: 100,
  });
  close(curve.maxLoss, -500, "only the premium applies");
});

test("shares without a basis are measured from the current price", () => {
  const fromSpot = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2, qty: 1, spot: 100, shares: 100, credit: true,
  });
  const fromBasis = payoffCurve({
    legs: [{ kind: "call", side: "sell", strike: 105 }],
    entry: 2, qty: 1, spot: 100, shares: 100, basis: 100, credit: true,
  });
  close(fromSpot.maxProfit, fromBasis.maxProfit, "spot is the default basis");
});

// ---------------------------------------------------------------------------
// Share requirement
// ---------------------------------------------------------------------------

test("required shares are 100 per whole contract", () => {
  assert.equal(CONTRACT_MULTIPLIER, 100);
  assert.equal(requiredShares(1), 100);
  assert.equal(requiredShares(3), 300);
  assert.equal(requiredShares(2.9), 200, "fractional contracts round down");
  assert.equal(requiredShares(0), 0);
  assert.equal(requiredShares("4"), 400);
  assert.equal(requiredShares(null), 0);
  assert.equal(requiredShares(undefined), 0);
});
