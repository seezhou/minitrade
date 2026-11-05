"""Paper trading routes: account, positions, orders, activities and watchlists."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .alpaca_api import (
    UpstreamError,
    as_float,
    asset_lookup,
    iso,
    normalize_account,
    normalize_asset,
    normalize_order,
    normalize_position,
    trading_get,
    trading_send,
)
from .cache import cache
from .config import valid_symbol

log = logging.getLogger("minitrade.trading")
router = APIRouter(prefix="/api")

OPEN_STATUSES = {
    "new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding",
    "pending_cancel", "pending_replace", "held", "calculated", "stopped",
}


def _handle_error(exc: UpstreamError) -> HTTPException:
    status = 422 if exc.status in (400, 422) else 502
    return HTTPException(status_code=status, detail=exc.message)


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------


@router.get("/account")
def account() -> dict:
    try:
        return normalize_account(trading_get("/v2/account"))
    except UpstreamError as exc:
        raise _handle_error(exc) from None


def _config_payload(raw: dict) -> dict:
    return {
        "raw": raw,
        "fractional_trading": bool(raw.get("fractional_trading")),
        "max_margin_multiplier": as_float(raw.get("max_margin_multiplier")),
        "no_shorting": bool(raw.get("no_shorting")),
        "suspend_trade": bool(raw.get("suspend_trade")),
        "disable_overnight_trading": bool(raw.get("disable_overnight_trading")),
        "ptp_no_exception_entry": bool(raw.get("ptp_no_exception_entry")),
    }


@router.get("/account/config")
def account_config() -> dict:
    try:
        return _config_payload(trading_get("/v2/account/configurations"))
    except UpstreamError as exc:
        raise _handle_error(exc) from None


class AccountConfigInput(BaseModel):
    """Only the fields Alpaca documents as writable on the paper account."""

    no_shorting: bool | None = None
    fractional_trading: bool | None = None
    max_margin_multiplier: int | None = Field(default=None, ge=1, le=4)
    suspend_trade: bool | None = None
    disable_overnight_trading: bool | None = None
    ptp_no_exception_entry: bool | None = None


@router.patch("/account/config")
def update_account_config(payload: AccountConfigInput) -> dict:
    body: dict = {}
    for key, value in payload.model_dump(exclude_none=True).items():
        if key in ("no_shorting", "fractional_trading", "suspend_trade", "disable_overnight_trading", "ptp_no_exception_entry"):
            body[key] = bool(value)
        elif key == "max_margin_multiplier":
            body[key] = str(int(value))
    if not body:
        raise HTTPException(status_code=422, detail="没有提供需要修改的配置字段。")
    try:
        raw = trading_send("PATCH", "/v2/account/configurations", body)
    except UpstreamError as exc:
        raise _handle_error(exc) from None
    return _config_payload(raw)


@router.get("/account/history")
def portfolio_history(period: str = Query("1M")) -> dict:
    key = period.upper()
    settings = {
        "1D": ("1D", "5Min"),
        "1W": ("1W", "15Min"),
        "1M": ("1M", "1D"),
        "3M": ("3M", "1D"),
        "1Y": ("1A", "1D"),
        "ALL": ("all", "1D"),
    }
    if key not in settings:
        raise HTTPException(status_code=422, detail="不支持的时间区间。")
    alpaca_period, timeframe = settings[key]

    def load() -> dict:
        raw = trading_get("/v2/account/portfolio/history", {
            "period": alpaca_period,
            "timeframe": timeframe,
            "extended_hours": "true",
        })
        stamps = raw.get("timestamp") or []
        equity = raw.get("equity") or []
        profit_loss = raw.get("profit_loss") or []
        profit_loss_pct = raw.get("profit_loss_pct") or []
        points = []
        for index, stamp in enumerate(stamps):
            value = equity[index] if index < len(equity) else None
            if value is None or as_float(value) is None or (as_float(value) or 0) <= 0:
                continue
            points.append({
                "time": datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat(),
                "equity": as_float(value),
                "profit_loss": as_float(profit_loss[index]) if index < len(profit_loss) else None,
                "profit_loss_pct": as_float(profit_loss_pct[index]) if index < len(profit_loss_pct) else None,
            })
        return {
            "period": key,
            "timeframe": timeframe,
            "points": points,
            "base_value": as_float(raw.get("base_value")),
            "base_value_asof": raw.get("base_value_asof"),
            "current_equity": points[-1]["equity"] if points else None,
        }

    try:
        return cache.get_or_set(f"history:{key}", 45, load, stale_ttl=600)
    except UpstreamError as exc:
        raise _handle_error(exc) from None


# ---------------------------------------------------------------------------
# Positions
# ---------------------------------------------------------------------------


@router.get("/positions")
def positions() -> list[dict]:
    try:
        raw = trading_get("/v2/positions")
    except UpstreamError as exc:
        raise _handle_error(exc) from None
    assets = asset_lookup()
    results = []
    for item in raw:
        normalized = normalize_position(item)
        asset = assets.get(normalized["symbol"] or "")
        if asset:
            normalized["name"] = asset["name"]
        results.append(normalized)
    return results


@router.delete("/positions/{symbol}")
def close_position(symbol: str, percentage: float | None = Query(None, gt=0, le=100)) -> dict:
    symbol = symbol.upper()
    if not valid_symbol(symbol):
        raise HTTPException(status_code=422, detail="无效的股票代码。")
    try:
        raw = trading_send("DELETE", f"/v2/positions/{symbol}" + (f"?percentage={percentage}" if percentage else ""))
        return normalize_order(raw) if isinstance(raw, dict) and raw.get("id") else {"closed": True, "symbol": symbol}
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.delete("/positions")
def close_all_positions(cancel_orders: bool = True) -> dict:
    try:
        raw = trading_send("DELETE", f"/v2/positions?cancel_orders={'true' if cancel_orders else 'false'}")
        return {"closed": True, "orders": raw if isinstance(raw, list) else []}
    except UpstreamError as exc:
        raise _handle_error(exc) from None


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------


@router.get("/orders")
def orders(
    status: Literal["open", "closed", "all"] = "all",
    limit: int = Query(100, ge=1, le=500),
    symbol: str | None = None,
) -> list[dict]:
    params = {
        "status": status,
        "limit": limit,
        "direction": "desc",
        "nested": "true",
        "symbols": symbol.upper() if symbol else None,
    }
    try:
        raw = trading_get("/v2/orders", params)
    except UpstreamError as exc:
        raise _handle_error(exc) from None
    results = []
    for item in raw:
        normalized = normalize_order(item)
        normalized["is_open"] = normalized["status"] in OPEN_STATUSES
        remaining = (normalized["qty"] or 0) - (normalized["filled_qty"] or 0)
        normalized["remaining_qty"] = max(0.0, remaining) if normalized["qty"] else None
        results.append(normalized)
    return results


@router.get("/orders/{order_id}")
def order_detail(order_id: str) -> dict:
    try:
        return normalize_order(trading_get(f"/v2/orders/{order_id}", {"nested": "true"}))
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.get("/orders/by-client-id/{client_order_id}")
def order_by_client_id(client_order_id: str) -> dict:
    if not 1 <= len(client_order_id) <= 48:
        raise HTTPException(status_code=422, detail="client order id 长度应为 1–48 个字符。")
    try:
        raw = trading_get("/v2/orders:by_client_order_id", {"client_order_id": client_order_id})
    except UpstreamError as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail=f"没有找到 client order id 为 {client_order_id} 的订单。") from None
        raise _handle_error(exc) from None
    normalized = normalize_order(raw)
    normalized["is_open"] = normalized["status"] in OPEN_STATUSES
    return normalized


class OrderInput(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)
    side: Literal["buy", "sell"]
    order_type: Literal["market", "limit", "stop", "stop_limit", "trailing_stop"] = "market"
    qty: float | None = Field(default=None, gt=0, le=1_000_000, allow_inf_nan=False)
    notional: float | None = Field(default=None, gt=0, le=10_000_000, allow_inf_nan=False)
    limit_price: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    stop_price: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    trail_price: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    trail_percent: float | None = Field(default=None, gt=0, le=100, allow_inf_nan=False)
    time_in_force: Literal["day", "gtc", "opg", "cls", "ioc", "fok"] = "day"
    extended_hours: bool = False
    order_class: Literal["simple", "bracket", "oco", "oto"] = "simple"
    take_profit: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    stop_loss: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    stop_loss_limit: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    client_order_id: str | None = Field(default=None, min_length=1, max_length=48)
    allow_short: bool = False


def _validate_order(payload: OrderInput) -> str:
    symbol = payload.symbol.strip().upper()
    if not valid_symbol(symbol):
        raise HTTPException(status_code=422, detail="请输入有效的股票代码。")
    if (payload.qty is None) == (payload.notional is None):
        raise HTTPException(status_code=422, detail="数量（股数）和金额必须且只能填写一个。")

    if payload.qty is not None:
        fractional = not float(payload.qty).is_integer()
        if fractional and (payload.order_type != "market" or payload.time_in_force != "day" or payload.extended_hours):
            raise HTTPException(status_code=422, detail="碎股只能用于市价单、DAY 有效期，且不支持延长时段。")
        if fractional and payload.order_class != "simple":
            raise HTTPException(status_code=422, detail="碎股不支持括号 / OCO / OTO 订单。")

    if payload.notional is not None:
        if payload.order_type != "market" or payload.order_class != "simple":
            raise HTTPException(status_code=422, detail="按金额下单只支持简单的市价单。")
        if payload.side == "sell":
            raise HTTPException(status_code=422, detail="卖出请使用股数，而不是金额。")

    if payload.order_type == "limit" and payload.limit_price is None:
        raise HTTPException(status_code=422, detail="限价单需要填写限价。")
    if payload.order_type in ("stop", "stop_limit") and payload.stop_price is None:
        raise HTTPException(status_code=422, detail="止损单需要填写触发价。")
    if payload.order_type == "stop_limit" and payload.limit_price is None:
        raise HTTPException(status_code=422, detail="止损限价单需要同时填写触发价和限价。")
    if payload.order_type == "trailing_stop" and (payload.trail_price is None) == (payload.trail_percent is None):
        raise HTTPException(status_code=422, detail="追踪止损需要填写固定追踪额或追踪百分比，二者只能选一个。")
    if payload.order_type == "market" and (payload.limit_price or payload.stop_price):
        raise HTTPException(status_code=422, detail="市价单不应包含限价或触发价。")
    if payload.extended_hours:
        if payload.order_type != "limit" or payload.time_in_force != "day":
            raise HTTPException(status_code=422, detail="延长时段只支持限价单 + DAY 有效期。")
        if payload.qty is None or not float(payload.qty).is_integer():
            raise HTTPException(status_code=422, detail="延长时段订单需要整数股。")
        if payload.order_class != "simple":
            raise HTTPException(status_code=422, detail="延长时段不支持括号 / OCO / OTO 订单。")
    if payload.order_class in ("oco", "oto") and payload.order_type not in ("market", "limit"):
        # Alpaca's OCO/OTO exit legs are unambiguous only for market/limit entry orders.
        raise HTTPException(status_code=422, detail="OCO / OTO 的主单只支持市价或限价。")
    if payload.order_class in ("bracket", "oco"):
        if payload.take_profit is None or payload.stop_loss is None:
            raise HTTPException(status_code=422, detail="括号订单需要同时设置止盈价和止损价。")
        if payload.qty is None:
            raise HTTPException(status_code=422, detail="括号订单需要填写股数。")
        if payload.order_class == "bracket" and payload.side != "buy":
            raise HTTPException(status_code=422, detail="目前只支持买入方向的括号订单。")
    if payload.order_class == "oto":
        if payload.take_profit is None and payload.stop_loss is None:
            raise HTTPException(status_code=422, detail="OTO 订单至少需要一个止盈或止损出口。")
        if payload.qty is None:
            raise HTTPException(status_code=422, detail="OTO 订单需要填写股数。")
    if payload.order_class == "simple" and (payload.take_profit is not None or payload.stop_loss is not None or payload.stop_loss_limit is not None):
        raise HTTPException(status_code=422, detail="普通订单不支持止盈/止损，请选择括号单、OCO 或 OTO。")
    if payload.client_order_id is not None and not payload.client_order_id.strip():
        raise HTTPException(status_code=422, detail="client order id 不能只包含空白字符。")
    return symbol


def _check_sell(symbol: str, payload: OrderInput) -> None:
    if payload.side != "sell" or payload.allow_short:
        return
    if payload.qty is None:
        return
    try:
        position_rows = trading_get("/v2/positions")
        held = next((as_float(item.get("qty")) or 0.0 for item in position_rows if item.get("symbol") == symbol), 0.0)
        pending = trading_get("/v2/orders", {"status": "open", "limit": 500, "symbols": symbol})
        reserved = sum(
            (as_float(item.get("qty")) or 0.0) - (as_float(item.get("filled_qty")) or 0.0)
            for item in pending
            if item.get("symbol") == symbol and item.get("side") == "sell"
        )
    except UpstreamError:
        return
    if payload.qty > max(0.0, held - reserved):
        raise HTTPException(status_code=422, detail=f"可卖数量不足：当前可卖约 {max(0.0, held - reserved):g} 股（已扣除挂单）。如需做空，请勾选允许做空。")


@router.post("/orders", status_code=201)
def create_order(payload: OrderInput) -> dict:
    symbol = _validate_order(payload)
    _check_sell(symbol, payload)
    body: dict = {
        "symbol": symbol,
        "side": payload.side,
        "type": payload.order_type,
        "time_in_force": payload.time_in_force,
        "extended_hours": payload.extended_hours,
    }
    if payload.qty is not None:
        body["qty"] = f"{payload.qty:g}"
    if payload.notional is not None:
        body["notional"] = f"{payload.notional:.2f}"
    if payload.limit_price is not None:
        body["limit_price"] = f"{payload.limit_price:g}"
    if payload.stop_price is not None:
        body["stop_price"] = f"{payload.stop_price:g}"
    if payload.trail_price is not None:
        body["trail_price"] = f"{payload.trail_price:g}"
    if payload.trail_percent is not None:
        body["trail_percent"] = f"{payload.trail_percent:g}"
    if payload.order_class != "simple":
        body["order_class"] = payload.order_class
        if payload.take_profit is not None:
            body["take_profit"] = {"limit_price": f"{payload.take_profit:g}"}
        if payload.stop_loss is not None:
            stop_loss = {"stop_price": f"{payload.stop_loss:g}"}
            if payload.stop_loss_limit is not None:
                stop_loss["limit_price"] = f"{payload.stop_loss_limit:g}"
            body["stop_loss"] = stop_loss
    if payload.client_order_id:
        body["client_order_id"] = payload.client_order_id.strip()
    try:
        raw = trading_send("POST", "/v2/orders", body)
    except UpstreamError as exc:
        raise _handle_error(exc) from None
    return normalize_order(raw)


class OrderPatch(BaseModel):
    qty: float | None = Field(default=None, gt=0, le=1_000_000)
    limit_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    trail: float | None = Field(default=None, gt=0)
    time_in_force: Literal["day", "gtc", "opg", "cls", "ioc", "fok"] | None = None


@router.patch("/orders/{order_id}")
def replace_order(order_id: str, payload: OrderPatch) -> dict:
    body: dict = {}
    if payload.qty is not None:
        body["qty"] = f"{payload.qty:g}"
    if payload.limit_price is not None:
        body["limit_price"] = f"{payload.limit_price:g}"
    if payload.stop_price is not None:
        body["stop_price"] = f"{payload.stop_price:g}"
    if payload.trail is not None:
        body["trail"] = f"{payload.trail:g}"
    if payload.time_in_force is not None:
        body["time_in_force"] = payload.time_in_force
    if not body:
        raise HTTPException(status_code=422, detail="没有提供需要修改的字段。")
    try:
        return normalize_order(trading_send("PATCH", f"/v2/orders/{order_id}", body))
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.delete("/orders/{order_id}")
def cancel_order(order_id: str) -> dict:
    try:
        trading_send("DELETE", f"/v2/orders/{order_id}")
        return {"cancelled": True, "id": order_id}
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.delete("/orders")
def cancel_all_orders() -> dict:
    try:
        trading_send("DELETE", "/v2/orders")
        return {"cancelled": True}
    except UpstreamError as exc:
        raise _handle_error(exc) from None


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


def _clean_activity(item: dict) -> dict:
    clean = {}
    for key, value in item.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            clean[key] = value
    clean["amount"] = as_float(item.get("net_amount"))
    clean["quantity"] = as_float(item.get("qty"))
    clean["activity_type"] = item.get("activity_type") or item.get("type")
    return clean


@router.get("/activities")
def activities(
    types: str = Query("FILL,DIV,INT,CSD,SPLIT,OPEXP,OPTRD,JNLC", max_length=200),
    limit: int = Query(100, ge=1, le=100),
    after: str | None = Query(None, max_length=40),
    until: str | None = Query(None, max_length=40),
    page_token: str | None = Query(None, max_length=200),
) -> list[dict]:
    params: dict = {"activity_types": types, "page_size": limit, "direction": "desc"}
    if after:
        params["after"] = after
    if until:
        params["until"] = until
    if page_token:
        params["page_token"] = page_token
    try:
        raw = trading_get("/v2/account/activities", params)
    except UpstreamError as exc:
        raise _handle_error(exc) from None
    return [_clean_activity(item) for item in raw]


def _month_windows(start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    """Split a range into calendar-month windows so each call stays under Alpaca's page limit."""
    windows: list[tuple[datetime, datetime]] = []
    cursor = start
    while cursor < end:
        first_of_next = (cursor.replace(day=1) + timedelta(days=32)).replace(day=1)
        window_end = min(first_of_next, end)
        windows.append((cursor, window_end))
        cursor = window_end
    return windows or [(start, end)]


def _parse_stamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail="日期格式应为 YYYY-MM-DD 或 ISO 时间。") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _derive_realized(fills: list[dict]) -> tuple[list[dict], float, bool, list[str]]:
    """Average-cost realized P&L per symbol from FILL activities.

    Sells without a known opening buy (or after flipping short) are reported as
    ``realized_pl: None`` instead of guessing a cost basis.
    """
    sticks: dict[str, dict] = {}
    warnings: list[str] = []
    for item in sorted(fills, key=lambda row: str(row.get("transaction_time") or "")):
        symbol = (item.get("symbol") or "").upper()
        side = (item.get("side") or "").lower()
        qty = as_float(item.get("qty")) or 0.0
        price = as_float(item.get("price")) or 0.0
        if not symbol or qty <= 0 or side not in ("buy", "sell"):
            continue
        state = sticks.setdefault(symbol, {
            "symbol": symbol,
            "qty": 0.0,
            "cost": 0.0,
            "realized": 0.0,
            "buy_qty": 0.0,
            "sell_qty": 0.0,
            "fills": 0,
            "unknown": False,
        })
        state["fills"] += 1
        if side == "buy":
            state["qty"] += qty
            state["cost"] += qty * price
            state["buy_qty"] += qty
            continue
        state["sell_qty"] += qty
        if state["qty"] <= 0 or state["unknown"]:
            state["unknown"] = True
            state["qty"] -= qty
            continue
        matched = min(qty, state["qty"])
        average = state["cost"] / state["qty"] if state["qty"] else 0.0
        state["realized"] += (price - average) * matched
        state["qty"] -= matched
        state["cost"] -= average * matched
        if qty > matched:
            state["unknown"] = True
            state["qty"] -= qty - matched
            state["cost"] = 0.0

    symbols = []
    total = 0.0
    known = False
    for state in sticks.values():
        realized = None if state["unknown"] else round(state["realized"], 2)
        if realized is not None:
            total += realized
            known = True
        else:
            warnings.append(f"{state['symbol']} 在窗口内缺少对应的买入成本，已实现盈亏记为 null。")
        symbols.append({
            "symbol": state["symbol"],
            "realized_pl": realized,
            "buy_qty": round(state["buy_qty"], 4),
            "sell_qty": round(state["sell_qty"], 4),
            "open_qty": round(state["qty"], 4),
            "fills": state["fills"],
            "reason": "缺少建仓成本（活动窗口内没有对应买入）" if state["unknown"] else None,
        })
    symbols.sort(key=lambda row: (row["realized_pl"] is None, -(row["realized_pl"] or 0)))
    return symbols, total, known, warnings


@router.get("/account/realized-pnl")
def account_realized_pnl(
    days: int = Query(365, ge=7, le=1825),
    after: str | None = Query(None, max_length=40),
    until: str | None = Query(None, max_length=40),
) -> dict:
    """Approximate realized P&L per symbol from FILL activities using average cost.

    Alpaca's activities API has no cost-basis field, so this is a derivation:
    it only knows about fills inside the requested window and never invents a
    cost for sells whose opening buys are outside the window.
    """
    end = _parse_stamp(until) or datetime.now(timezone.utc)
    start = _parse_stamp(after) or (end - timedelta(days=days))
    if start >= end:
        raise HTTPException(status_code=422, detail="开始时间必须早于结束时间。")

    def load() -> dict:
        def fetch(after_dt: datetime, until_dt: datetime) -> list[dict]:
            raw = trading_get("/v2/account/activities", {
                "activity_types": "FILL,DIV,INT",
                "page_size": 100,
                "direction": "asc",
                "after": after_dt.isoformat(),
                "until": until_dt.isoformat(),
            })
            return raw if isinstance(raw, list) else []

        # Fast path: one page covers the whole range for typical paper accounts.
        truncated = False
        windows_used = 1
        rows = fetch(start, end)
        if len(rows) >= 100:
            windows = _month_windows(start, end)
            windows_used = len(windows)
            rows = []
            for window_start, window_end in windows:
                chunk = fetch(window_start, window_end)
                if len(chunk) >= 100:
                    truncated = True
                rows.extend(chunk)

        fills: list[dict] = []
        dividends = 0.0
        interest = 0.0
        for item in rows:
            kind = (item.get("activity_type") or item.get("type") or "").upper()
            if kind == "FILL":
                fills.append(item)
            elif kind == "DIV":
                dividends += as_float(item.get("net_amount")) or 0.0
            elif kind == "INT":
                interest += as_float(item.get("net_amount")) or 0.0

        symbols, total, known, warnings = _derive_realized(fills)

        return {
            "available": bool(symbols),
            "method": "average_cost_from_fills",
            "window": {
                "after": start.isoformat(),
                "until": end.isoformat(),
                "windows": windows_used,
                "fills": len(fills),
                "truncated": truncated,
            },
            "partial": truncated,
            "note": "根据账户活动 FILL 的平均成本法估算，不含手续费与税费；窗口外的建仓成本无法还原，因此可能有 null。",
            "symbols": symbols,
            "total_realized_pl": round(total, 2) if known else (0.0 if not symbols else None),
            "dividend_income": round(dividends, 2),
            "interest_income": round(interest, 2),
            "warnings": warnings[:10],
        }

    key = f"realized:{start.date()}:{end.date()}"
    try:
        return cache.get_or_set(key, 120, load, stale_ttl=900)
    except UpstreamError as exc:
        raise _handle_error(exc) from None


# ---------------------------------------------------------------------------
# Watchlists (stored on Alpaca so they follow the paper account)
# ---------------------------------------------------------------------------


def _normalize_watchlist(raw: dict) -> dict:
    assets = raw.get("assets") or []
    symbols = [asset.get("symbol") for asset in assets if asset.get("symbol")]
    return {
        "id": raw.get("id"),
        "name": raw.get("name") or "未命名列表",
        "account_id": raw.get("account_id"),
        "created_at": iso(raw.get("created_at")),
        "updated_at": iso(raw.get("updated_at")),
        "symbols": symbols,
        "assets": [normalize_asset(asset) for asset in assets],
    }


def _watchlist_detail(watchlist_id: str) -> dict:
    return _normalize_watchlist(trading_get(f"/v2/watchlists/{watchlist_id}"))


def _watchlists() -> list[dict]:
    def load() -> list[dict]:
        # The list endpoint omits assets, so load each watchlist for symbols.
        summaries = trading_get("/v2/watchlists")
        results = []
        for item in summaries:
            watchlist_id = item.get("id")
            if not watchlist_id:
                continue
            try:
                results.append(_watchlist_detail(watchlist_id))
            except UpstreamError:
                results.append(_normalize_watchlist(item))
        return results

    return cache.get_or_set("watchlists", 5, load, stale_ttl=60)


@router.get("/watchlists")
def watchlists() -> list[dict]:
    try:
        return _watchlists()
    except UpstreamError as exc:
        raise _handle_error(exc) from None


class WatchlistInput(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    symbols: list[str] = Field(default_factory=list, max_length=50)


class WatchlistSymbol(BaseModel):
    symbol: str = Field(min_length=1, max_length=12)


@router.post("/watchlists", status_code=201)
def create_watchlist(payload: WatchlistInput) -> dict:
    symbols = [item.strip().upper() for item in payload.symbols if valid_symbol(item.strip())]
    try:
        raw = trading_send("POST", "/v2/watchlists", {"name": payload.name.strip(), "symbols": symbols})
        cache.invalidate("watchlists")
        watchlist_id = raw.get("id")
        if watchlist_id:
            return _watchlist_detail(watchlist_id)
        return _normalize_watchlist(raw)
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.patch("/watchlists/{watchlist_id}")
@router.put("/watchlists/{watchlist_id}")
def update_watchlist(watchlist_id: str, payload: WatchlistInput) -> dict:
    symbols = [item.strip().upper() for item in payload.symbols if valid_symbol(item.strip())]
    body: dict = {"name": payload.name.strip()}
    if symbols:
        body["symbols"] = symbols
    try:
        trading_send("PUT", f"/v2/watchlists/{watchlist_id}", body)
        cache.invalidate("watchlists")
        return _watchlist_detail(watchlist_id)
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.delete("/watchlists/{watchlist_id}")
def delete_watchlist(watchlist_id: str) -> dict:
    try:
        trading_send("DELETE", f"/v2/watchlists/{watchlist_id}")
        cache.invalidate("watchlists")
        return {"deleted": True, "id": watchlist_id}
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.post("/watchlists/{watchlist_id}/symbols")
def add_watchlist_symbol(watchlist_id: str, payload: WatchlistSymbol) -> dict:
    symbol = payload.symbol.strip().upper()
    if not valid_symbol(symbol):
        raise HTTPException(status_code=422, detail="无效的股票代码。")
    try:
        trading_send("POST", f"/v2/watchlists/{watchlist_id}", {"symbol": symbol})
        cache.invalidate("watchlists")
        return _watchlist_detail(watchlist_id)
    except UpstreamError as exc:
        raise _handle_error(exc) from None


@router.delete("/watchlists/{watchlist_id}/symbols/{symbol}")
def remove_watchlist_symbol(watchlist_id: str, symbol: str) -> dict:
    try:
        trading_send("DELETE", f"/v2/watchlists/{watchlist_id}/{symbol.upper()}")
        cache.invalidate("watchlists")
        return _watchlist_detail(watchlist_id)
    except UpstreamError as exc:
        raise _handle_error(exc) from None
