"""Derived analytics computed from Alpaca bars: returns, risk, trend and comparison."""
from __future__ import annotations

import math
from datetime import datetime, timezone
from statistics import mean, pstdev

from .config import ET


def closes(bars: list[dict]) -> list[float]:
    return [bar["close"] for bar in bars if bar.get("close") is not None]


def sma(values: list[float], window: int) -> float | None:
    if len(values) < window:
        return None
    return mean(values[-window:])


def ema_series(values: list[float], window: int) -> list[float]:
    if not values:
        return []
    alpha = 2 / (window + 1)
    result = [values[0]]
    for value in values[1:]:
        result.append(alpha * value + (1 - alpha) * result[-1])
    return result


def rsi(values: list[float], window: int = 14) -> float | None:
    if len(values) <= window:
        return None
    gains, losses = [], []
    for index in range(1, len(values)):
        delta = values[index] - values[index - 1]
        gains.append(max(delta, 0.0))
        losses.append(max(-delta, 0.0))
    avg_gain = mean(gains[:window])
    avg_loss = mean(losses[:window])
    for index in range(window, len(gains)):
        avg_gain = (avg_gain * (window - 1) + gains[index]) / window
        avg_loss = (avg_loss * (window - 1) + losses[index]) / window
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def atr(bars: list[dict], window: int = 14) -> float | None:
    if len(bars) <= window:
        return None
    ranges = []
    for index in range(1, len(bars)):
        high, low = bars[index].get("high"), bars[index].get("low")
        prev_close = bars[index - 1].get("close")
        if high is None or low is None or prev_close is None:
            continue
        ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    if len(ranges) < window:
        return None
    value = mean(ranges[:window])
    for item in ranges[window:]:
        value = (value * (window - 1) + item) / window
    return value


def max_drawdown(values: list[float]) -> float | None:
    if not values:
        return None
    peak = values[0]
    worst = 0.0
    for value in values:
        peak = max(peak, value)
        if peak:
            worst = min(worst, value / peak - 1)
    return worst


def daily_returns(bars: list[dict]) -> dict[str, float]:
    result: dict[str, float] = {}
    for index in range(1, len(bars)):
        previous = bars[index - 1].get("close")
        current = bars[index].get("close")
        stamp = (bars[index].get("time") or "")[:10]
        if previous and current and stamp:
            result[stamp] = current / previous - 1
    return result


def beta(stock: list[dict], benchmark: list[dict]) -> float | None:
    stock_returns = daily_returns(stock)
    bench_returns = daily_returns(benchmark)
    common = sorted(set(stock_returns) & set(bench_returns))
    if len(common) < 30:
        return None
    stock_values = [stock_returns[key] for key in common]
    bench_values = [bench_returns[key] for key in common]
    variance = pstdev(bench_values) ** 2
    if not variance:
        return None
    covariance = sum((s - mean(stock_values)) * (b - mean(bench_values)) for s, b in zip(stock_values, bench_values)) / len(common)
    return covariance / variance


def correlation(stock: list[dict], benchmark: list[dict]) -> float | None:
    stock_returns = daily_returns(stock)
    bench_returns = daily_returns(benchmark)
    common = sorted(set(stock_returns) & set(bench_returns))
    if len(common) < 20:
        return None
    a = [stock_returns[key] for key in common]
    b = [bench_returns[key] for key in common]
    if not pstdev(a) or not pstdev(b):
        return None
    ma, mb = mean(a), mean(b)
    numerator = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    denominator = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return numerator / denominator if denominator else None


def period_return(values: list[float], sessions: int) -> float | None:
    if len(values) <= sessions:
        return None
    base = values[-1 - sessions]
    return values[-1] / base - 1 if base else None


def compute_analysis(symbol: str, daily: list[dict], spy: list[dict], qqq: list[dict], latest_price: float | None = None) -> dict:
    values = closes(daily)
    if latest_price and values:
        today = datetime.now(ET).date().isoformat()
        last_date = (daily[-1].get("time") or "")[:10]
        if last_date == today:
            values[-1] = latest_price
        elif latest_price != values[-1]:
            values.append(latest_price)
    if len(values) < 30:
        return {"ready": False, "reason": "历史日线不足，暂时无法计算分析指标。"}

    price = latest_price or values[-1]
    windows = {"1W": 5, "1M": 21, "3M": 63, "6M": 126, "1Y": 252}
    returns = {label: period_return(values, sessions) for label, sessions in windows.items()}
    current_year = datetime.now(timezone.utc).year
    ytd_base = None
    for index, bar in enumerate(daily):
        if (bar.get("time") or "")[:4] == str(current_year):
            ytd_base = values[index] if index < len(values) else None
            break
    returns["YTD"] = price / ytd_base - 1 if ytd_base else None

    year_values = values[-252:] if len(values) >= 252 else values
    high_52w = max(year_values)
    low_52w = min(year_values)
    range_position = (price - low_52w) / (high_52w - low_52w) if high_52w > low_52w else None

    volumes = [bar.get("volume") or 0 for bar in daily]
    avg_volume_20 = mean(volumes[-20:]) if len(volumes) >= 20 else None
    avg_volume_90 = mean(volumes[-90:]) if len(volumes) >= 90 else None
    dollar_volume = avg_volume_20 * price if avg_volume_20 else None

    rets = [values[i] / values[i - 1] - 1 for i in range(1, len(values)) if values[i - 1]]
    recent = rets[-252:] if len(rets) >= 252 else rets
    volatility = pstdev(recent) * math.sqrt(252) if len(recent) > 2 else None
    downside = [value for value in recent if value < 0]
    downside_dev = pstdev(downside) * math.sqrt(252) if len(downside) > 2 else None
    sharpe = (mean(recent) * 252) / volatility if volatility else None
    sortino = (mean(recent) * 252) / downside_dev if downside_dev else None

    beta_1y = beta(daily[-253:], spy[-253:])
    corr_spy = correlation(daily[-253:], spy[-253:])
    corr_qqq = correlation(daily[-253:], qqq[-253:])

    sma20, sma50, sma200 = sma(values, 20), sma(values, 50), sma(values, 200)
    rsi14 = rsi(values)
    atr14 = atr(daily)
    ema12, ema26 = ema_series(values, 12), ema_series(values, 26)
    macd_line = [a - b for a, b in zip(ema12, ema26)]
    signal_line = ema_series(macd_line, 9)
    macd = macd_line[-1]
    macd_signal = signal_line[-1]
    macd_hist = macd - macd_signal

    def signal(label: str, tone: str, note: str, value: str | None = None) -> dict:
        return {"label": label, "tone": tone, "note": note, "value": value}

    signals = []
    if sma20 and sma50:
        signals.append(signal("均线结构", "positive" if sma20 > sma50 else "negative",
                              "20 日均线高于 50 日均线，短期趋势偏强。" if sma20 > sma50 else "20 日均线低于 50 日均线，短期趋势偏弱。"))
    if sma50 and sma200:
        golden = sma50 > sma200
        signals.append(signal("长期趋势", "positive" if golden else "negative",
                              "50 日均线在 200 日均线上方（金叉结构）。" if golden else "50 日均线在 200 日均线下方（死叉结构）。"))
    if rsi14 is not None:
        if rsi14 >= 70:
            tone, note = "negative", "RSI 高于 70，处于超买区间，注意回调风险。"
        elif rsi14 <= 30:
            tone, note = "positive", "RSI 低于 30，处于超卖区间，可能出现反弹。"
        elif rsi14 >= 50:
            tone, note = "positive", "RSI 位于 50 上方，动量偏多。"
        else:
            tone, note = "negative", "RSI 位于 50 下方，动量偏空。"
        signals.append(signal("RSI(14)", tone, note, f"{rsi14:.1f}"))
    if macd_hist:
        signals.append(signal("MACD", "positive" if macd_hist > 0 else "negative",
                              "MACD 柱状值为正，动能偏多。" if macd_hist > 0 else "MACD 柱状值为负，动能偏空。", f"{macd_hist:.3f}"))
    if avg_volume_20 and volumes:
        ratio = volumes[-1] / avg_volume_20 if avg_volume_20 else None
        if ratio:
            signals.append(signal("成交量", "positive" if ratio > 1.2 else "neutral",
                                  f"今日成交量是 20 日均量的 {ratio:.2f} 倍。", f"{ratio:.2f}x"))
    if range_position is not None:
        signals.append(signal("52 周位置", "positive" if range_position > 0.7 else "negative" if range_position < 0.3 else "neutral",
                              f"当前价格位于 52 周区间的 {range_position * 100:.0f}% 位置。", f"{range_position * 100:.0f}%"))

    compare_dates = None
    compare = None
    stock_map = {(bar.get("time") or "")[:10]: bar.get("close") for bar in daily}
    spy_map = {(bar.get("time") or "")[:10]: bar.get("close") for bar in spy}
    qqq_map = {(bar.get("time") or "")[:10]: bar.get("close") for bar in qqq}
    common_dates = sorted(set(stock_map) & set(spy_map) & set(qqq_map))[-252:]
    if len(common_dates) > 5:
        compare_dates = common_dates
        compare = {
            "stock": [round(stock_map[day] / stock_map[common_dates[0]] * 100, 2) for day in common_dates],
            "spy": [round(spy_map[day] / spy_map[common_dates[0]] * 100, 2) for day in common_dates],
            "qqq": [round(qqq_map[day] / qqq_map[common_dates[0]] * 100, 2) for day in common_dates],
        }

    return {
        "ready": True,
        "price": price,
        "returns": returns,
        "high_52w": high_52w,
        "low_52w": low_52w,
        "range_position": range_position,
        "avg_volume_20": avg_volume_20,
        "avg_volume_90": avg_volume_90,
        "dollar_volume": dollar_volume,
        "volatility": volatility,
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown": max_drawdown(year_values),
        "beta": beta_1y,
        "correlation_spy": corr_spy,
        "correlation_qqq": corr_qqq,
        "sma20": sma20,
        "sma50": sma50,
        "sma200": sma200,
        "rsi14": rsi14,
        "atr14": atr14,
        "macd": macd,
        "macd_signal": macd_signal,
        "macd_hist": macd_hist,
        "signals": signals,
        "compare": {"dates": compare_dates, **(compare or {})} if compare else None,
        "sessions": len(values),
    }
