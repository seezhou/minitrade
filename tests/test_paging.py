"""Upstream page merging.

Alpaca serves long bar ranges in pages far smaller than the requested limit. When
paging was missing, 1Y of crypto bars silently rendered as a single day, so these
rules are worth pinning down.
"""
from __future__ import annotations

import logging

from app.crypto import _paged_crypto_bars
from app.market import _paged_bars


def bar(stamp: str, close: str = "100") -> dict:
    return {"t": stamp, "o": "1", "h": "2", "l": "1", "c": close, "v": "10"}


def pages_handler(pages: list[dict], *, path: str | None = None):
    """Serve canned pages in order; the last page is repeated if a test asks for more."""
    queue = list(pages)

    def handler(request_path, params):
        if path:
            assert request_path == path
        return queue.pop(0) if queue else {"bars": {}}

    return handler


# ---------------------------------------------------------------------------
# Crypto bars
# ---------------------------------------------------------------------------


def test_crypto_single_page_passes_through(upstream):
    upstream("app.crypto", pages_handler([{"bars": {"BTC/USD": [bar("2026-01-01T00:00:00Z")]}}]))
    rows = _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z")
    assert len(rows) == 1
    assert rows[0]["c"] == "100"


def test_crypto_pages_are_merged_sorted_and_deduplicated(upstream):
    upstream(
        "app.crypto",
        pages_handler(
            [
                {"bars": {"BTC/USD": [bar("2026-01-02T00:00:00Z"), bar("2026-01-01T00:00:00Z")]}, "next_page_token": "p2"},
                {"bars": {"BTC/USD": [bar("2026-01-03T00:00:00Z"), bar("2026-01-02T00:00:00Z", close="999")]}},
            ]
        ),
    )
    rows = _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z")
    assert [row["t"] for row in rows] == [
        "2026-01-01T00:00:00Z",
        "2026-01-02T00:00:00Z",
        "2026-01-03T00:00:00Z",
    ]
    # the first page wins for a duplicated timestamp
    assert rows[1]["c"] == "100"


def test_crypto_sends_start_without_a_page_token_on_the_first_call(upstream):
    calls = upstream("app.crypto", pages_handler([{"bars": {"BTC/USD": [bar("2026-01-01T00:00:00Z")]}}]))
    _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z")
    assert calls[0][1]["start"] == "2025-12-01T00:00:00Z"
    assert "page_token" not in calls[0][1]


def test_crypto_passes_the_token_on_followup_calls(upstream):
    calls = upstream(
        "app.crypto",
        pages_handler(
            [
                {"bars": {"BTC/USD": [bar("2026-01-01T00:00:00Z")]}, "next_page_token": "p2"},
                {"bars": {"BTC/USD": [bar("2026-01-02T00:00:00Z")]}},
            ]
        ),
    )
    _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z")
    assert "page_token" not in calls[0][1]
    assert calls[1][1]["page_token"] == "p2"


def test_crypto_stops_at_max_pages_and_warns(upstream, caplog):
    calls = upstream(
        "app.crypto",
        lambda path, params: {"bars": {"BTC/USD": [bar("2026-01-01T00:00:00Z")]}, "next_page_token": "forever"},
    )
    with caplog.at_level(logging.WARNING, logger="minitrade.crypto"):
        rows = _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z", max_pages=3)
    assert len(calls) == 3
    assert len(rows) == 1
    assert "max_pages" in caplog.text


def test_crypto_handles_an_empty_response(upstream):
    upstream("app.crypto", pages_handler([{"bars": {}}]))
    assert _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z") == []


def test_crypto_ignores_other_symbols_in_the_payload(upstream):
    upstream("app.crypto", pages_handler([{"bars": {"ETH/USD": [bar("2026-01-01T00:00:00Z")]}}]))
    assert _paged_crypto_bars("BTC/USD", "1Hour", "2025-12-01T00:00:00Z") == []


# ---------------------------------------------------------------------------
# Stock bars
# ---------------------------------------------------------------------------


def test_stock_bars_stop_after_a_page_without_a_token(upstream):
    calls = upstream("app.market", pages_handler([{"bars": {"AAPL": [bar("2026-01-01T00:00:00Z")]}}]))
    out = _paged_bars({"symbols": "AAPL", "timeframe": "1Day"}, 10)
    assert len(calls) == 1
    assert len(out["bars"]["AAPL"]) == 1
    assert out["next_page_token"] is None


def test_stock_bars_merge_pages_across_symbols(upstream):
    upstream(
        "app.market",
        pages_handler(
            [
                {"bars": {"AAPL": [bar("2026-01-01T00:00:00Z")]}, "next_page_token": "p2"},
                {"bars": {"AAPL": [bar("2026-01-02T00:00:00Z")], "MSFT": [bar("2026-01-01T00:00:00Z")]}},
            ]
        ),
    )
    out = _paged_bars({"symbols": "AAPL,MSFT", "timeframe": "1Day"}, 10)
    assert len(out["bars"]["AAPL"]) == 2
    assert len(out["bars"]["MSFT"]) == 1
    assert out["next_page_token"] is None


def test_stock_bars_forwards_the_page_token(upstream):
    calls = upstream(
        "app.market",
        pages_handler(
            [
                {"bars": {"AAPL": [bar("2026-01-01T00:00:00Z")]}, "next_page_token": "p2"},
                {"bars": {"AAPL": [bar("2026-01-02T00:00:00Z")]}, "next_page_token": "p3"},
            ]
        ),
    )
    out = _paged_bars({"symbols": "AAPL", "timeframe": "1Day"}, 2)
    assert calls[1][1]["page_token"] == "p2"
    # the last page's token is surfaced so callers know data may be incomplete
    assert out["next_page_token"] == "p3"


def test_stock_bars_keep_the_original_params_untouched(upstream):
    calls = upstream("app.market", pages_handler([{"bars": {}}]))
    params = {"symbols": "AAPL", "timeframe": "1Day"}
    _paged_bars(params, 3)
    assert params == {"symbols": "AAPL", "timeframe": "1Day"}
    assert calls[0][1] == {"symbols": "AAPL", "timeframe": "1Day"}
