"""Options chain built from Alpaca option snapshots (including greeks and IV)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .alpaca_api import (
    UpstreamError,
    as_float,
    as_int,
    data_get,
    iso,
    normalize_bar,
    normalize_order,
    normalize_position,
    snapshots_for,
    trading_get,
    trading_send,
)
from .cache import cache
from .config import ET, OCC_RE, valid_symbol

router = APIRouter(prefix="/api")


class OptionLegInput(BaseModel):
    symbol: str = Field(min_length=15, max_length=24)
    side: Literal["buy", "sell"]
    ratio_qty: int = Field(default=1, ge=1, le=10)
    position_intent: Literal["buy_to_open", "buy_to_close", "sell_to_open", "sell_to_close"] | None = None


class OptionOrderInput(BaseModel):
    qty: int = Field(default=1, ge=1, le=100)
    order_type: Literal["market", "limit"] = "limit"
    limit_price: float | None = Field(default=None, gt=0)
    time_in_force: Literal["day"] = "day"
    client_order_id: str | None = Field(default=None, min_length=1, max_length=48)
    legs: list[OptionLegInput] = Field(min_length=1, max_length=4)


def _valid_symbol_or_422(symbol: str) -> str:
    symbol = (symbol or "").strip().upper()
    if not valid_symbol(symbol):
        raise HTTPException(status_code=422, detail="请输入有效的股票代码。")
    return symbol


def _parse_occ(symbol: str) -> dict | None:
    match = OCC_RE.match(symbol)
    if not match:
        return None
    return {
        "root": match.group("root"),
        "expiration": f"20{match.group('y')}-{match.group('m')}-{match.group('d')}",
        "kind": "call" if match.group("kind") == "C" else "put",
        "strike": int(match.group("strike")) / 1000,
    }


def _snapshot_rows(symbol: str, params: dict[str, Any], max_pages: int = 1) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    page_token = None
    for _ in range(max_pages):
        request_params = dict(params)
        request_params["limit"] = 1000
        if page_token:
            request_params["page_token"] = page_token
        raw = data_get(f"/v1beta1/options/snapshots/{symbol}", request_params, timeout=30)
        rows.update(raw.get("snapshots") or {})
        page_token = raw.get("next_page_token")
        if not page_token:
            break
    return rows


def _contract_rows(symbol: str, expiration: str, *, kind: str | None = None, strike_gte: float | None = None, strike_lte: float | None = None, limit: int = 1000, max_pages: int = 2) -> list[dict]:
    """Active option contracts from Alpaca's contract metadata endpoint (max two pages)."""
    rows: list[dict] = []
    page_token = None
    for _ in range(max_pages):
        params: dict[str, Any] = {
            "underlying_symbols": symbol,
            "expiration_date": expiration,
            "status": "active",
            "limit": min(max(limit, 1), 1000),
        }
        if kind in ("call", "put"):
            params["type"] = kind
        if strike_gte is not None:
            params["strike_price_gte"] = strike_gte
        if strike_lte is not None:
            params["strike_price_lte"] = strike_lte
        if page_token:
            params["page_token"] = page_token
        raw = trading_get("/v2/options/contracts", params)
        rows.extend(raw.get("option_contracts") or [])
        page_token = raw.get("next_page_token")
        if not page_token or len(rows) >= limit:
            break
    return rows[:limit]


def _normalize_contract_meta(raw: dict) -> dict:
    return {
        "id": raw.get("id"),
        "symbol": raw.get("symbol"),
        "name": raw.get("name"),
        "status": raw.get("status"),
        "tradable": bool(raw.get("tradable")),
        "expiration_date": raw.get("expiration_date"),
        "strike_price": as_float(raw.get("strike_price")),
        "type": raw.get("type"),
        "style": raw.get("style"),
        "multiplier": as_int(raw.get("multiplier")),
        "size": as_int(raw.get("size")),
        "open_interest": as_int(raw.get("open_interest")),
        "open_interest_date": raw.get("open_interest_date"),
        "close_price": as_float(raw.get("close_price")),
        "close_price_date": raw.get("close_price_date"),
    }


def option_expirations(symbol: str) -> dict:
    def load() -> dict:
        rows = _snapshot_rows(symbol, {}, max_pages=2)
        today = datetime.now(ET).date().isoformat()
        counts: dict[str, int] = {}
        for contract in rows:
            parsed = _parse_occ(contract)
            if parsed and parsed["expiration"] >= today:
                counts[parsed["expiration"]] = counts.get(parsed["expiration"], 0) + 1
        expirations = [
            {"expiration": expiry, "contracts": count, "label": expiry}
            for expiry, count in sorted(counts.items())
        ]
        return {"symbol": symbol, "expirations": expirations, "available": bool(expirations)}

    try:
        return cache.get_or_set(f"options:expirations:{symbol}", 900, load, stale_ttl=6 * 3600)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "expirations": [], "available": False, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


def _normalize_contract(symbol: str, raw: dict, spot: float | None, contract: dict | None = None) -> dict | None:
    parsed = _parse_occ(symbol)
    meta = contract or {}
    kind = meta.get("type") or (parsed or {}).get("kind")
    strike = meta.get("strike_price")
    if strike is None:
        strike = (parsed or {}).get("strike")
    expiration = meta.get("expiration_date") or (parsed or {}).get("expiration")
    if kind not in ("call", "put") or strike is None:
        return None
    quote = raw.get("latestQuote") or {}
    trade = raw.get("latestTrade") or {}
    daily = raw.get("dailyBar") or {}
    previous = raw.get("prevDailyBar") or {}
    greeks = raw.get("greeks") or {}
    bid = as_float(quote.get("bp"))
    ask = as_float(quote.get("ap"))
    mid = (bid + ask) / 2 if bid is not None and ask is not None else None
    last = as_float(trade.get("p"))
    if last is None:
        last = as_float(daily.get("c"))
    prev_close = as_float(previous.get("c"))
    change = last - prev_close if last is not None and prev_close else None
    intrinsic = None
    if spot is not None:
        intrinsic = max(0.0, spot - strike) if kind == "call" else max(0.0, strike - spot)
    return {
        "symbol": symbol,
        "kind": kind,
        "strike": strike,
        "expiration": expiration,
        "bid": bid,
        "ask": ask,
        "mid": mid,
        "spread": (ask - bid) if bid is not None and ask is not None else None,
        "last": last,
        "change": change,
        "change_pct": change / prev_close if change is not None and prev_close else None,
        "volume": as_int(daily.get("v")),
        "trade_count": as_int(daily.get("n")),
        "iv": as_float(raw.get("impliedVolatility")),
        "delta": as_float(greeks.get("delta")),
        "gamma": as_float(greeks.get("gamma")),
        "theta": as_float(greeks.get("theta")),
        "vega": as_float(greeks.get("vega")),
        "rho": as_float(greeks.get("rho")),
        "intrinsic": intrinsic,
        "quote_ts": iso(quote.get("t")),
        "in_the_money": (spot is not None and ((kind == "call" and spot > strike) or (kind == "put" and spot < strike))),
        "id": meta.get("id"),
        "name": meta.get("name"),
        "status": meta.get("status"),
        "tradable": meta.get("tradable"),
        "style": meta.get("style"),
        "multiplier": meta.get("multiplier"),
        "open_interest": meta.get("open_interest"),
        "close_price": meta.get("close_price"),
    }


@router.get("/stocks/{symbol}/options/expirations")
def expirations(symbol: str) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    return option_expirations(symbol)


@router.get("/stocks/{symbol}/options/contracts")
def option_contracts(
    symbol: str,
    expiration: str = Query(..., min_length=10, max_length=10),
    kind: Literal["call", "put"] | None = Query(None, alias="type"),
    strike_gte: float | None = Query(None, gt=0),
    strike_lte: float | None = Query(None, gt=0),
    limit: int = Query(1000, ge=1, le=2000),
) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    try:
        datetime.strptime(expiration, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="到期日格式应为 YYYY-MM-DD。")
    if strike_gte is not None and strike_lte is not None and strike_gte > strike_lte:
        raise HTTPException(status_code=422, detail="strike_gte 不能大于 strike_lte。")

    def load() -> dict:
        rows = _contract_rows(
            symbol,
            expiration,
            kind=kind,
            strike_gte=strike_gte,
            strike_lte=strike_lte,
            limit=limit,
        )
        contracts = [_normalize_contract_meta(row) for row in rows if row.get("symbol")]
        return {
            "symbol": symbol,
            "expiration": expiration,
            "contracts": contracts,
            "count": len(contracts),
            "available": bool(contracts),
        }

    key = f"options:contracts:{symbol}:{expiration}:{kind or 'all'}:{strike_gte or ''}:{strike_lte or ''}:{limit}"
    try:
        return cache.get_or_set(key, 300, load, stale_ttl=6 * 3600)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "expiration": expiration, "contracts": [], "count": 0, "available": False, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/stocks/{symbol}/options/chain")
def chain(
    symbol: str,
    expiration: str = Query(..., min_length=10, max_length=10),
    width: int = Query(12, ge=3, le=30),
    full: bool = False,
) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    try:
        datetime.strptime(expiration, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="到期日格式应为 YYYY-MM-DD。")

    def load() -> dict:
        snapshot = snapshots_for([symbol]).get(symbol) or {}
        spot = snapshot.get("price")
        meta_by_symbol: dict[str, dict] = {}
        if full:
            try:
                raw_contracts = _contract_rows(symbol, expiration, limit=1000)
            except UpstreamError:
                raw_contracts = []
            meta_by_symbol = {
                meta["symbol"]: meta
                for meta in (_normalize_contract_meta(row) for row in raw_contracts)
                if meta.get("symbol")
            }
        params: dict[str, Any] = {"expiration_date": expiration}
        if not full and spot:
            params["strike_price_gte"] = round(spot * 0.8, 2)
            params["strike_price_lte"] = round(spot * 1.2, 2)
        rows = _snapshot_rows(symbol, params, max_pages=2)
        if meta_by_symbol:
            contracts = [
                item
                for item in (
                    _normalize_contract(name, rows.get(name) or {}, spot, contract=meta)
                    for name, meta in meta_by_symbol.items()
                )
                if item
            ]
        else:
            contracts = [item for item in (_normalize_contract(name, raw, spot) for name, raw in rows.items()) if item]
        calls = sorted([item for item in contracts if item["kind"] == "call"], key=lambda item: item["strike"])
        puts = sorted([item for item in contracts if item["kind"] == "put"], key=lambda item: item["strike"])
        strikes = sorted({item["strike"] for item in contracts})
        atm = min(strikes, key=lambda strike: abs(strike - spot)) if strikes and spot else None
        if not full and atm is not None:
            index = strikes.index(atm)
            keep = set(strikes[max(0, index - width): index + width + 1])
            calls = [item for item in calls if item["strike"] in keep]
            puts = [item for item in puts if item["strike"] in keep]
        return {
            "symbol": symbol,
            "expiration": expiration,
            "spot": spot,
            "atm_strike": atm,
            "calls": calls,
            "puts": puts,
            "strikes": strikes,
            "full": full,
            "available": bool(contracts),
            "feed": "OPRA 期权快照（可能延迟）",
        }

    key = f"options:chain:{symbol}:{expiration}:{width}:{'full' if full else 'atm'}"
    try:
        return cache.get_or_set(key, 30, load, stale_ttl=300)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "expiration": expiration, "calls": [], "puts": [], "available": False, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/stocks/{symbol}/options/overview")
def option_overview(symbol: str) -> dict:
    """Nearest expiry with usable greeks, ATM implied volatility and put/call volume."""
    symbol = _valid_symbol_or_422(symbol)
    data = option_expirations(symbol)
    if not data.get("available"):
        return {"available": False, "symbol": symbol, "message": data.get("message")}
    payload = None
    for entry in data["expirations"][:4]:
        candidate = chain(symbol, entry["expiration"], 8)
        if candidate.get("available"):
            payload = candidate
            atm_ivs = [
                item.get("iv")
                for item in (candidate.get("calls") or []) + (candidate.get("puts") or [])
                if item.get("iv") is not None
            ]
            if atm_ivs:
                break
    if not payload or not payload.get("available"):
        return {"available": False, "symbol": symbol, "message": (payload or {}).get("message")}
    calls, puts = payload.get("calls", []), payload.get("puts", [])
    atm = payload.get("atm_strike")
    with_iv_calls = [item for item in calls if item.get("iv") is not None] or calls
    with_iv_puts = [item for item in puts if item.get("iv") is not None] or puts
    atm_call = min(with_iv_calls, key=lambda item: abs(item["strike"] - (atm or 0))) if with_iv_calls else None
    atm_put = min(with_iv_puts, key=lambda item: abs(item["strike"] - (atm or 0))) if with_iv_puts else None
    call_volume = sum(item.get("volume") or 0 for item in calls)
    put_volume = sum(item.get("volume") or 0 for item in puts)
    return {
        "available": True,
        "symbol": symbol,
        "expiration": payload.get("expiration"),
        "spot": payload.get("spot"),
        "atm_strike": atm,
        "atm_call_iv": atm_call.get("iv") if atm_call else None,
        "atm_put_iv": atm_put.get("iv") if atm_put else None,
        "call_volume": call_volume,
        "put_volume": put_volume,
        "put_call_ratio": (put_volume / call_volume) if call_volume else None,
        "calls": calls[:3],
        "puts": puts[:3],
    }


OPTION_HISTORY_RANGE_DAYS = {"1M": 35, "3M": 95, "6M": 190, "1Y": 370}


@router.get("/stocks/{symbol}/options/history")
def option_history(
    symbol: str,
    contracts: str = Query(..., min_length=15, max_length=120),
    range_key: str = Query("1M", alias="range"),
) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    range_key = (range_key or "1M").upper()
    if range_key not in OPTION_HISTORY_RANGE_DAYS:
        raise HTTPException(status_code=422, detail="范围只支持 1M / 3M / 6M / 1Y。")
    contract_list = [item.strip().upper() for item in contracts.split(",") if item.strip()]
    if not contract_list:
        raise HTTPException(status_code=422, detail="请至少提供一个期权合约代码。")
    if len(contract_list) > 4:
        raise HTTPException(status_code=422, detail="一次最多查询 4 个期权合约，避免请求过长。")
    for item in contract_list:
        parsed = _parse_occ(item)
        if not parsed or parsed["root"] != symbol:
            raise HTTPException(status_code=422, detail=f"无效的期权代码：{item}")

    def load() -> dict:
        start = datetime.now(timezone.utc) - timedelta(days=OPTION_HISTORY_RANGE_DAYS[range_key])
        raw = data_get("/v1beta1/options/bars", {
            "symbols": ",".join(contract_list),
            "timeframe": "1Day",
            "start": start.isoformat().replace("+00:00", "Z"),
            "limit": 1000,
            "sort": "asc",
        }, timeout=30)
        rows = raw.get("bars") or {}
        return {
            "symbol": symbol,
            "range": range_key,
            "contracts": [
                {
                    "symbol": item,
                    "bars": [
                        normalize_bar(bar, symbol=item)
                        for bar in (rows.get(item) or [])
                        if bar.get("c") is not None
                    ],
                }
                for item in contract_list
            ],
            "feed": "OPRA 期权日线（可能延迟）",
        }

    key = f"options:history:{symbol}:{','.join(contract_list)}:{range_key}"
    try:
        return cache.get_or_set(key, 300, load, stale_ttl=3600)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "range": range_key, "contracts": [], "available": False, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/stocks/{symbol}/options/iv-term")
def option_iv_term(symbol: str, expirations: str = Query(..., min_length=10, max_length=90)) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    parsed_expiries: list[str] = []
    for item in (part.strip() for part in expirations.split(",")):
        if not item:
            continue
        try:
            datetime.strptime(item, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=422, detail="到期日格式应为 YYYY-MM-DD。") from None
        if item not in parsed_expiries:
            parsed_expiries.append(item)
    if not parsed_expiries:
        raise HTTPException(status_code=422, detail="请至少提供一个到期日。")
    if len(parsed_expiries) > 6:
        raise HTTPException(status_code=422, detail="一次最多查询 6 个到期日。")

    def load() -> dict:
        today = datetime.now(ET).date()
        points = []
        for expiry in parsed_expiries:
            try:
                expiry_date = datetime.strptime(expiry, "%Y-%m-%d").date()
            except ValueError:
                continue
            data = chain(symbol, expiry, 8)
            if not data.get("available"):
                continue
            atm = data.get("atm_strike")
            if atm is None:
                # Without a spot price there is no ATM; do not fall back to the lowest strike.
                continue
            ivs = []
            for key in ("calls", "puts"):
                rows = [item for item in (data.get(key) or []) if item.get("iv") is not None]
                if not rows:
                    continue
                nearest = min(rows, key=lambda item: abs(item["strike"] - (atm or 0)))
                if nearest.get("iv"):
                    ivs.append(nearest["iv"])
            if not ivs:
                continue
            points.append({
                "expiration": expiry,
                "dte": (expiry_date - today).days,
                "atm_iv": sum(ivs) / len(ivs),
            })
        points.sort(key=lambda point: point["dte"])
        return {"symbol": symbol, "points": points, "available": bool(points)}

    key = f"options:ivterm:{symbol}:{','.join(parsed_expiries)}"
    try:
        return cache.get_or_set(key, 600, load, stale_ttl=3600)
    except UpstreamError as exc:
        if exc.status in (403, 404):
            return {"symbol": symbol, "points": [], "available": False, "message": exc.message}
        raise HTTPException(status_code=502, detail=exc.message) from None


@router.get("/stocks/{symbol}/options/positions")
def option_positions(symbol: str) -> list[dict]:
    symbol = _valid_symbol_or_422(symbol)
    try:
        rows = trading_get("/v2/positions")
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None
    result = []
    for row in rows:
        contract = _parse_occ((row.get("symbol") or "").upper())
        if row.get("asset_class") == "us_option" or contract:
            if contract and contract["root"] == symbol:
                result.append(normalize_position(row))
    return result


@router.delete("/stocks/{symbol}/options/positions/{contract}")
def close_option_position(symbol: str, contract: str) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    parsed = _parse_occ(contract.upper())
    if not parsed or parsed["root"] != symbol:
        raise HTTPException(status_code=422, detail="无效的期权合约代码。")
    try:
        raw = trading_send("DELETE", f"/v2/positions/{contract.upper()}")
    except UpstreamError as exc:
        raise HTTPException(status_code=502, detail=exc.message) from None
    return normalize_order(raw) if isinstance(raw, dict) and raw.get("id") else {"closed": True, "symbol": contract.upper()}


@router.post("/stocks/{symbol}/options/positions/{contract}/{action}")
def option_position_action(symbol: str, contract: str, action: str) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    parsed = _parse_occ(contract.upper())
    if not parsed or parsed["root"] != symbol:
        raise HTTPException(status_code=422, detail="无效的期权合约代码。")
    if action not in ("exercise", "do-not-exercise"):
        raise HTTPException(status_code=422, detail="不支持的行权操作。")
    try:
        trading_send("POST", f"/v2/positions/{contract.upper()}/{action}")
    except UpstreamError as exc:
        code = 422 if exc.status in (400, 403, 422) else 502
        raise HTTPException(status_code=code, detail=exc.message) from None
    return {"ok": True, "symbol": contract.upper(), "action": action}


@router.post("/stocks/{symbol}/options/orders", status_code=201)
def create_option_order(symbol: str, payload: OptionOrderInput) -> dict:
    symbol = _valid_symbol_or_422(symbol)
    if payload.order_type == "limit" and payload.limit_price is None:
        raise HTTPException(status_code=422, detail="期权限价单需要填写净限价。")
    if payload.order_type == "market" and len(payload.legs) > 1:
        raise HTTPException(status_code=422, detail="多腿期权请使用限价单。")
    if payload.order_type == "market" and payload.limit_price is not None:
        raise HTTPException(status_code=422, detail="市价单不应包含限价。")

    legs = []
    for leg in payload.legs:
        parsed = _parse_occ(leg.symbol.upper())
        if not parsed:
            raise HTTPException(status_code=422, detail=f"无效的期权代码：{leg.symbol}")
        if parsed["root"] != symbol:
            raise HTTPException(status_code=422, detail="期权标的必须与当前股票一致。")
        intent = leg.position_intent or ("buy_to_open" if leg.side == "buy" else "sell_to_open")
        if len(payload.legs) == 1:
            legs.append((leg, intent))
        else:
            legs.append({
                "symbol": leg.symbol.upper(),
                "ratio_qty": str(leg.ratio_qty),
                "side": leg.side,
                "position_intent": intent,
            })

    body: dict = {
        "qty": str(payload.qty),
        "type": payload.order_type,
        "time_in_force": payload.time_in_force,
    }
    if payload.client_order_id:
        body["client_order_id"] = payload.client_order_id

    if len(payload.legs) == 1:
        leg, intent = legs[0]
        body.update({
            "symbol": leg.symbol.upper(),
            "qty": str(payload.qty * leg.ratio_qty),
            "side": leg.side,
            "position_intent": intent,
        })
        if payload.limit_price is not None:
            body["limit_price"] = f"{payload.limit_price:g}"
    else:
        body.update({
            "order_class": "mleg",
            "limit_price": f"{payload.limit_price:g}",
            "legs": legs,
        })

    try:
        raw = trading_send("POST", "/v2/orders", body)
    except UpstreamError as exc:
        code = 422 if exc.status in (400, 422) else 502
        raise HTTPException(status_code=code, detail=exc.message) from None
    return normalize_order(raw)
