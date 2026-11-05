"""Thin Alpaca REST client and response normalizers.

The app talks to Alpaca's REST API directly so it can use endpoints the Python SDK
does not wrap (screener, options snapshots, corporate actions, portfolio history).
Credentials never leave the server process.
"""
from __future__ import annotations

import html
import logging
import re
import time
from datetime import date, datetime, timezone
from typing import Any, Iterable

import requests

from .cache import cache
from .config import DATA_BASE, DATA_FEED, PAPER_BASE, credentials, headers, valid_symbol

log = logging.getLogger("minitrade.alpaca")
_session = requests.Session()
_session.headers.update({"User-Agent": "MiniTrade/2.0 (learning project)"})
_adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=0)
_session.mount("https://", _adapter)


class UpstreamError(RuntimeError):
    def __init__(self, status: int, message: str, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


_ERRORS = {
    401: "Alpaca 拒绝了当前密钥，请检查 .env 中的模拟账户配置。",
    403: "当前 Alpaca 订阅不包含这项数据或功能。",
    404: "Alpaca 没有找到对应的数据。",
    422: "Alpaca 无法处理这个请求，请检查参数。",
    429: "请求过于频繁，请稍后再试。",
}


def _url(base: str, path: str) -> str:
    return f"{base}{path}"


def request(
    method: str,
    base: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 20,
) -> Any:
    """Call Alpaca, retry transient failures once, and raise sanitized errors."""
    credentials()  # fail fast with a clear local message when keys are missing
    url = _url(base, path)
    clean_params = {k: v for k, v in (params or {}).items() if v is not None}
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            response = _session.request(
                method,
                url,
                params=clean_params,
                json=payload,
                headers=headers(),
                timeout=timeout,
            )
        except requests.RequestException as exc:
            last_exc = exc
            if attempt == 0:
                time.sleep(0.3)
                continue
            raise UpstreamError(502, "无法连接 Alpaca 服务，请检查网络。", "network") from None

        if response.status_code < 400:
            if not response.content:
                return {}
            try:
                return response.json()
            except ValueError:
                raise UpstreamError(502, "Alpaca 返回了无法解析的数据。", "bad_json") from None

        if response.status_code in (429, 500, 502, 503, 504) and attempt == 0:
            time.sleep(0.5)
            continue

        message = _ERRORS.get(response.status_code, "Alpaca 服务暂时不可用，请稍后再试。")
        upstream_message = None
        try:
            body = response.json()
            upstream_message = body.get("message") if isinstance(body, dict) else None
        except ValueError:
            upstream_message = None
        if response.status_code in (400, 422) and upstream_message:
            message = f"请求未通过 Alpaca 校验：{str(upstream_message)[:220]}"
        log.warning("Alpaca %s %s -> %s", method, path, response.status_code)
        raise UpstreamError(response.status_code, message, f"http_{response.status_code}")

    raise UpstreamError(502, "无法连接 Alpaca 服务，请检查网络。", "network") from last_exc


def data_get(path: str, params: dict[str, Any] | None = None, *, timeout: float = 20) -> Any:
    return request("GET", DATA_BASE, path, params=params, timeout=timeout)


def trading_get(path: str, params: dict[str, Any] | None = None) -> Any:
    return request("GET", PAPER_BASE, path, params=params)


def trading_send(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    return request(method, PAPER_BASE, path, payload=payload)


# ---------------------------------------------------------------------------
# Normalizers
# ---------------------------------------------------------------------------


def as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def as_int(value: Any) -> int | None:
    number = as_float(value)
    return int(number) if number is not None else None


def iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _et_date(timestamp: Any) -> date | None:
    if not timestamp:
        return None
    try:
        text = str(timestamp).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        from .config import ET

        return parsed.astimezone(ET).date()
    except (ValueError, TypeError):
        return None


def normalize_asset(asset: dict) -> dict:
    attributes = asset.get("attributes") or []
    return {
        "symbol": asset.get("symbol"),
        "name": asset.get("name") or asset.get("symbol"),
        "exchange": asset.get("exchange") or "—",
        "asset_class": asset.get("class") or "us_equity",
        "status": asset.get("status"),
        "tradable": bool(asset.get("tradable")),
        "marginable": bool(asset.get("marginable")),
        "shortable": bool(asset.get("shortable")),
        "easy_to_borrow": bool(asset.get("easy_to_borrow")),
        "fractionable": bool(asset.get("fractionable")),
        "attributes": attributes,
        "has_options": "has_options" in attributes,
        "fractional_eh": "fractional_eh_enabled" in attributes,
        "logo_url": f"/api/stocks/{asset.get('symbol')}/logo",
    }


def normalize_snapshot(symbol: str, raw: dict, asset: dict | None = None) -> dict:
    daily = raw.get("dailyBar") or {}
    previous = raw.get("prevDailyBar") or {}
    trade = raw.get("latestTrade") or {}
    quote = raw.get("latestQuote") or {}
    minute = raw.get("minuteBar") or {}

    price = as_float(trade.get("p"))
    if price is None:
        price = as_float(minute.get("c"))
    if price is None:
        price = as_float(daily.get("c"))

    daily_date = _et_date(daily.get("t"))
    from .config import ET

    today = datetime.now(ET).date()
    # Before/after a session the daily bar is the last completed session; intraday it is today.
    # Before/after a session the daily bar is the last completed session; intraday it is today.
    if daily_date and daily_date < today:
        prev_close = as_float(daily.get("c")) or as_float(previous.get("c"))
    elif daily_date == today:
        prev_close = as_float(previous.get("c"))
    else:
        prev_close = as_float(previous.get("c")) or as_float(daily.get("c"))
    change = price - prev_close if price is not None and prev_close is not None else None
    change_pct = change / prev_close if change is not None and prev_close else None

    bid = as_float(quote.get("bp"))
    ask = as_float(quote.get("ap"))
    spread = ask - bid if bid is not None and ask is not None else None

    result = {
        "symbol": symbol,
        "name": (asset or {}).get("name") or symbol,
        "price": price,
        "previous_close": prev_close,
        "change": change,
        "change_pct": change_pct,
        "open": as_float(daily.get("o")),
        "high": as_float(daily.get("h")),
        "low": as_float(daily.get("l")),
        "close": as_float(daily.get("c")),
        "volume": as_int(daily.get("v")),
        "trade_count": as_int(daily.get("n")),
        "vwap": as_float(daily.get("vw")),
        "day_ts": iso(daily.get("t")),
        "day_is_today": bool(daily_date and daily_date == today),
        "bid": bid,
        "ask": ask,
        "bid_size": as_int(quote.get("bs")),
        "ask_size": as_int(quote.get("as")),
        "bid_exchange": quote.get("bx"),
        "ask_exchange": quote.get("ax"),
        "spread": spread,
        "quote_ts": iso(quote.get("t")),
        "trade_ts": iso(trade.get("t")),
        "trade_size": as_int(trade.get("s")),
        "trade_exchange": trade.get("x"),
        "minute": normalize_bar(minute, symbol=symbol) if minute else None,
        "feed": DATA_FEED,
        "feed_label": "SIP 综合行情（约延迟 15 分钟）",
        "logo_url": f"/api/stocks/{symbol}/logo",
    }
    if asset:
        for key in ("exchange", "tradable", "fractionable", "shortable", "marginable", "has_options", "asset_class"):
            result[key] = asset.get(key)
    return result


def normalize_bar(bar: dict, *, symbol: str | None = None) -> dict:
    item = {
        "time": iso(bar.get("t")),
        "open": as_float(bar.get("o")),
        "high": as_float(bar.get("h")),
        "low": as_float(bar.get("l")),
        "close": as_float(bar.get("c")),
        "volume": as_int(bar.get("v")) or 0,
        "vwap": as_float(bar.get("vw")),
        "trades": as_int(bar.get("n")),
    }
    if symbol:
        item["symbol"] = symbol
    return item


def normalize_news(item: dict, *, include_content: bool = False) -> dict:
    content = item.get("content") or ""
    if content:
        content = re.sub(r"(?is)<(script|style).*?</\1>", " ", content)
        content = re.sub(r"(?i)<br\s*/?>|</p>|</div>", "\n", content)
        content = re.sub(r"<[^>]+>", " ", content)
        content = html.unescape(content)
        content = re.sub(r"[ \t]+", " ", content)
        content = re.sub(r"\n\s*\n+", "\n\n", content).strip()
    images = item.get("images") or []
    return {
        "id": item.get("id"),
        "headline": html.unescape(item.get("headline") or ""),
        "summary": html.unescape(item.get("summary") or ""),
        "content": content if include_content else None,
        "source": item.get("source") or "Alpaca",
        "author": item.get("author") or "",
        "url": item.get("url"),
        "created_at": iso(item.get("created_at")),
        "updated_at": iso(item.get("updated_at")),
        "symbols": item.get("symbols") or [],
        "images": images,
        "image": (images[0].get("url") if images else None),
    }


def normalize_order(order: dict) -> dict:
    legs = [normalize_order(leg) for leg in (order.get("legs") or [])]
    return {
        "id": order.get("id"),
        "client_order_id": order.get("client_order_id"),
        "symbol": order.get("symbol"),
        "asset_class": order.get("asset_class"),
        "side": order.get("side"),
        "type": order.get("type"),
        "order_class": order.get("order_class"),
        "qty": as_float(order.get("qty")),
        "notional": as_float(order.get("notional")),
        "filled_qty": as_float(order.get("filled_qty")) or 0.0,
        "filled_avg_price": as_float(order.get("filled_avg_price")),
        "limit_price": as_float(order.get("limit_price")),
        "stop_price": as_float(order.get("stop_price")),
        "trail_price": as_float(order.get("trail_price")),
        "trail_percent": as_float(order.get("trail_percent")),
        "time_in_force": order.get("time_in_force"),
        "extended_hours": bool(order.get("extended_hours")),
        "status": order.get("status"),
        "created_at": iso(order.get("created_at")),
        "submitted_at": iso(order.get("submitted_at")),
        "updated_at": iso(order.get("updated_at")),
        "filled_at": iso(order.get("filled_at")),
        "canceled_at": iso(order.get("canceled_at")),
        "expires_at": iso(order.get("expires_at")),
        "replaced_by": order.get("replaced_by"),
        "replaces": order.get("replaces"),
        "legs": legs,
        "position_intent": order.get("position_intent"),
    }


def normalize_position(position: dict) -> dict:
    qty = as_float(position.get("qty")) or 0.0
    return {
        "symbol": position.get("symbol"),
        "asset_id": position.get("asset_id"),
        "exchange": position.get("exchange"),
        "asset_class": position.get("asset_class"),
        "side": position.get("side") or ("long" if qty >= 0 else "short"),
        "qty": qty,
        "qty_available": as_float(position.get("qty_available")),
        "avg_entry_price": as_float(position.get("avg_entry_price")),
        "current_price": as_float(position.get("current_price")),
        "market_value": as_float(position.get("market_value")),
        "cost_basis": as_float(position.get("cost_basis")),
        "unrealized_pl": as_float(position.get("unrealized_pl")),
        "unrealized_plpc": as_float(position.get("unrealized_plpc")),
        "unrealized_intraday_pl": as_float(position.get("unrealized_intraday_pl")),
        "unrealized_intraday_plpc": as_float(position.get("unrealized_intraday_plpc")),
        "change_today": as_float(position.get("change_today")),
        "lastday_price": as_float(position.get("lastday_price")),
        "logo_url": f"/api/stocks/{position.get('symbol')}/logo",
    }


def normalize_account(account: dict) -> dict:
    equity = as_float(account.get("equity"))
    last_equity = as_float(account.get("last_equity"))
    day_pl = equity - last_equity if equity is not None and last_equity else None
    day_pl_pct = day_pl / last_equity if day_pl is not None and last_equity else None
    return {
        "id": account.get("id"),
        "account_number": account.get("account_number"),
        "status": account.get("status"),
        "currency": account.get("currency") or "USD",
        "cash": as_float(account.get("cash")),
        "equity": equity,
        "last_equity": last_equity,
        "portfolio_value": as_float(account.get("portfolio_value")),
        "buying_power": as_float(account.get("buying_power")),
        "regt_buying_power": as_float(account.get("regt_buying_power")),
        "effective_buying_power": as_float(account.get("effective_buying_power")),
        "non_marginable_buying_power": as_float(account.get("non_marginable_buying_power")),
        "options_buying_power": as_float(account.get("options_buying_power")),
        "long_market_value": as_float(account.get("long_market_value")),
        "short_market_value": as_float(account.get("short_market_value")),
        "initial_margin": as_float(account.get("initial_margin")),
        "maintenance_margin": as_float(account.get("maintenance_margin")),
        "multiplier": as_float(account.get("multiplier")),
        "daytrade_count": account.get("daytrade_count"),
        "pattern_day_trader": bool(account.get("pattern_day_trader")),
        "shorting_enabled": bool(account.get("shorting_enabled")),
        "trading_blocked": bool(account.get("trading_blocked")),
        "account_blocked": bool(account.get("account_blocked")),
        "transfers_blocked": bool(account.get("transfers_blocked")),
        "crypto_status": account.get("crypto_status"),
        "options_trading_level": account.get("options_trading_level"),
        "options_approved_level": account.get("options_approved_level"),
        "created_at": iso(account.get("created_at")),
        "day_pl": day_pl,
        "day_pl_pct": day_pl_pct,
        "sma": as_float(account.get("sma")),
        "accrued_fees": as_float(account.get("accrued_fees")),
    }


# ---------------------------------------------------------------------------
# Assets & search
# ---------------------------------------------------------------------------


def all_assets() -> list[dict]:
    def load() -> list[dict]:
        rows = trading_get("/v2/assets", {"status": "active", "asset_class": "us_equity"})
        return [normalize_asset(row) for row in rows if row.get("tradable")]

    return cache.get_or_set("assets:all", 6 * 3600, load, stale_ttl=24 * 3600)


def asset_lookup() -> dict[str, dict]:
    def load() -> dict[str, dict]:
        return {item["symbol"]: item for item in all_assets()}

    return cache.get_or_set("assets:map", 6 * 3600, load, stale_ttl=24 * 3600)


def get_asset(symbol: str) -> dict | None:
    symbol = symbol.upper()
    found = asset_lookup().get(symbol)
    if found:
        return found
    if not valid_symbol(symbol):
        return None
    try:
        raw = trading_get(f"/v2/assets/{symbol}")
    except UpstreamError as exc:
        if exc.status == 404:
            return None
        raise
    return normalize_asset(raw)


_EXCHANGE_RANK = {"NYSE": 0, "NASDAQ": 0, "AMEX": 1, "ARCA": 2, "BATS": 2, "OTC": 4}


def search_assets(query: str, limit: int = 12) -> list[dict]:
    needle = query.strip().lower()
    if not needle:
        return []
    ranked: list[tuple[int, int, str, dict]] = []
    for asset in all_assets():
        symbol = asset["symbol"].lower()
        name = (asset["name"] or "").lower()
        if symbol == needle:
            rank = 0
        elif symbol.startswith(needle):
            rank = 1
        elif name.startswith(needle):
            rank = 2
        elif needle in symbol:
            rank = 3
        elif needle in name:
            rank = 4
        else:
            continue
        ranked.append((rank, _EXCHANGE_RANK.get(asset["exchange"], 3), asset["symbol"], asset))
    ranked.sort(key=lambda entry: (entry[0], entry[1], len(entry[2]), entry[2]))
    selected = [entry[3] for entry in ranked[:limit]]

    snapshots: dict[str, dict] = {}
    if selected:
        try:
            snapshots = snapshots_for([item["symbol"] for item in selected])
        except UpstreamError:
            snapshots = {}
    results = []
    for asset in selected:
        item = dict(asset)
        snapshot = snapshots.get(asset["symbol"])
        if snapshot:
            item.update({
                "price": snapshot["price"],
                "change": snapshot["change"],
                "change_pct": snapshot["change_pct"],
                "previous_close": snapshot["previous_close"],
                "volume": snapshot["volume"],
            })
        results.append(item)
    return results


def snapshots_for(symbols: Iterable[str]) -> dict[str, dict]:
    unique = sorted({symbol.upper() for symbol in symbols if symbol})
    if not unique:
        return {}
    key = "snapshots:" + ",".join(unique)

    def load() -> dict[str, dict]:
        raw = data_get("/v2/stocks/snapshots", {"symbols": ",".join(unique), "feed": DATA_FEED})
        assets = asset_lookup()
        return {symbol: normalize_snapshot(symbol, data, assets.get(symbol)) for symbol, data in raw.items()}

    return cache.get_or_set(key, 5, load, stale_ttl=120)


def latest_quotes_for(symbols: Iterable[str]) -> dict[str, dict]:
    unique = sorted({symbol.upper() for symbol in symbols if symbol})
    if not unique:
        return {}
    raw = data_get("/v2/stocks/quotes/latest", {"symbols": ",".join(unique), "feed": DATA_FEED})
    quotes = raw.get("quotes", {})
    return {
        symbol: {
            "bid": as_float(quote.get("bp")),
            "ask": as_float(quote.get("ap")),
            "bid_size": as_int(quote.get("bs")),
            "ask_size": as_int(quote.get("as")),
            "quote_ts": iso(quote.get("t")),
        }
        for symbol, quote in quotes.items()
    }
