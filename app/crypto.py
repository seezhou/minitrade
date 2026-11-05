"""Crypto market data and paper-trading routes."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .alpaca_api import data_get, iso, normalize_bar, normalize_order, normalize_position, trading_get, trading_send
from .alpaca_api import UpstreamError, as_float
from .cache import cache

router = APIRouter(prefix="/api")
log = logging.getLogger("minitrade.crypto")

CRYPTO_SYMBOLS = [
    "BTC/USD",
    "ETH/USD",
    "SOL/USD",
    "AVAX/USD",
    "DOGE/USD",
    "LINK/USD",
    "LTC/USD",
    "BCH/USD",
    "UNI/USD",
    "AAVE/USD",
]
CRYPTO_NAMES = {
    "BTC/USD": "比特币",
    "ETH/USD": "以太坊",
    "SOL/USD": "Solana",
    "AVAX/USD": "Avalanche",
    "DOGE/USD": "Dogecoin",
    "LINK/USD": "Chainlink",
    "LTC/USD": "Litecoin",
    "BCH/USD": "Bitcoin Cash",
    "UNI/USD": "Uniswap",
    "AAVE/USD": "Aave",
}
# (timeframe, lookback days). Alpaca crypto bars default to *today only* when no
# start is sent, so the window must be explicit; the endpoint also paginates well
# below any requested limit, so page through until next_page_token is empty.
RANGES = {
    "1D": ("5Min", 1),
    "1W": ("15Min", 7),
    "1M": ("1Hour", 30),
    "3M": ("1Day", 90),
    "6M": ("1Day", 180),
    "1Y": ("1Day", 365),
}


def _crypto_or_422(symbol: str) -> str:
    value = (symbol or "").strip().upper()
    if value not in CRYPTO_SYMBOLS:
        raise HTTPException(status_code=422, detail="暂不支持这个加密交易对。")
    return value


def _upstream_http(exc: UpstreamError) -> HTTPException:
    code = 422 if exc.status in (400, 422) else 502
    return HTTPException(status_code=code, detail=exc.message)


def _paged_crypto_bars(symbol: str, timeframe: str, start: str, max_pages: int = 8) -> list[dict]:
    """Crypto bars page by a server-side window far below `limit` (~7 days of bars).

    Without paging, long ranges silently return only the oldest page, which looks
    like "1Y shows one day" in the UI. Merge pages and sort ascending by time.
    """
    merged: dict[str, dict] = {}
    token: str | None = None
    for _ in range(max_pages):
        params: dict = {
            "symbols": symbol,
            "timeframe": timeframe,
            "start": start,
            "limit": 10000,
        }
        if token:
            params["page_token"] = token
        raw = data_get("/v1beta3/crypto/us/bars", params, timeout=20)
        for item in (raw.get("bars") or {}).get(symbol) or []:
            merged.setdefault(item.get("t"), item)
        token = raw.get("next_page_token")
        if not token:
            break
    if token:
        log.warning("crypto bars paging stopped at max_pages for %s %s", symbol, timeframe)
    return [merged[stamp] for stamp in sorted(merged, key=lambda value: value or "")]


def _snapshot_row(symbol: str, item: dict) -> dict:
    trade = item.get("latestTrade") or {}
    quote = item.get("latestQuote") or {}
    daily = item.get("dailyBar") or {}
    previous = item.get("prevDailyBar") or {}
    price = as_float(trade.get("p"))
    if price is None:
        price = as_float(daily.get("c"))
    prev_close = as_float(previous.get("c"))
    if prev_close is None:
        prev_close = as_float(daily.get("o"))
    change = price - prev_close if price is not None and prev_close else None
    bid = as_float(quote.get("bp"))
    ask = as_float(quote.get("ap"))
    return {
        "symbol": symbol,
        "name": CRYPTO_NAMES.get(symbol, symbol),
        "price": price,
        "previous_close": prev_close,
        "change": change,
        "change_pct": change / prev_close if change is not None and prev_close else None,
        "bid": bid,
        "ask": ask,
        "spread": ask - bid if bid is not None and ask is not None else None,
        "open": as_float(daily.get("o")),
        "high": as_float(daily.get("h")),
        "low": as_float(daily.get("l")),
        "close": as_float(daily.get("c")),
        "volume": as_float(daily.get("v")),
        "trade_ts": iso(trade.get("t")),
        "quote_ts": iso(quote.get("t")),
    }


@router.get("/crypto/markets")
def crypto_markets() -> list[dict]:
    def load() -> list[dict]:
        raw = data_get("/v1beta3/crypto/us/snapshots", {"symbols": ",".join(CRYPTO_SYMBOLS)})
        snapshots = raw.get("snapshots") or {}
        return [_snapshot_row(symbol, snapshots[symbol]) for symbol in CRYPTO_SYMBOLS if symbol in snapshots]

    try:
        return cache.get_or_set("crypto:markets", 20, load, stale_ttl=300)
    except UpstreamError as exc:
        raise _upstream_http(exc) from None


@router.get("/crypto/snapshot")
def crypto_snapshot(symbol: str = Query(..., min_length=3, max_length=20)) -> dict:
    symbol = _crypto_or_422(symbol)

    def load() -> dict:
        raw = data_get("/v1beta3/crypto/us/snapshots", {"symbols": symbol})
        item = (raw.get("snapshots") or {}).get(symbol)
        if not item:
            raise HTTPException(status_code=404, detail="没有找到这个交易对的快照。")
        return _snapshot_row(symbol, item)

    try:
        return cache.get_or_set(f"crypto:snapshot:{symbol}", 15, load, stale_ttl=120)
    except UpstreamError as exc:
        raise _upstream_http(exc) from None


@router.get("/crypto/bars")
def crypto_bars(
    symbol: str = Query(..., min_length=3, max_length=20),
    range: str = Query("1D", alias="range"),
) -> dict:
    symbol = _crypto_or_422(symbol)
    key = range.upper()
    if key not in RANGES:
        raise HTTPException(status_code=422, detail="不支持的加密时间区间。")
    timeframe, days = RANGES[key]
    start = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")

    def load() -> dict:
        raw_rows = _paged_crypto_bars(symbol, timeframe, start)
        rows = []
        for item in raw_rows:
            row = normalize_bar(item, symbol=symbol)
            row["volume"] = as_float(item.get("v")) or 0
            rows.append(row)
        return {
            "symbol": symbol,
            "range": key,
            "timeframe": timeframe,
            "start": start,
            "bars": rows,
        }

    ttl = 20 if key == "1D" else 120
    try:
        return cache.get_or_set(f"crypto:bars:{symbol}:{key}", ttl, load, stale_ttl=600)
    except UpstreamError as exc:
        raise _upstream_http(exc) from None


class CryptoOrderInput(BaseModel):
    symbol: str = Field(min_length=3, max_length=20)
    side: Literal["buy", "sell"]
    order_type: Literal["market", "limit", "stop_limit"] = "market"
    qty: float | None = Field(default=None, gt=0, le=1_000_000_000)
    notional: float | None = Field(default=None, gt=0, le=10_000_000)
    limit_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    time_in_force: Literal["gtc", "ioc"] = "gtc"


@router.post("/crypto/orders", status_code=201)
def create_crypto_order(payload: CryptoOrderInput) -> dict:
    symbol = _crypto_or_422(payload.symbol)
    if (payload.qty is None) == (payload.notional is None):
        raise HTTPException(status_code=422, detail="数量和金额只能填写一个。")
    if payload.order_type in ("limit", "stop_limit") and payload.limit_price is None:
        raise HTTPException(status_code=422, detail="限价单需要填写限价。")
    if payload.order_type == "stop_limit" and payload.stop_price is None:
        raise HTTPException(status_code=422, detail="止损限价单需要填写触发价。")
    if payload.order_type == "market" and (payload.limit_price or payload.stop_price):
        raise HTTPException(status_code=422, detail="市价单不应包含限价或触发价。")
    if payload.notional is not None and payload.notional <= 10:
        raise HTTPException(status_code=422, detail="加密订单最低金额需高于 $10。")
    if payload.qty is not None and payload.limit_price is not None and payload.qty * payload.limit_price <= 10:
        raise HTTPException(status_code=422, detail="加密订单最低金额需高于 $10（数量 × 限价）。")
    if payload.qty is not None and payload.limit_price is None:
        try:
            market_price = crypto_snapshot(symbol).get("price")
        except Exception:
            market_price = None
        if market_price and payload.qty * market_price <= 10:
            raise HTTPException(status_code=422, detail="加密订单最低金额需高于 $10（按最新价估算）。")

    body: dict = {
        "symbol": symbol,
        "side": payload.side,
        "type": payload.order_type,
        "time_in_force": payload.time_in_force,
    }
    if payload.qty is not None:
        body["qty"] = f"{payload.qty:g}"
    else:
        body["notional"] = f"{payload.notional:.2f}"
    if payload.limit_price is not None:
        body["limit_price"] = f"{payload.limit_price:g}"
    if payload.stop_price is not None:
        body["stop_price"] = f"{payload.stop_price:g}"

    try:
        raw = trading_send("POST", "/v2/orders", body)
    except UpstreamError as exc:
        raise _upstream_http(exc) from None
    return normalize_order(raw)


@router.get("/crypto/positions")
def crypto_positions() -> list[dict]:
    try:
        rows = trading_get("/v2/positions")
    except UpstreamError as exc:
        raise _upstream_http(exc) from None
    return [
        normalize_position(item)
        for item in rows
        if item.get("asset_class") == "crypto" or "/" in (item.get("symbol") or "")
    ]


@router.delete("/crypto/positions")
def close_crypto_position(symbol: str = Query(..., min_length=3, max_length=20)) -> dict:
    symbol = _crypto_or_422(symbol)
    from urllib.parse import quote

    try:
        trading_send("DELETE", f"/v2/positions/{quote(symbol, safe='')}")
    except UpstreamError as exc:
        raise _upstream_http(exc) from None
    return {"closed": True, "symbol": symbol}
