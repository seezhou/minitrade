"""Realtime stream decisions, tested without opening a socket.

These are the parts that used to be unreachable for tests: subscription diffs,
reconnect backoff, symbol cleaning and the trade window. They are pure functions in
`app/stream_logic.py`, so the hub threads only have to do I/O.
"""
from __future__ import annotations

import pytest

from app.stream_logic import (
    clean_symbols,
    new_trades,
    next_backoff,
    plan_crypto_subscriptions,
    plan_market_subscriptions,
    success_message,
)


# ---------------------------------------------------------------------------
# Backoff
# ---------------------------------------------------------------------------


def test_backoff_grows_geometrically():
    delay = 1.0
    seen = []
    for _ in range(4):
        seen.append(delay)
        delay = next_backoff(delay, factor=1.8, cap=20.0)
    assert seen == [1.0, 1.8, pytest.approx(3.24), pytest.approx(5.832)]


def test_backoff_stops_at_the_cap():
    delay = 1.0
    for _ in range(30):
        delay = next_backoff(delay, factor=1.8, cap=20.0)
    assert delay == 20.0
    assert next_backoff(delay, factor=1.8, cap=20.0) == 20.0, "capped values stay capped"


def test_crypto_backoff_uses_its_own_curve():
    assert next_backoff(10.0, factor=2, cap=30) == 20.0
    assert next_backoff(20.0, factor=2, cap=30) == 30.0


# ---------------------------------------------------------------------------
# Auth replies
# ---------------------------------------------------------------------------


def test_success_message_accepts_both_stream_dialects():
    assert success_message({"T": "success", "msg": "connected"})
    assert success_message({"stream": "authorization", "data": {"status": "authorized"}})


def test_success_message_reads_a_batch():
    assert success_message([{"T": "success", "msg": "connected"}, {"T": "subscription"}])
    assert not success_message([{"T": "error", "msg": "auth failed"}])


def test_success_message_rejects_errors_and_junk():
    assert not success_message({"T": "error", "msg": "not authorized"})
    assert not success_message({"stream": "authorization", "data": {"status": "unauthorized"}})
    assert not success_message({"stream": "authorization"})
    assert not success_message({})
    assert not success_message([])
    assert not success_message(None)
    assert not success_message("success")


# ---------------------------------------------------------------------------
# Symbol cleaning
# ---------------------------------------------------------------------------


def stock_resolver(value):
    text = str(value or "").strip().upper()
    return text if text.isalpha() and 1 <= len(text) <= 5 else None


def test_clean_symbols_normalises_and_deduplicates_in_order():
    assert clean_symbols([" msft ", "AAPL", "msft", "aapl"], stock_resolver) == ["MSFT", "AAPL"]


def test_clean_symbols_drops_what_the_resolver_rejects():
    assert clean_symbols(["AAPL", "", None, "BRK.B", "1234"], stock_resolver) == ["AAPL"]


def test_clean_symbols_caps_the_list():
    raw = [chr(65 + index % 26) * (1 + index // 26) for index in range(30)]
    assert len(clean_symbols(raw, stock_resolver, limit=28)) == 28
    assert clean_symbols(raw, stock_resolver, limit=28)[0] == "A", "first named stays first"


def test_clean_symbols_handles_empty_input():
    assert clean_symbols(None, stock_resolver) == []
    assert clean_symbols([], stock_resolver, limit=28) == []


# ---------------------------------------------------------------------------
# Market subscription plan
# ---------------------------------------------------------------------------


def test_first_subscription_asks_for_trades_then_focus():
    actions, state = plan_market_subscriptions({"AAPL"}, {"AAPL"}, {})
    assert actions == [
        {"action": "subscribe", "trades": ["AAPL"]},
        {"action": "subscribe", "quotes": ["AAPL"], "bars": ["AAPL"]},
    ]
    assert state == {"trades": {"AAPL"}, "quotes": {"AAPL"}, "bars": {"AAPL"}}


def test_non_focus_symbols_only_get_trades():
    actions, state = plan_market_subscriptions({"AAPL", "MSFT"}, {"AAPL"}, {})
    assert actions[0] == {"action": "subscribe", "trades": ["AAPL", "MSFT"]}
    assert actions[1] == {"action": "subscribe", "quotes": ["AAPL"], "bars": ["AAPL"]}
    assert state["trades"] == {"AAPL", "MSFT"}
    assert state["quotes"] == {"AAPL"}


def test_nothing_to_do_sends_nothing():
    current = {"trades": {"AAPL"}, "quotes": {"AAPL"}, "bars": {"AAPL"}}
    actions, state = plan_market_subscriptions({"AAPL"}, {"AAPL"}, current)
    assert actions == []
    assert state == {"trades": {"AAPL"}, "quotes": {"AAPL"}, "bars": {"AAPL"}}


def test_moving_the_focus_swaps_quotes_and_bars_only():
    current = {"trades": {"AAPL", "MSFT"}, "quotes": {"AAPL"}, "bars": {"AAPL"}}
    actions, state = plan_market_subscriptions({"AAPL", "MSFT"}, {"MSFT"}, current)
    assert actions == [
        {"action": "subscribe", "quotes": ["MSFT"], "bars": ["MSFT"]},
        {"action": "unsubscribe", "quotes": ["AAPL"], "bars": ["AAPL"]},
    ]
    assert state["quotes"] == {"MSFT"}
    assert state["trades"] == {"AAPL", "MSFT"}, "trades are untouched by focus"


def test_dropping_a_symbol_unsubscribes_every_channel():
    current = {"trades": {"AAPL"}, "quotes": {"AAPL"}, "bars": {"AAPL"}}
    actions, state = plan_market_subscriptions(set(), set(), current)
    assert actions == [
        {"action": "unsubscribe", "trades": ["AAPL"]},
        {"action": "unsubscribe", "quotes": ["AAPL"], "bars": ["AAPL"]},
    ]
    assert state == {"trades": set(), "quotes": set(), "bars": set()}


def test_focus_outside_the_wanted_set_gets_no_quotes():
    actions, state = plan_market_subscriptions({"AAPL"}, {"TSLA"}, {})
    assert actions == [{"action": "subscribe", "trades": ["AAPL"]}]
    assert state["quotes"] == set(), "an unfocused symbol must not burn quote slots"


def test_partial_channels_resubscribe_independently():
    current = {"trades": {"AAPL"}, "quotes": set(), "bars": {"AAPL"}}
    actions, _state = plan_market_subscriptions({"AAPL"}, {"AAPL"}, current)
    assert actions == [{"action": "subscribe", "quotes": ["AAPL"]}], "bars already held"


def test_subscriptions_are_sent_before_unsubscriptions():
    current = {"trades": {"OLD"}, "quotes": {"OLD"}, "bars": {"OLD"}}
    actions, _state = plan_market_subscriptions({"NEW"}, {"NEW"}, current)
    kinds = [item["action"] for item in actions]
    assert kinds == ["subscribe", "subscribe", "unsubscribe", "unsubscribe"]


# ---------------------------------------------------------------------------
# Crypto subscription plan
# ---------------------------------------------------------------------------


def test_crypto_subscribes_all_three_channels_together():
    actions, state = plan_crypto_subscriptions({"BTC/USD"}, set())
    assert actions == [{"action": "subscribe", "trades": ["BTC/USD"], "quotes": ["BTC/USD"], "bars": ["BTC/USD"]}]
    assert state == {"BTC/USD"}


def test_crypto_diffs_against_what_is_already_subscribed():
    actions, state = plan_crypto_subscriptions({"BTC/USD", "ETH/USD"}, {"BTC/USD"})
    assert actions == [{"action": "subscribe", "trades": ["ETH/USD"], "quotes": ["ETH/USD"], "bars": ["ETH/USD"]}]
    assert state == {"BTC/USD", "ETH/USD"}


def test_crypto_unsubscribes_dropped_pairs():
    actions, state = plan_crypto_subscriptions(set(), {"BTC/USD"})
    assert actions == [{"action": "unsubscribe", "trades": ["BTC/USD"], "quotes": ["BTC/USD"], "bars": ["BTC/USD"]}]
    assert state == set()


def test_crypto_is_idempotent_when_nothing_changes():
    actions, state = plan_crypto_subscriptions({"BTC/USD"}, {"BTC/USD"})
    assert actions == []
    assert state == {"BTC/USD"}


# ---------------------------------------------------------------------------
# Trade replay window
# ---------------------------------------------------------------------------


def bucket(count: int) -> list[dict]:
    return [{"seq": index, "price": float(index)} for index in range(1, count + 1)]


def test_new_trades_returns_only_unseen_items():
    trades, last = new_trades(bucket(10), 7)
    assert [item["seq"] for item in trades] == [8, 9, 10]
    assert last == 10


def test_new_trades_is_empty_when_nothing_is_new():
    trades, last = new_trades(bucket(5), 5)
    assert trades == []
    assert last == 5, "the cursor must not move"


def test_new_trades_caps_a_burst_but_keeps_the_cursor_current():
    trades, last = new_trades(bucket(60), 0)
    assert len(trades) == 20
    assert trades[-1]["seq"] == 60
    assert last == 60, "skipping the burst must not cause it to be replayed"


def test_new_trades_handles_an_empty_bucket():
    assert new_trades(None, 0) == ([], 0)
    assert new_trades([], 4) == ([], 4)


def test_reconnect_replays_the_whole_window():
    trades, last = new_trades(bucket(60), 0, limit=20)
    assert len(trades) == 20
    assert last == 60
