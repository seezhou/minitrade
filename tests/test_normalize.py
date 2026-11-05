"""Field normalisation.

`normalize_*` is the single boundary between raw Alpaca payloads and everything the
frontend sees. Missing or oddly typed fields must degrade to `None` / `0` instead of
raising, because Alpaca omits keys per asset class and per entitlement.
"""
from __future__ import annotations

from app.alpaca_api import (
    as_float,
    as_int,
    normalize_account,
    normalize_bar,
    normalize_news,
    normalize_order,
    normalize_position,
)


# ---------------------------------------------------------------------------
# Scalars
# ---------------------------------------------------------------------------


def test_as_float_accepts_strings_and_rejects_junk():
    assert as_float("12.5") == 12.5
    assert as_float(3) == 3.0
    assert as_float(None) is None
    assert as_float("") is None
    assert as_float("n/a") is None


def test_as_int_accepts_strings_and_rejects_junk():
    assert as_int("42") == 42
    assert as_int(None) is None
    assert as_int("n/a") is None


# ---------------------------------------------------------------------------
# Bars
# ---------------------------------------------------------------------------


def test_bar_maps_alpaca_short_keys():
    row = normalize_bar({"t": "2026-01-02T15:00:00Z", "o": "1.5", "h": "2", "l": "1", "c": "1.8", "v": "100", "vw": "1.7", "n": "12"})
    assert row == {
        "time": "2026-01-02T15:00:00Z",
        "open": 1.5,
        "high": 2.0,
        "low": 1.0,
        "close": 1.8,
        "volume": 100,
        "vwap": 1.7,
        "trades": 12,
    }


def test_bar_tolerates_missing_fields():
    row = normalize_bar({"t": "2026-01-02T15:00:00Z"})
    assert row["volume"] == 0
    assert row["trades"] is None
    assert row["close"] is None
    assert "symbol" not in row


def test_bar_only_adds_symbol_when_asked():
    assert normalize_bar({}, symbol="BTC/USD")["symbol"] == "BTC/USD"


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------


def test_order_normalises_nested_legs():
    raw = {
        "id": "ord-1",
        "symbol": "AAPL",
        "side": "buy",
        "qty": "2",
        "filled_qty": None,
        "status": "accepted",
        "order_class": "mleg",
        "legs": [
            {"symbol": "AAPL261120C00200000", "side": "buy", "qty": "1", "position_intent": "buy_to_open"},
            {"symbol": "AAPL261120C00210000", "side": "sell", "qty": "1"},
        ],
    }
    row = normalize_order(raw)
    assert row["qty"] == 2.0
    assert row["filled_qty"] == 0.0  # never None: the UI subtracts it
    assert [leg["symbol"] for leg in row["legs"]] == ["AAPL261120C00200000", "AAPL261120C00210000"]
    assert row["legs"][0]["position_intent"] == "buy_to_open"
    assert row["legs"][1]["position_intent"] is None


def test_order_without_legs_returns_an_empty_list():
    assert normalize_order({"id": "ord-2"})["legs"] == []


def test_order_coerces_extended_hours_to_bool():
    assert normalize_order({"extended_hours": "true"})["extended_hours"] is True
    assert normalize_order({})["extended_hours"] is False


# ---------------------------------------------------------------------------
# Positions
# ---------------------------------------------------------------------------


def test_position_keeps_quantity_and_cost_basis():
    row = normalize_position({"symbol": "AAPL", "qty": "10", "avg_entry_price": "150.5", "asset_class": "us_equity"})
    assert row["qty"] == 10.0
    assert row["avg_entry_price"] == 150.5
    assert row["side"] == "long"
    assert row["logo_url"] == "/api/stocks/AAPL/logo"


def test_negative_quantity_defaults_to_short_side():
    assert normalize_position({"symbol": "TSLA", "qty": "-3"})["side"] == "short"


def test_missing_quantity_becomes_zero_and_long():
    row = normalize_position({"symbol": "AAPL"})
    assert row["qty"] == 0.0
    assert row["side"] == "long"


def test_explicit_side_wins_over_quantity_sign():
    assert normalize_position({"symbol": "AAPL", "qty": "5", "side": "short"})["side"] == "short"


# ---------------------------------------------------------------------------
# Account
# ---------------------------------------------------------------------------


def test_account_derives_day_pl_from_equity():
    row = normalize_account({"equity": "1100", "last_equity": "1000"})
    assert row["day_pl"] == 100.0
    assert round(row["day_pl_pct"], 6) == 0.1


def test_account_day_pl_is_none_without_a_previous_equity():
    assert normalize_account({"equity": "1100"})["day_pl"] is None
    assert normalize_account({"equity": "1100", "last_equity": "0"})["day_pl"] is None


def test_account_defaults_currency_and_booleans():
    row = normalize_account({})
    assert row["currency"] == "USD"
    assert row["pattern_day_trader"] is False
    assert row["equity"] is None


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------


def test_news_strips_html_from_content():
    raw = {
        "headline": "Apple &amp; co",
        "summary": "&lt;b&gt;move&lt;/b&gt;",
        "content": "<style>.x{}</style><p>Hello</p><script>alert(1)</script><div>world</div>",
        "images": [{"url": "https://example.com/a.png"}],
    }
    row = normalize_news(raw, include_content=True)
    assert row["headline"] == "Apple & co"
    assert row["summary"] == "<b>move</b>"
    assert "alert" not in row["content"]
    assert "Hello" in row["content"] and "world" in row["content"]
    assert row["image"] == "https://example.com/a.png"


def test_news_content_is_omitted_by_default():
    assert normalize_news({"content": "<p>hi</p>"})["content"] is None


def test_news_without_images_has_no_image():
    row = normalize_news({"headline": "x"})
    assert row["image"] is None
    assert row["images"] == []
    assert row["source"] == "Alpaca"
