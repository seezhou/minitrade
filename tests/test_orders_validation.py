"""Stock order rules.

These tests are deliberately offline: `_validate_order` is pure, and `_check_sell`
only reads positions/open orders, which the `upstream` fixture fakes. Nothing here
can ever place, replace or cancel a real order.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.alpaca_api import UpstreamError
from app.trading import OrderInput, _check_sell, _validate_order


def order(**overrides) -> OrderInput:
    base = {"symbol": "AAPL", "side": "buy", "order_type": "market", "qty": 1}
    base.update(overrides)
    return OrderInput(**base)


def rejection(payload: OrderInput) -> str:
    with pytest.raises(HTTPException) as info:
        _validate_order(payload)
    assert info.value.status_code == 422
    return str(info.value.detail)


# ---------------------------------------------------------------------------
# Symbol / quantity shape
# ---------------------------------------------------------------------------


def test_symbol_is_trimmed_and_uppercased():
    assert _validate_order(order(symbol=" aapl ")) == "AAPL"


def test_dotted_and_hyphenated_symbols_are_valid():
    assert _validate_order(order(symbol="BRK.B")) == "BRK.B"
    assert _validate_order(order(symbol="BF-B")) == "BF-B"


@pytest.mark.parametrize("symbol", ["AAPL US", "$AAPL", "1234", "AAPL!"])
def test_rejects_malformed_symbols(symbol):
    assert "有效的股票代码" in rejection(order(symbol=symbol))


@pytest.mark.parametrize("symbol", ["", "TOOLONGSYMBOLX"])
def test_symbol_length_is_blocked_by_the_schema(symbol):
    with pytest.raises(ValidationError):
        order(symbol=symbol)


def test_requires_exactly_one_of_qty_and_notional():
    assert "必须且只能填写一个" in rejection(order(qty=None))
    assert "必须且只能填写一个" in rejection(order(qty=1, notional=100))


@pytest.mark.parametrize(
    "overrides",
    [{"qty": 0}, {"qty": -1}, {"qty": 1_000_001}, {"trail_percent": 101}, {"client_order_id": "x" * 49}],
)
def test_out_of_range_values_are_blocked_by_the_schema(overrides):
    with pytest.raises(ValidationError):
        order(**overrides)


# ---------------------------------------------------------------------------
# Fractional shares
# ---------------------------------------------------------------------------


def test_fractional_shares_pass_on_market_day_simple():
    assert _validate_order(order(qty=1.5)) == "AAPL"


@pytest.mark.parametrize(
    "overrides",
    [
        {"qty": 1.5, "order_type": "limit", "limit_price": 100},
        {"qty": 1.5, "time_in_force": "gtc"},
        {"qty": 1.5, "extended_hours": True, "order_type": "limit", "limit_price": 100},
    ],
)
def test_fractional_shares_are_restricted_to_market_day(overrides):
    assert "碎股只能用于市价单" in rejection(order(**overrides))


def test_fractional_shares_cannot_use_order_classes():
    payload = order(qty=1.5, order_class="bracket", take_profit=110, stop_loss=90)
    assert "碎股不支持" in rejection(payload)


# ---------------------------------------------------------------------------
# Notional orders
# ---------------------------------------------------------------------------


def test_notional_only_supports_simple_market_orders():
    assert "按金额下单只支持简单的市价单" in rejection(
        order(qty=None, notional=100, order_type="limit", limit_price=100)
    )
    assert "按金额下单只支持简单的市价单" in rejection(
        order(qty=None, notional=100, order_class="bracket", take_profit=110, stop_loss=90)
    )


def test_notional_sell_is_rejected():
    assert "卖出请使用股数" in rejection(order(qty=None, notional=100, side="sell"))


# ---------------------------------------------------------------------------
# Price fields per order type
# ---------------------------------------------------------------------------


def test_limit_order_requires_a_limit_price():
    assert "限价单需要填写限价" in rejection(order(order_type="limit"))


def test_stop_order_requires_a_stop_price():
    assert "止损单需要填写触发价" in rejection(order(order_type="stop"))


def test_stop_limit_requires_both_prices():
    assert "止损限价单需要同时填写触发价和限价" in rejection(order(order_type="stop_limit", stop_price=90))


def test_trailing_stop_needs_exactly_one_trigger():
    assert "二者只能选一个" in rejection(order(order_type="trailing_stop"))
    assert "二者只能选一个" in rejection(order(order_type="trailing_stop", trail_price=5, trail_percent=2))
    assert _validate_order(order(order_type="trailing_stop", trail_price=5)) == "AAPL"
    assert _validate_order(order(order_type="trailing_stop", trail_percent=2)) == "AAPL"


def test_market_order_rejects_price_fields():
    assert "市价单不应包含限价或触发价" in rejection(order(limit_price=100))
    assert "市价单不应包含限价或触发价" in rejection(order(stop_price=90))


# ---------------------------------------------------------------------------
# Extended hours
# ---------------------------------------------------------------------------


def test_extended_hours_accepts_integer_limit_day():
    payload = order(order_type="limit", limit_price=100, extended_hours=True, qty=10)
    assert _validate_order(payload) == "AAPL"


def test_extended_hours_requires_limit_and_day():
    assert "延长时段只支持限价单" in rejection(order(extended_hours=True))
    assert "延长时段只支持限价单" in rejection(order(order_type="limit", limit_price=100, time_in_force="gtc", extended_hours=True))


def test_extended_hours_rejects_order_classes():
    payload = order(order_type="limit", limit_price=100, extended_hours=True, order_class="oco", take_profit=110, stop_loss=90)
    assert "延长时段不支持括号" in rejection(payload)


# ---------------------------------------------------------------------------
# Bracket / OCO / OTO
# ---------------------------------------------------------------------------


def test_bracket_requires_both_exits():
    assert "括号订单需要同时设置止盈价和止损价" in rejection(order(order_class="bracket", take_profit=110))
    assert "括号订单需要同时设置止盈价和止损价" in rejection(order(order_class="bracket", stop_loss=90))


def test_bracket_only_allows_buy_side():
    payload = order(side="sell", order_class="bracket", take_profit=110, stop_loss=90)
    assert "只支持买入方向的括号订单" in rejection(payload)


def test_oco_requires_both_exits():
    assert "括号订单需要同时设置止盈价和止损价" in rejection(order(order_class="oco", take_profit=110))


def test_oco_and_oto_entry_must_be_market_or_limit():
    for order_class in ("oco", "oto"):
        payload = order(order_class=order_class, order_type="stop", stop_price=90, take_profit=110, stop_loss=80)
        assert "主单只支持市价或限价" in rejection(payload)


def test_oto_requires_at_least_one_exit():
    assert "OTO 订单至少需要一个止盈或止损出口" in rejection(order(order_class="oto"))


def test_simple_order_rejects_exit_prices():
    assert "普通订单不支持止盈/止损" in rejection(order(take_profit=110))
    assert "普通订单不支持止盈/止损" in rejection(order(stop_loss=90))


def test_client_order_id_cannot_be_blank():
    assert "不能只包含空白字符" in rejection(order(client_order_id="   "))


def test_valid_oto_passes():
    payload = order(qty=1, order_type="limit", limit_price=1.0, order_class="oto", take_profit=1000, client_order_id="mt-test")
    assert _validate_order(payload) == "AAPL"


# ---------------------------------------------------------------------------
# Sell-side coverage check
# ---------------------------------------------------------------------------


def _book(positions, open_orders=()):
    def handler(path, params):
        if path == "/v2/positions":
            return positions
        if path == "/v2/orders":
            return list(open_orders)
        raise AssertionError(f"unexpected upstream path: {path}")

    return handler


def test_sell_within_held_quantity_passes(upstream):
    upstream("app.trading", _book([{"symbol": "AAPL", "qty": "10"}]))
    _check_sell("AAPL", order(side="sell", qty=10))


def test_oversell_is_blocked(upstream):
    upstream("app.trading", _book([{"symbol": "AAPL", "qty": "10"}]))
    with pytest.raises(HTTPException) as info:
        _check_sell("AAPL", order(side="sell", qty=11))
    assert info.value.status_code == 422
    assert "可卖数量不足" in str(info.value.detail)


def test_open_sell_orders_are_subtracted(upstream):
    upstream(
        "app.trading",
        _book(
            [{"symbol": "AAPL", "qty": "10"}],
            [{"symbol": "AAPL", "side": "sell", "qty": "4", "filled_qty": "0"}],
        ),
    )
    _check_sell("AAPL", order(side="sell", qty=6))
    with pytest.raises(HTTPException):
        _check_sell("AAPL", order(side="sell", qty=7))


def test_positions_of_other_symbols_do_not_count(upstream):
    upstream("app.trading", _book([{"symbol": "MSFT", "qty": "100"}]))
    with pytest.raises(HTTPException):
        _check_sell("AAPL", order(side="sell", qty=1))


def test_partially_filled_open_sell_counts_only_the_remainder(upstream):
    upstream(
        "app.trading",
        _book(
            [{"symbol": "AAPL", "qty": "10"}],
            [{"symbol": "AAPL", "side": "sell", "qty": "4", "filled_qty": "3"}],
        ),
    )
    _check_sell("AAPL", order(side="sell", qty=9))
    with pytest.raises(HTTPException):
        _check_sell("AAPL", order(side="sell", qty=10))


def test_buy_and_allow_short_skip_the_upstream_lookup(upstream):
    calls = upstream("app.trading", _book([]))
    _check_sell("AAPL", order(side="buy", qty=5))
    _check_sell("AAPL", order(side="sell", qty=999, allow_short=True))
    assert calls == []


def test_sell_check_fails_open_when_upstream_is_down(upstream):
    def failing(path, params):
        raise UpstreamError(503, "upstream down", "http_503")

    upstream("app.trading", failing)
    _check_sell("AAPL", order(side="sell", qty=999))
