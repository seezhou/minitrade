"""Option order construction.

`POST /api/stocks/{symbol}/options/orders` is the only place that builds an Alpaca
option order, and it has two very different shapes: a single leg becomes a plain
`/v2/orders` ticket, while two or more legs become an `mleg` combo with a net price.
Both are covered here, offline, with a faked upstream — no order is ever sent.

Credit combos (iron condor, credit spreads) quote their net price as a **positive**
number: measured on the paper account, a far-from-market 4-leg condor with
`sell_to_open` on both short legs and `limit_price: "99.00"` is accepted verbatim.
So `limit_price` stays unsigned and `gt=0` is the correct constraint.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.alpaca_api import UpstreamError
from app.options import OptionOrderInput, _parse_occ

CALL_200 = "AAPL261120C00200000"
CALL_210 = "AAPL261120C00210000"
PUT_150 = "AAPL261120P00150000"
PUT_160 = "AAPL261120P00160000"

ORDER_RAW = {
    "id": "opt-1",
    "symbol": CALL_200,
    "side": "buy",
    "type": "limit",
    "qty": "1",
    "filled_qty": "0",
    "status": "accepted",
}


def leg(symbol: str = CALL_200, side: str = "buy", **overrides) -> dict:
    payload = {"symbol": symbol, "side": side}
    payload.update(overrides)
    return payload


def order(**overrides) -> OptionOrderInput:
    base = {"qty": 1, "order_type": "limit", "limit_price": 2.5, "legs": [leg()]}
    base.update(overrides)
    return OptionOrderInput(**base)


def post(client, payload: dict, symbol: str = "AAPL"):
    return client.post(f"/api/stocks/{symbol}/options/orders", json=payload)


# ---------------------------------------------------------------------------
# OCC parsing
# ---------------------------------------------------------------------------


def test_parse_occ_reads_a_standard_contract():
    parsed = _parse_occ(CALL_200)
    assert parsed == {"root": "AAPL", "expiration": "2026-11-20", "kind": "call", "strike": 200.0}


def test_parse_occ_handles_puts_and_fractional_strikes():
    parsed = _parse_occ("SPY260116P00450500")
    assert parsed["kind"] == "put"
    assert parsed["expiration"] == "2026-01-16"
    assert parsed["strike"] == 450.5


def test_parse_occ_handles_a_single_letter_root():
    assert _parse_occ("F260116C00015000")["root"] == "F"


@pytest.mark.parametrize(
    "symbol",
    [
        "AAPL",
        "AAPL261120X00200000",      # bad kind letter
        "aapl261120c00200000",      # lowercase
        "AAPL261120C0020000",       # seven strike digits
        "AAPL 261120C00200000",     # spaced broker format
        "",
    ],
)
def test_parse_occ_rejects_malformed_symbols(symbol):
    assert _parse_occ(symbol) is None


# ---------------------------------------------------------------------------
# Input schema
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("qty", [0, -1, 101])
def test_contract_count_must_be_1_to_100(qty):
    with pytest.raises(ValidationError):
        order(qty=qty)


@pytest.mark.parametrize("legs", [[], [leg(), leg(), leg(), leg(), leg()]])
def test_leg_count_must_be_1_to_4(legs):
    with pytest.raises(ValidationError):
        order(legs=legs)


@pytest.mark.parametrize(
    "overrides",
    [
        {"order_type": "stop"},
        {"time_in_force": "gtc"},
        {"limit_price": 0},
        {"limit_price": -1.5},
        {"client_order_id": "x" * 49},
        {"legs": [leg(symbol="F260116C001500")]},        # 14 chars, below min_length
        {"legs": [leg(symbol="X" * 25)]},                # above max_length
        {"legs": [leg(ratio_qty=0)]},
        {"legs": [leg(ratio_qty=11)]},
        {"legs": [leg(position_intent="open")]},
        {"legs": [leg(side="hold")]},
    ],
)
def test_out_of_range_inputs_are_rejected_by_the_schema(overrides):
    with pytest.raises(ValidationError):
        order(**overrides)


def test_credit_combo_forwards_a_positive_net_price(client, upstream):
    """An iron condor is a credit combo that still quotes a positive net price.

    Verified against the paper account: the same four legs with a `limit_price` of
    `"99.00"` came back `accepted`, so credit trades must not use a negative price.
    """
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(
        client,
        {
            "legs": [
                leg(symbol=PUT_150, side="buy"),
                leg(symbol=PUT_160, side="sell"),
                leg(symbol=CALL_200, side="sell"),
                leg(symbol=CALL_210, side="buy"),
            ],
            "qty": 1,
            "order_type": "limit",
            "limit_price": 1.8,
        },
    )

    assert response.status_code == 201
    body = calls[0][1]
    assert body["order_class"] == "mleg"
    assert body["limit_price"] == "1.8", "the credit is sent as an absolute value"
    assert body["qty"] == "1"
    assert [item["side"] for item in body["legs"]] == ["buy", "sell", "sell", "buy"]
    assert [item["position_intent"] for item in body["legs"]] == [
        "buy_to_open",
        "sell_to_open",
        "sell_to_open",
        "buy_to_open",
    ]


def test_credit_spread_keeps_every_leg_ratio_at_one(client, upstream):
    """A condor's leg ratios must reduce to 1:1:1:1, otherwise Alpaca rejects it."""
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(
        client,
        {
            "legs": [
                leg(symbol=PUT_150, side="buy"),
                leg(symbol=PUT_160, side="sell"),
                leg(symbol=CALL_200, side="sell"),
                leg(symbol=CALL_210, side="buy"),
            ],
            "order_type": "limit",
            "limit_price": 2.4,
        },
    )
    ratios = [item["ratio_qty"] for item in calls[0][1]["legs"]]
    assert ratios == ["1", "1", "1", "1"]



# ---------------------------------------------------------------------------
# Single leg: a plain ticket, never mleg
# ---------------------------------------------------------------------------


def test_single_leg_limit_uses_a_plain_ticket(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(client, {"legs": [leg()], "qty": 1, "order_type": "limit", "limit_price": 2.5})

    assert response.status_code == 201
    path, body = calls[0]
    assert path == "/v2/orders"
    assert body == {
        "qty": "1",
        "type": "limit",
        "time_in_force": "day",
        "symbol": CALL_200,
        "side": "buy",
        "position_intent": "buy_to_open",
        "limit_price": "2.5",
    }
    assert "order_class" not in body, "a single leg must not be sent as a combo"


def test_single_leg_defaults_the_intent_from_the_side(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(client, {"legs": [leg(side="sell")], "order_type": "market"})
    assert calls[0][1]["position_intent"] == "sell_to_open"
    assert calls[0][1]["side"] == "sell"


def test_single_leg_keeps_an_explicit_intent(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(client, {"legs": [leg(position_intent="sell_to_close")], "order_type": "market"})
    assert calls[0][1]["position_intent"] == "sell_to_close"


def test_single_leg_market_order_carries_no_limit_price(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(client, {"legs": [leg()], "order_type": "market"})
    assert "limit_price" not in calls[0][1]


def test_single_leg_multiplies_qty_by_ratio(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(client, {"legs": [leg(ratio_qty=3)], "qty": 2, "order_type": "market"})
    assert calls[0][1]["qty"] == "6", "the ticket qty is contracts * ratio"


def test_single_leg_forwards_client_order_id(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(client, {"legs": [leg()], "order_type": "market", "client_order_id": "mt-opt-1"})
    assert calls[0][1]["client_order_id"] == "mt-opt-1"


def test_route_returns_the_normalized_order(client, upstream):
    upstream("app.options", lambda path, params: ORDER_RAW)
    body = post(client, {"legs": [leg()], "order_type": "market"}).json()
    assert body["id"] == "opt-1"
    assert body["filled_qty"] == 0.0
    assert body["legs"] == []


# ---------------------------------------------------------------------------
# Multiple legs: an mleg combo with a net price
# ---------------------------------------------------------------------------


def test_multi_leg_builds_an_mleg_combo(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(
        client,
        {
            "legs": [leg(symbol=CALL_200, side="buy"), leg(symbol=CALL_210, side="sell", ratio_qty=1)],
            "qty": 2,
            "order_type": "limit",
            "limit_price": 3,
        },
    )

    assert response.status_code == 201
    body = calls[0][1]
    assert body["order_class"] == "mleg"
    assert body["limit_price"] == "3"
    assert body["qty"] == "2"
    assert "symbol" not in body and "side" not in body, "combo legs live in `legs`"
    assert body["legs"] == [
        {"symbol": CALL_200, "ratio_qty": "1", "side": "buy", "position_intent": "buy_to_open"},
        {"symbol": CALL_210, "ratio_qty": "1", "side": "sell", "position_intent": "sell_to_open"},
    ]


def test_multi_leg_uses_each_legs_ratio(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    post(
        client,
        {
            "legs": [leg(symbol=CALL_200, side="buy", ratio_qty=2), leg(symbol=CALL_210, side="sell", ratio_qty=3)],
            "order_type": "limit",
            "limit_price": 1.25,
        },
    )
    assert [item["ratio_qty"] for item in calls[0][1]["legs"]] == ["2", "3"]


def test_multi_leg_rejects_a_market_order(client, upstream):
    calls = upstream("app.options", lambda path: ORDER_RAW)
    response = post(
        client,
        {"legs": [leg(symbol=CALL_200), leg(symbol=CALL_210, side="sell")], "order_type": "market"},
    )
    assert response.status_code == 422
    assert "多腿期权请使用限价单" in response.json()["detail"]
    assert calls == []


# ---------------------------------------------------------------------------
# Rejections that must never reach Alpaca
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload, expected",
    [
        ({"legs": [leg()], "order_type": "limit"}, "需要填写净限价"),
        ({"legs": [leg(symbol=CALL_200), leg(symbol=CALL_210, side="sell")], "order_type": "limit"}, "需要填写净限价"),
        ({"legs": [leg()], "order_type": "market", "limit_price": 1.0}, "市价单不应包含限价"),
    ],
)
def test_price_rules_reject_before_submitting(client, upstream, payload, expected):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(client, payload)
    assert response.status_code == 422
    assert expected in response.json()["detail"]
    assert calls == []


def test_invalid_contract_symbol_is_rejected(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(client, {"legs": [leg(symbol="NOT-AN-OPTION-AT-ALL")], "order_type": "market"})
    assert response.status_code == 422
    assert "无效的期权代码" in response.json()["detail"]
    assert calls == []


def test_legs_must_belong_to_the_requested_underlying(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(client, {"legs": [leg(symbol="MSFT261120C00400000")], "order_type": "market"})
    assert response.status_code == 422
    assert "期权标的必须与当前股票一致" in response.json()["detail"]
    assert calls == []


def test_invalid_underlying_symbol_is_rejected(client, upstream):
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(client, {"legs": [leg()], "order_type": "market"}, symbol="1234")
    assert response.status_code == 422
    assert calls == []


def test_dotted_ticker_options_are_rejected_by_the_root_check(client, upstream):
    """Recorded limitation, not desired behaviour.

    Alpaca's OCC root drops the dot (`BRKB261120C00200000`) while the URL symbol keeps
    it (`BRK.B`), so the root comparison rejects contracts that are actually valid
    for `BRK.B` / `BF-B`. Fixing it needs a root→symbol mapping; until then this test
    documents the current answer.
    """
    calls = upstream("app.options", lambda path, params: ORDER_RAW)
    response = post(client, {"legs": [leg(symbol="BRKB261120C00200000")], "order_type": "market"}, symbol="BRK.B")
    assert response.status_code == 422
    assert calls == []


# ---------------------------------------------------------------------------
# Upstream errors
# ---------------------------------------------------------------------------


def test_upstream_400_becomes_422(client, upstream):
    def rejected(path, params):
        raise UpstreamError(400, "insufficient buying power", "http_400")

    upstream("app.options", rejected)
    response = post(client, {"legs": [leg()], "order_type": "market"})
    assert response.status_code == 422
    assert "insufficient buying power" in response.json()["detail"]


def test_upstream_500_becomes_502(client, upstream):
    def broken(path, params):
        raise UpstreamError(500, "boom", "http_500")

    upstream("app.options", broken)
    assert post(client, {"legs": [leg()], "order_type": "market"}).status_code == 502
