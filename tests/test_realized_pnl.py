"""Realized P&L derivation.

`_derive_realized` is the only place that invents numbers out of Alpaca activities,
so the rules it encodes matter: average cost, never guess an unknown basis, and
report `null` (plus a warning) instead of a fabricated profit.
"""
from __future__ import annotations

import pytest

from app.trading import _derive_realized


def fill(symbol: str, side: str, qty: float, price: float, at: str = "2026-01-02T15:00:00Z") -> dict:
    return {
        "activity_type": "FILL",
        "symbol": symbol,
        "side": side,
        "qty": str(qty),
        "price": str(price),
        "transaction_time": at,
    }


def only(symbols: list[dict]) -> dict:
    assert len(symbols) == 1
    return symbols[0]


# ---------------------------------------------------------------------------
# Average cost
# ---------------------------------------------------------------------------


def test_round_trip_uses_the_purchase_price():
    symbols, total, known, warnings = _derive_realized([fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 10, 110)])
    row = only(symbols)
    assert row["realized_pl"] == 100.0
    assert row["open_qty"] == 0.0
    assert (total, known, warnings) == (100.0, True, [])


def test_multiple_buys_are_averaged():
    fills = [fill("AAPL", "buy", 10, 100), fill("AAPL", "buy", 10, 120), fill("AAPL", "sell", 20, 130)]
    row = only(_derive_realized(fills)[0])
    # average 110 -> (130 - 110) * 20
    assert row["realized_pl"] == 400.0


def test_partial_sell_keeps_the_remaining_cost_basis():
    fills = [fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 4, 105)]
    symbols, total, known, _warnings = _derive_realized(fills)
    row = only(symbols)
    assert row["realized_pl"] == 20.0
    assert row["open_qty"] == 6.0
    assert row["buy_qty"] == 10.0
    assert row["sell_qty"] == 4.0
    assert total == 20.0 and known is True


def test_second_partial_sell_still_uses_the_original_average():
    fills = [fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 5, 110), fill("AAPL", "sell", 5, 120)]
    row = only(_derive_realized(fills)[0])
    assert row["realized_pl"] == 150.0  # 50 + 100
    assert row["open_qty"] == 0.0


# ---------------------------------------------------------------------------
# Unknown basis must stay unknown
# ---------------------------------------------------------------------------


def test_sell_without_a_buy_is_null_not_zero():
    symbols, total, known, warnings = _derive_realized([fill("AAPL", "sell", 10, 110)])
    row = only(symbols)
    assert row["realized_pl"] is None
    assert row["reason"]
    assert total == 0.0
    assert known is False
    assert warnings and "AAPL" in warnings[0]


def test_sell_of_more_than_held_marks_the_symbol_unknown():
    fills = [fill("AAPL", "buy", 5, 100), fill("AAPL", "sell", 10, 110)]
    row = only(_derive_realized(fills)[0])
    assert row["realized_pl"] is None
    assert row["sell_qty"] == 10.0


def test_short_cover_does_not_retroactively_create_a_basis():
    fills = [fill("AAPL", "sell", 10, 100), fill("AAPL", "buy", 10, 90)]
    row = only(_derive_realized(fills)[0])
    assert row["realized_pl"] is None


def test_known_symbols_still_count_when_another_is_unknown():
    fills = [
        fill("AAPL", "buy", 10, 100),
        fill("AAPL", "sell", 10, 110),
        fill("MSFT", "sell", 5, 300),
    ]
    symbols, total, known, warnings = _derive_realized(fills)
    assert known is True
    assert total == 100.0
    assert len(warnings) == 1
    # unknown symbols sort last
    assert [row["symbol"] for row in symbols] == ["AAPL", "MSFT"]


def test_symbols_sort_by_realized_pnl_descending():
    fills = [
        fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 10, 110),
        fill("MSFT", "buy", 10, 100), fill("MSFT", "sell", 10, 140),
        fill("TSLA", "sell", 1, 200),
    ]
    symbols = _derive_realized(fills)[0]
    assert [row["symbol"] for row in symbols] == ["MSFT", "AAPL", "TSLA"]


# ---------------------------------------------------------------------------
# Input hygiene
# ---------------------------------------------------------------------------


def test_rows_are_sorted_by_transaction_time_before_matching():
    fills = [
        fill("AAPL", "sell", 10, 110, at="2026-01-03T15:00:00Z"),
        fill("AAPL", "buy", 10, 100, at="2026-01-02T15:00:00Z"),
    ]
    row = only(_derive_realized(fills)[0])
    assert row["realized_pl"] == 100.0


@pytest.mark.parametrize(
    "row",
    [
        {"activity_type": "FILL", "side": "buy", "qty": "1", "price": "10"},          # no symbol
        {"activity_type": "FILL", "symbol": "AAPL", "side": "hold", "qty": "1"},      # bad side
        {"activity_type": "FILL", "symbol": "AAPL", "side": "buy", "qty": "0"},       # zero qty
        {"activity_type": "FILL", "symbol": "AAPL", "side": "buy", "qty": "-5"},      # negative qty
    ],
)
def test_invalid_rows_are_ignored(row):
    symbols, total, known, warnings = _derive_realized([row])
    assert (symbols, total, known, warnings) == ([], 0.0, False, [])


def test_empty_input_returns_an_empty_result():
    assert _derive_realized([]) == ([], 0.0, False, [])


def test_symbols_are_normalised_to_uppercase():
    row = only(_derive_realized([fill("aapl", "buy", 1, 10), fill("aapl", "sell", 1, 12)])[0])
    assert row["symbol"] == "AAPL"
    assert row["realized_pl"] == 2.0


# ---------------------------------------------------------------------------
# Route wiring
# ---------------------------------------------------------------------------


def test_route_splits_fills_dividends_and_interest(client, upstream):
    rows = [
        fill("AAPL", "buy", 10, 100),
        fill("AAPL", "sell", 10, 110),
        {"activity_type": "DIV", "net_amount": "12.50", "symbol": "AAPL"},
        {"activity_type": "INT", "net_amount": "3.25"},
    ]
    upstream("app.trading", lambda path, params: rows)

    response = client.get("/api/account/realized-pnl?days=30")
    assert response.status_code == 200
    body = response.json()
    assert body["total_realized_pl"] == 100.0
    assert body["dividend_income"] == 12.5
    assert body["interest_income"] == 3.25
    assert body["available"] is True
    assert body["method"] == "average_cost_from_fills"


def test_route_reports_an_empty_account_without_error(client, upstream):
    upstream("app.trading", lambda path, params: [])
    response = client.get("/api/account/realized-pnl?days=30")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["symbols"] == []
    assert body["total_realized_pl"] == 0.0


def test_route_rejects_a_backwards_window(client, upstream):
    upstream("app.trading", lambda path, params: [])
    response = client.get("/api/account/realized-pnl?after=2026-02-01T00:00:00Z&until=2026-01-01T00:00:00Z")
    assert response.status_code == 422


def test_route_rejects_an_unparsable_date(client, upstream):
    upstream("app.trading", lambda path, params: [])
    response = client.get("/api/account/realized-pnl?after=not-a-date")
    assert response.status_code == 422
