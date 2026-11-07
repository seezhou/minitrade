"""TTL cache behaviour: expiry, stale fallback, and the LRU cap.

The cache is in-process state, so these tests build their own instance instead of
touching the module-level `cache` the routes share.
"""
from __future__ import annotations

import pytest

from app.cache import TTLCache


def test_entries_expire_after_the_ttl():
    store = TTLCache()
    store.set("k", "v")
    assert store.get("k", 60) == "v"
    assert store.get("k", -1) is None


def test_lru_evicts_the_least_recently_used_entry_when_full():
    store = TTLCache(max_entries=2)
    store.set("a", 1)
    store.set("b", 2)
    assert store.get("a", 60) == 1, "reading a makes it the most recent"
    store.set("c", 3)
    assert store.peek("a") == 1
    assert store.peek("b") is None, "b was unused for the longest time"
    assert store.peek("c") == 3
    assert len(store) == 2


def test_stale_fallback_returns_the_expired_value_after_a_failure():
    store = TTLCache()
    store.set("k", "old")

    def boom():
        raise RuntimeError("upstream down")

    assert store.get_or_set("k", -1, boom, stale_ttl=60) == "old"


def test_stale_fallback_still_raises_once_the_stale_window_passes():
    store = TTLCache()
    store.set("k", "old")

    def boom():
        raise RuntimeError("upstream down")

    with pytest.raises(RuntimeError):
        store.get_or_set("k", -1, boom, stale_ttl=-1)


def test_invalidate_clears_by_prefix_or_everything():
    store = TTLCache()
    store.set("bars:AAPL", 1)
    store.set("bars:MSFT", 2)
    store.set("news:AAPL", 3)
    store.invalidate("bars:")
    assert store.peek("bars:AAPL") is None
    assert store.peek("news:AAPL") == 3
    store.invalidate()
    assert len(store) == 0


def test_capacity_is_never_exceeded_under_churn():
    store = TTLCache(max_entries=5)
    for index in range(100):
        store.set(f"k{index}", index)
    assert len(store) == 5
    assert store.peek("k99") == 99
    assert store.peek("k0") is None
