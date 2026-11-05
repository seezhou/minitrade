function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function smaSeries(values, period) {
  const output = new Array(values.length).fill(null);
  if (!period || values.length < period) return output;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

export function emaSeries(values, period) {
  const output = new Array(values.length).fill(null);
  if (!values.length) return output;
  const alpha = 2 / (period + 1);
  let previous = values[0];
  output[0] = previous;
  for (let index = 1; index < values.length; index += 1) {
    previous = alpha * values[index] + (1 - alpha) * previous;
    output[index] = previous;
  }
  return output;
}

export function bollSeries(values, period = 20, multiplier = 2) {
  const mid = smaSeries(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const average = mid[index];
    const variance = window.reduce((sum, value) => sum + (value - average) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);
    upper[index] = average + multiplier * deviation;
    lower[index] = average - multiplier * deviation;
  }
  return { mid, upper, lower };
}

export function rsiSeries(values, period = 14) {
  const output = new Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  output[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    output[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return output;
}

export function macdSeries(values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const dif = values.map((_, index) => (fast[index] == null || slow[index] == null ? null : fast[index] - slow[index]));
  const clean = dif.map((value) => (value == null ? 0 : value));
  const dea = emaSeries(clean, 9);
  const hist = dif.map((value, index) => (value == null || dea[index] == null ? null : (value - dea[index]) * 2));
  return { dif, dea, hist };
}

export function atrSeries(bars, period = 14) {
  const output = new Array(bars.length).fill(null);
  if (bars.length <= period) return output;
  let previous = null;
  for (let index = 1; index < bars.length; index += 1) {
    const high = bars[index].high;
    const low = bars[index].low;
    const close = bars[index - 1].close;
    if (![high, low, close].every(Number.isFinite)) continue;
    const tr = Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
    if (index === period) {
      previous = tr;
      output[index] = tr;
    } else if (index > period) {
      previous = (previous * (period - 1) + tr) / period;
      output[index] = previous;
    }
  }
  return output;
}

export function computeIndicators(bars) {
  const closes = bars.map((bar) => Number(bar.close));
  const ma5 = smaSeries(closes, 5);
  const ma10 = smaSeries(closes, 10);
  const ma20 = smaSeries(closes, 20);
  const ma50 = smaSeries(closes, 50);
  const ma200 = smaSeries(closes, 200);
  const boll = bollSeries(closes, 20, 2);
  const rsi = rsiSeries(closes, 14);
  const macd = macdSeries(closes);
  return { closes, ma5, ma10, ma20, ma50, ma200, boll, rsi, macd };
}

export function rangeReturn(bars, fromIndex = 0) {
  if (!bars.length) return null;
  const start = bars[Math.max(0, fromIndex)]?.close;
  const end = bars[bars.length - 1]?.close;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !start) return null;
  return end / start - 1;
}

export function normalized(values) {
  if (!values.length) return [];
  const base = values.find((value) => Number.isFinite(value) && value !== 0);
  if (!base) return values.map(() => null);
  return values.map((value) => (Number.isFinite(value) ? (value / base) * 100 : null));
}
