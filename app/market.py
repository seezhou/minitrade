"""Market data routes: quotes, bars, analytics, news, screener and corporate actions."""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query

from .alpaca_api import (
    UpstreamError,
    as_float,
    as_int,
    asset_lookup,
    data_get,
    get_asset,
    iso,
    latest_quotes_for,
    normalize_bar,
    normalize_news,
    normalize_snapshot,
    search_assets,
    snapshots_for,
    trading_get,
)
from .analysis import compute_analysis
from .cache import cache
from .config import DATA_FEED, ET

log = logging.getLogger("minitrade.market")
router = APIRouter(prefix="/api")

RANGE_CONFIG: dict[str, dict[str, Any]] = {
    "1D": {"timeframe": "1Min", "days": 0, "lookback": 0, "label": "1 天", "interval": "1 分钟"},
    "5D": {"timeframe": "5Min", "days": 9, "lookback": 0, "label": "5 天", "interval": "5 分钟"},
    "1M": {"timeframe": "30Min", "days": 35, "lookback": 0, "label": "1 个月", "interval": "30 分钟"},
    "3M": {"timeframe": "1Day", "days": 93, "lookback": 300, "label": "3 个月", "interval": "日线"},
    "6M": {"timeframe": "1Day", "days": 186, "lookback": 300, "label": "6 个月", "interval": "日线"},
    "1Y": {"timeframe": "1Day", "days": 366, "lookback": 360, "label": "1 年", "interval": "日线"},
    "5Y": {"timeframe": "1Week", "days": 1826, "lookback": 365, "label": "5 年", "interval": "周线"},
}

INDEX_ETFS = [
    {"symbol": "SPY", "name": "标普 500 ETF", "short": "S&P 500"},
    {"symbol": "QQQ", "name": "纳指 100 ETF", "short": "Nasdaq 100"},
    {"symbol": "DIA", "name": "道指 ETF", "short": "Dow 30"},
    {"symbol": "IWM", "name": "罗素 2000 ETF", "short": "Russell 2000"},
]


def _symbol_or_422(symbol: str) -> str:
    symbol = (symbol or "").strip().upper()
    from .config import valid_symbol

    if not valid_symbol(symbol):
        raise HTTPException(status_code=422, detail="请输入有效的股票代码，例如 AAPL。")
    return symbol


# ---------------------------------------------------------------------------
# Clock & calendar
# ---------------------------------------------------------------------------


def market_clock() -> dict:
    def load() -> dict:
        raw = trading_get("/v2/clock")
        now = datetime.now(ET)
        return {
            "is_open": bool(raw.get("is_open")),
            "timestamp": iso(raw.get("timestamp")),
            "next_open": iso(raw.get("next_open")),
            "next_close": iso(raw.get("next_close")),
            "now_et": now.isoformat(),
            "session": _session_name(now, bool(raw.get("is_open"))),
        }

    return cache.get_or_set("market:clock", 8, load, stale_ttl=120)


def _session_name(now: datetime, is_open: bool) -> str:
    minutes = now.hour * 60 + now.minute
    weekday = now.weekday() < 5
    if is_open:
        return "regular"
    if weekday and 4 * 60 <= minutes < 9 * 60 + 30:
        return "premarket"
    if weekday and 16 * 60 <= minutes < 20 * 60:
        return "afterhours"
    return "closed"


def trading_calendar(start: date, end: date) -> list[dict]:
    def load() -> list[dict]:
        raw = trading_get("/v2/calendar", {"start": start.isoformat(), "end": end.isoformat()})
        return [
            {
                "date": item.get("date"),
                "open": item.get("open"),
                "close": item.get("close"),
                "session_open": item.get("session_open"),
                "session_close": item.get("session_close"),
            }
            for item in raw
        ]

    key = f"market:calendar:{start}:{end}"
    return cache.get_or_set(key, 3600, load, stale_ttl=6 * 3600)


def _calendar_days(days_back: int = 10, days_forward: int = 0) -> list[dict]:
    today = datetime.now(ET).date()
    return trading_calendar(today - timedelta(days=days_back), today + timedelta(days=days_forward))


def _last_session_date() -> date:
    now = datetime.now(ET)
    try:
        entries = _calendar_days(days_back=14, days_forward=2)
    except UpstreamError:
        session_day = now.date()
        while session_day.weekday() >= 5:
            session_day -= timedelta(days=1)
        return session_day
    candidates = [date.fromisoformat(item["date"]) for item in entries if item.get("date")]
    candidates = [day for day in candidates if day <= now.date()]
    return max(candidates) if candidates else now.date()


def _intraday_start() -> datetime:
    now = datetime.now(ET)
    session_day = _last_session_date()
    if session_day == now.date() and now.hour < 4:
        parsed = sorted(
            date.fromisoformat(item["date"])
            for item in (_calendar_days(days_back=10) or [])
            if item.get("date") and date.fromisoformat(item["date"]) < now.date()
        )
        if parsed:
            session_day = parsed[-1]
    return datetime.combine(session_day, time(4, 0), tzinfo=ET)


@router.get("/clock")
def clock() -> dict:
    return market_clock()


@router.get("/calendar")
def calendar(days: int = Query(10, ge=1, le=45)) -> dict:
    today = datetime.now(ET).date()
    entries = trading_calendar(today - timedelta(days=1), today + timedelta(days=days))
    upcoming = [item for item in entries if item["date"] >= today.isoformat()]
    return {"today": today.isoformat(), "upcoming": upcoming[:days], "timezone": "America/New_York"}


# ---------------------------------------------------------------------------
# Bars
# ---------------------------------------------------------------------------


def _bars_request(
    symbols: list[str],
    timeframe: str,
    start: datetime,
    *,
    limit: int = 10000,
    adjustment: str = "all",
    max_pages: int = 10,
) -> tuple[dict[str, list[dict]], str]:
    params: dict[str, Any] = {
        "symbols": ",".join(symbols),
        "timeframe": timeframe,
        "start": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "limit": limit,
        "feed": "sip",
        "adjustment": adjustment,
        "sort": "asc",
    }
    # Do not send an explicit "end" close to now: recent SIP data returns 403 on this plan.
    # Omitting it lets Alpaca apply the allowed delayed boundary.
    try:
        raw = _paged_bars(params, max_pages)
        feed = "sip"
    except UpstreamError as exc:
        if exc.status != 403:
            raise
        params["feed"] = "iex"
        raw = _paged_bars(params, max_pages)
        feed = "iex"
    result: dict[str, list[dict]] = {}
    for symbol, rows in (raw.get("bars") or {}).items():
        result[symbol] = [normalize_bar(row, symbol=symbol) for row in rows if row.get("c") is not None]
    for symbol in symbols:
        result.setdefault(symbol, [])
    return result, feed


def _paged_bars(params: dict[str, Any], max_pages: int) -> dict:
    merged: dict[str, list[dict]] = {}
    page_token = None
    last_raw: dict[str, Any] = {}
    for _ in range(max_pages):
        request_params = dict(params)
        if page_token:
            request_params["page_token"] = page_token
        raw = data_get("/v2/stocks/bars", request_params, timeout=30)
        last_raw = raw
        for symbol, rows in (raw.get("bars") or {}).items():
            merged.setdefault(symbol, []).extend(rows)
        page_token = raw.get("next_page_token")
        if not page_token:
            break
    return {"bars": merged, "next_page_token": last_raw.get("next_page_token")}


def bars_for_range(symbol: str, range_key: str) -> dict:
    config = RANGE_CONFIG.get(range_key)
    if not config:
        raise HTTPException(status_code=422, detail="不支持的时间范围。")
    now = datetime.now(ET)
    if range_key == "1D":
        start = _intraday_start()
    else:
        start = now - timedelta(days=config["days"] + config["lookback"])
    display_from = now - timedelta(days=config["days"]) if config["days"] else start
    adjustment = "all" if config["timeframe"] in ("1Day", "1Week") else "raw"
    cache_key = f"bars:{symbol}:{range_key}"
    ttl = 25 if config["timeframe"].endswith("Min") else 240

    def load() -> dict:
        data, source_feed = _bars_request([symbol], config["timeframe"], start, adjustment=adjustment)
        bars = data.get(symbol, [])
        return {
            "symbol": symbol,
            "range": range_key,
            "range_label": config["label"],
            "interval": config["interval"],
            "timeframe": config["timeframe"],
            "bars": bars,
            "display_from": display_from.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "source_feed": source_feed,
            "feed_label": DATA_FEED if config["timeframe"].endswith("Min") else "SIP 历史综合行情",
            "delayed_minutes": 15,
        }

    return cache.get_or_set(cache_key, ttl, load, stale_ttl=600)


@router.get("/stocks/{symbol}/bars")
def stock_bars(symbol: str, range: str = Query("1D", alias="range")) -> dict:
    symbol = _symbol_or_422(symbol)
    return bars_for_range(symbol, range.upper())


def daily_bars(symbol: str, days: int = 800) -> list[dict]:
    def load() -> list[dict]:
        start = datetime.now(timezone.utc) - timedelta(days=days)
        data, _ = _bars_request([symbol], "1Day", start, adjustment="all")
        return data.get(symbol, [])

    return cache.get_or_set(f"daily:{symbol}:{days}", 300, load, stale_ttl=3600)


# ---------------------------------------------------------------------------
# Quotes & search
# ---------------------------------------------------------------------------


def sparklines_for(symbols: list[str]) -> dict[str, list[float]]:
    if not symbols:
        return {}
    key = "sparks:" + ",".join(sorted(symbols))

    def load() -> dict[str, list[float]]:
        start = datetime.now(timezone.utc) - timedelta(days=70)
        data, _ = _bars_request(symbols, "1Day", start, adjustment="all")
        return {
            symbol: [round(bar["close"], 4) for bar in data.get(symbol, []) if bar.get("close") is not None][-40:]
            for symbol in symbols
        }

    return cache.get_or_set(key, 300, load, stale_ttl=1800)


@router.get("/quotes")
def quotes(symbols: str = Query(..., min_length=1, max_length=600), sparkline: bool = False) -> list[dict]:
    parsed = [item.strip().upper() for item in symbols.split(",") if item.strip()]
    if len(parsed) > 50:
        raise HTTPException(status_code=422, detail="一次最多查询 50 个股票代码。")
    from .config import valid_symbol

    parsed = [item for item in parsed if valid_symbol(item)]
    if not parsed:
        return []
    try:
        snapshots = snapshots_for(parsed)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None
    sparks = {}
    if sparkline:
        try:
            sparks = sparklines_for(parsed)
        except UpstreamError:
            sparks = {}
    results = []
    for symbol in parsed:
        item = dict(snapshots.get(symbol) or {"symbol": symbol})
        item["spark"] = sparks.get(symbol, [])
        results.append(item)
    return results


@router.get("/search")
def search(q: str = Query(..., min_length=1, max_length=60)) -> list[dict]:
    try:
        return search_assets(q.strip())
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/assets/{symbol}")
def asset_detail(symbol: str) -> dict:
    symbol = _symbol_or_422(symbol)
    asset = get_asset(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail="没有找到这个股票代码。")
    return asset


# ---------------------------------------------------------------------------
# Summary & analysis
# ---------------------------------------------------------------------------


def _daily_for(symbol: str, days: int = 800) -> list[dict]:
    try:
        return daily_bars(symbol, days)
    except UpstreamError:
        return []


def _bar_session(bar: dict) -> str:
    try:
        stamp = datetime.fromisoformat(str(bar.get("time")).replace("Z", "+00:00")).astimezone(ET)
    except (TypeError, ValueError):
        return "closed"
    minutes = stamp.hour * 60 + stamp.minute
    if 4 * 60 <= minutes < 9 * 60 + 30:
        return "premarket"
    if 9 * 60 + 30 <= minutes < 16 * 60:
        return "regular"
    if 16 * 60 <= minutes < 20 * 60:
        return "afterhours"
    return "closed"


def _today_session_stats(symbol: str) -> dict | None:
    """Alpaca's snapshot daily bar is the last completed session, so derive today's OHLCV from minute bars."""
    try:
        bars = bars_for_range(symbol, "1D")["bars"]
    except (UpstreamError, HTTPException):
        return None
    today = datetime.now(ET).date()
    regular = []
    for bar in bars:
        try:
            stamp = datetime.fromisoformat(str(bar.get("time")).replace("Z", "+00:00")).astimezone(ET)
        except (TypeError, ValueError):
            continue
        if stamp.date() == today and _bar_session(bar) == "regular":
            regular.append(bar)
    if not regular:
        return None
    highs = [item["high"] for item in regular if item.get("high") is not None]
    lows = [item["low"] for item in regular if item.get("low") is not None]
    if not highs or not lows:
        return None
    volume = sum(item.get("volume") or 0 for item in regular)
    vwap_numerator = sum((item.get("vwap") or item.get("close") or 0) * (item.get("volume") or 0) for item in regular)
    return {
        "open": regular[0]["open"],
        "high": max(highs),
        "low": min(lows),
        "volume": volume,
        "vwap": (vwap_numerator / volume) if volume else None,
        "from": regular[0]["time"],
        "to": regular[-1]["time"],
        "bars": len(regular),
    }


def stock_summary(symbol: str) -> dict:
    cached = cache.get(f"summary:{symbol}", 8)
    if cached is not None:
        return cached
    asset = get_asset(symbol)
    if not asset:
        raise HTTPException(status_code=404, detail="没有找到这个股票代码。")
    snapshots = snapshots_for([symbol])
    snapshot = snapshots.get(symbol)
    daily = _daily_for(symbol, 900)
    spy = _daily_for("SPY", 500)
    qqq = _daily_for("QQQ", 500)
    analysis = compute_analysis(symbol, daily, spy, qqq, (snapshot or {}).get("price"))
    if snapshot:
        snapshot["session"] = _today_session_stats(symbol)
    summary = {
        "asset": asset,
        "snapshot": snapshot,
        "analysis": analysis,
        "feed": {"name": DATA_FEED, "label": "SIP 综合行情（约延迟 15 分钟）"},
    }
    return cache.set(f"summary:{symbol}", summary)


@router.get("/stocks/{symbol}/summary")
def summary(symbol: str) -> dict:
    return stock_summary(_symbol_or_422(symbol))


@router.get("/stocks/{symbol}/snapshot")
def snapshot(symbol: str) -> dict:
    symbol = _symbol_or_422(symbol)
    data = snapshots_for([symbol]).get(symbol)
    if not data:
        raise HTTPException(status_code=404, detail="暂时没有这只股票的行情快照。")
    return data


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------


def get_news(symbols: str | None = None, limit: int = 20, content: bool = False) -> list[dict]:
    symbol_list = [item.strip().upper() for item in (symbols or "").split(",") if item.strip()][:20]
    key = f"news:{','.join(symbol_list)}:{limit}:{int(content)}"

    def load() -> list[dict]:
        params: dict[str, Any] = {"limit": limit, "sort": "desc", "include_content": str(content).lower()}
        if symbol_list:
            params["symbols"] = ",".join(symbol_list)
        raw = data_get("/v1beta1/news", params)
        return [normalize_news(item, include_content=content) for item in raw.get("news", [])]

    try:
        return cache.get_or_set(key, 60, load, stale_ttl=900)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/news")
def news(
    symbols: str | None = Query(None, max_length=400),
    limit: int = Query(20, ge=1, le=50),
    content: bool = False,
) -> list[dict]:
    return get_news(symbols, limit, content)


# ---------------------------------------------------------------------------
# Corporate actions
# ---------------------------------------------------------------------------


def _action_date(entry: dict) -> tuple[str, str]:
    for key in ("ex_date", "effective_date", "process_date", "payable_date", "record_date", "date"):
        if entry.get(key):
            return key, str(entry[key])
    return "date", ""


_ACTION_GROUPS = {
    "cash_dividends": ("现金分红", "dividend"),
    "stock_dividends": ("股票分红", "dividend"),
    "stock_splits": ("拆股", "split"),
    "reverse_splits": ("反向拆股", "split"),
    "mergers": ("并购", "merger"),
    "cash_mergers": ("现金并购", "merger"),
    "stock_mergers": ("换股并购", "merger"),
    "spinoffs": ("分拆", "spinoff"),
    "redemptions": ("赎回", "other"),
    "name_changes": ("更名", "other"),
    "worthless_removals": ("退市", "other"),
    "rights_distributions": ("供股", "other"),
}


@router.get("/stocks/{symbol}/actions")
def actions(symbol: str, years: int = Query(3, ge=1, le=10)) -> dict:
    symbol = _symbol_or_422(symbol)

    def load() -> dict:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=365 * years)
        raw = data_get("/v1beta1/corporate-actions", {
            "symbols": symbol,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "limit": 1000,
        })
        groups = raw.get("corporate_actions") or {}
        output = []
        for key, (title, kind) in _ACTION_GROUPS.items():
            entries = groups.get(key) or []
            if not entries:
                continue
            items = []
            for entry in entries:
                date_key, date_value = _action_date(entry)
                items.append({
                    "type": kind,
                    "group": key,
                    "title": title,
                    "date_key": date_key,
                    "date": date_value,
                    "rate": as_float(entry.get("rate")),
                    "old_rate": as_float(entry.get("old_rate")),
                    "new_rate": as_float(entry.get("new_rate")),
                    "special": bool(entry.get("special")),
                    "foreign": bool(entry.get("foreign")),
                    "payable_date": entry.get("payable_date"),
                    "record_date": entry.get("record_date"),
                    "raw": entry,
                })
            output.append({"key": key, "title": title, "kind": kind, "items": items})
        for group in output:
            group["items"].sort(key=lambda item: item.get("date") or "", reverse=True)
        return {"symbol": symbol, "groups": output, "count": sum(len(group["items"]) for group in output)}

    try:
        return cache.get_or_set(f"actions:{symbol}:{years}", 3600, load, stale_ttl=6 * 3600)
    except UpstreamError as exc:
        if exc.status == 404:
            return {"symbol": symbol, "groups": [], "count": 0}
        raise HTTPException(status_code=502, detail=exc.message) from None


# ---------------------------------------------------------------------------
# Screener, crypto & overview
# ---------------------------------------------------------------------------


def _enrich_screener(rows: list[dict], top: int, min_volume: float = 0) -> list[dict]:
    symbols = [row["symbol"] for row in rows if row.get("symbol")]
    try:
        snapshots = snapshots_for(symbols)
    except UpstreamError:
        snapshots = {}
    assets = asset_lookup()
    results = []
    for row in rows:
        symbol = row.get("symbol")
        if not symbol:
            continue
        snapshot = snapshots.get(symbol) or {}
        asset = assets.get(symbol) or {}
        row_price = as_float(row.get("price"))
        snapshot_price = as_float(snapshot.get("price"))
        display_price = snapshot_price if snapshot_price is not None else row_price
        if display_price is not None and display_price < 0.5:
            continue
        volume = snapshot.get("volume") or row.get("volume")
        if min_volume and (volume or 0) < min_volume:
            continue
        change_pct = snapshot.get("change_pct")
        if change_pct is None and row.get("percent_change") is not None:
            change_pct = (as_float(row.get("percent_change")) or 0) / 100
        results.append({
            "symbol": symbol,
            "name": asset.get("name") or snapshot.get("name") or symbol,
            "price": display_price,
            "change": snapshot.get("change") if snapshot.get("change") is not None else as_float(row.get("change")),
            "change_pct": change_pct,
            "volume": snapshot.get("volume") or row.get("volume"),            "trade_count": row.get("trade_count") or snapshot.get("trade_count"),
            "logo_url": f"/api/stocks/{symbol}/logo",
        })
        if len(results) >= top:
            break
    return results


@router.get("/market/movers")
def market_movers(top: int = Query(8, ge=1, le=20)) -> dict:
    def load() -> dict:
        raw = data_get("/v1beta1/screener/stocks/movers", {"top": top * 2})
        return {
            "gainers": _enrich_screener(raw.get("gainers") or [], top, min_volume=100_000),
            "losers": _enrich_screener(raw.get("losers") or [], top, min_volume=100_000),
            "last_updated": raw.get("last_updated"),
        }

    try:
        return cache.get_or_set("market:movers", 45, load, stale_ttl=300)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/market/actives")
def market_actives(top: int = Query(12, ge=1, le=25)) -> list[dict]:
    def load() -> list[dict]:
        raw = data_get("/v1beta1/screener/stocks/most-actives", {"top": top * 2, "by": "volume"})
        return _enrich_screener(raw.get("most_actives") or [], top)

    try:
        return cache.get_or_set("market:actives", 45, load, stale_ttl=300)
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None


CRYPTO_SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"]


@router.get("/market/crypto")
def crypto() -> list[dict]:
    def load() -> list[dict]:
        raw = data_get("/v1beta3/crypto/us/snapshots", {"symbols": ",".join(CRYPTO_SYMBOLS)})
        rows = []
        for symbol, item in (raw.get("snapshots") or {}).items():
            trade = item.get("latestTrade") or {}
            daily = item.get("dailyBar") or {}
            previous = item.get("prevDailyBar") or {}
            price = as_float(trade.get("p")) or as_float(daily.get("c"))
            prev_close = as_float(previous.get("c")) or as_float(daily.get("c"))
            change = price - prev_close if price is not None and prev_close else None
            rows.append({
                "symbol": symbol,
                "name": {"BTC/USD": "比特币", "ETH/USD": "以太坊", "SOL/USD": "Solana"}.get(symbol, symbol),
                "price": price,
                "previous_close": prev_close,
                "change": change,
                "change_pct": change / prev_close if change is not None and prev_close else None,
                "high": as_float(daily.get("h")),
                "low": as_float(daily.get("l")),
                "volume": as_float(daily.get("v")),
                "trade_ts": iso(trade.get("t")),
            })
        order = {symbol: index for index, symbol in enumerate(CRYPTO_SYMBOLS)}
        rows.sort(key=lambda item: order.get(item["symbol"], 99))
        return rows

    try:
        return cache.get_or_set("market:crypto", 30, load, stale_ttl=600)
    except UpstreamError:
        return []


@router.get("/overview")
def overview() -> dict:
    symbol_list = [item["symbol"] for item in INDEX_ETFS]

    def safe(fn, default):
        try:
            return fn()
        except Exception as exc:  # overview should degrade, not fail
            log.warning("overview part failed: %s", exc)
            return default

    with ThreadPoolExecutor(max_workers=6) as pool:
        clock_future = pool.submit(safe, market_clock, {})
        indices_future = pool.submit(safe, lambda: quotes(",".join(symbol_list), True), [])
        actives_future = pool.submit(safe, lambda: market_actives(8), [])
        movers_future = pool.submit(safe, lambda: market_movers(6), {"gainers": [], "losers": []})
        news_future = pool.submit(safe, lambda: get_news(limit=8, content=False), [])
        crypto_future = pool.submit(safe, crypto, [])
        calendar_future = pool.submit(safe, lambda: calendar(8), {})

    index_quotes = indices_future.result() or []
    by_symbol = {item.get("symbol"): item for item in index_quotes}
    indices = []
    for config in INDEX_ETFS:
        quote = by_symbol.get(config["symbol"], {})
        indices.append({**config, **quote, "short": config["short"]})

    return {
        "clock": clock_future.result(),
        "indices": indices,
        "actives": actives_future.result(),
        "movers": movers_future.result(),
        "news": news_future.result(),
        "crypto": crypto_future.result(),
        "calendar": calendar_future.result(),
        "feed": {"name": DATA_FEED, "label": "SIP 综合行情（约延迟 15 分钟）", "delay_minutes": 15},
    }


@router.get("/stocks/{symbol}/quotes")
def stock_quotes(symbol: str, limit: int | None = Query(None, ge=1, le=1000)) -> dict:
    """Latest quote by default; pass ``limit`` to get the recent IEX quote history."""
    symbol = _symbol_or_422(symbol)
    if limit is not None:
        return quote_history(symbol, limit)
    try:
        return latest_quotes_for([symbol]).get(symbol, {})
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None


# ---------------------------------------------------------------------------
# Historical ticks & quotes (IEX only: real-time SIP is not on this plan)
# ---------------------------------------------------------------------------


@router.get("/stocks/{symbol}/trades")
def stock_trades(symbol: str, limit: int = Query(100, ge=1, le=1000)) -> dict:
    symbol = _symbol_or_422(symbol)

    def load() -> dict:
        raw = data_get("/v2/stocks/trades", {
            "symbols": symbol,
            "feed": "iex",
            "limit": limit,
            "sort": "desc",
        })
        rows = []
        for item in (raw.get("trades") or {}).get(symbol, []):
            rows.append({
                "id": as_int(item.get("i")),
                "time": iso(item.get("t")),
                "price": as_float(item.get("p")),
                "size": as_int(item.get("s")),
                "exchange": item.get("x"),
                "tape": item.get("z"),
                "conditions": item.get("c") or [],
            })
        return {
            "symbol": symbol,
            "feed": "iex",
            "feed_label": "IEX 逐笔（非 consolidated SIP，可能不完整）",
            "trades": rows,
            "count": len(rows),
        }

    try:
        return cache.get_or_set(f"trades:{symbol}:{limit}", 30, load, stale_ttl=300)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "feed": "iex", "trades": [], "count": 0, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


def quote_history(symbol: str, limit: int = 100) -> dict:
    def load() -> dict:
        raw = data_get("/v2/stocks/quotes", {
            "symbols": symbol,
            "feed": "iex",
            "limit": limit,
            "sort": "desc",
        })
        rows = []
        for item in (raw.get("quotes") or {}).get(symbol, []):
            rows.append({
                "time": iso(item.get("t")),
                "bid": as_float(item.get("bp")),
                "ask": as_float(item.get("ap")),
                "bid_size": as_int(item.get("bs")),
                "ask_size": as_int(item.get("as")),
                "exchange": item.get("bx"),
                "ask_exchange": item.get("ax"),
                "tape": item.get("z"),
                "conditions": item.get("c") or [],
            })
        return {
            "symbol": symbol,
            "feed": "iex",
            "feed_label": "IEX 历史报价（非 consolidated SIP，可能不完整）",
            "quotes": rows,
            "count": len(rows),
        }

    try:
        return cache.get_or_set(f"quotes:history:{symbol}:{limit}", 30, load, stale_ttl=300)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "feed": "iex", "quotes": [], "count": 0, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


# ---------------------------------------------------------------------------
# Reference metadata: condition codes & exchange codes
# ---------------------------------------------------------------------------


@router.get("/market/meta/conditions")
def market_meta_conditions(
    ticktype: Literal["trade", "quote"] = Query("trade"),
    tape: Literal["A", "B", "C"] = Query("C"),
) -> dict:
    def load() -> dict:
        raw = data_get(f"/v2/stocks/meta/conditions/{ticktype}", {"tape": tape})
        items = [
            {"code": code, "name": name}
            for code, name in (raw or {}).items()
            if code
        ]
        items.sort(key=lambda item: item["code"])
        return {"ticktype": ticktype, "tape": tape, "items": items, "count": len(items)}

    try:
        return cache.get_or_set(f"meta:conditions:{ticktype}:{tape}", 12 * 3600, load, stale_ttl=48 * 3600)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"ticktype": ticktype, "tape": tape, "items": [], "count": 0, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/market/meta/exchanges")
def market_meta_exchanges() -> dict:
    def load() -> dict:
        raw = data_get("/v2/stocks/meta/exchanges")
        items = [
            {"code": code, "name": name}
            for code, name in (raw or {}).items()
            if code
        ]
        items.sort(key=lambda item: item["code"])
        return {"items": items, "count": len(items)}

    try:
        return cache.get_or_set("meta:exchanges", 12 * 3600, load, stale_ttl=48 * 3600)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"items": [], "count": 0, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None
