"""Pure helpers shared by the realtime bridges.

Everything in this module is side-effect free — no sockets, no threads, no asyncio.
`streams.py` and `crypto_stream.py` do the I/O and delegate the decisions here, which
is what makes the parts that actually break (差量订阅、重连退避、成交窗口、符号清洗)
testable without opening a connection.

Symbol validation is injected by the caller: stocks go through `valid_symbol` and
crypto pairs through `crypto_symbol`, so this module never imports either.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable, Sequence


def next_backoff(current: float, *, factor: float, cap: float) -> float:
    """Grow a reconnect delay geometrically and stop at `cap`."""
    return min(current * factor, cap)


def success_message(message: Any) -> bool:
    """True when an upstream auth reply means "authorized".

    Alpaca answers the data streams with `{"T": "success"}`, while the paper trade
    stream uses `{"stream": "authorization", "data": {"status": "authorized"}}`.
    """
    if isinstance(message, list):
        return any(isinstance(item, dict) and item.get("T") == "success" for item in message)
    if isinstance(message, dict):
        if message.get("T") == "success":
            return True
        if message.get("stream") == "authorization":
            data = message.get("data") or {}
            return data.get("status") == "authorized"
    return False


def clean_symbols(
    raw: Iterable[Any] | None,
    resolve: Callable[[Any], str | None],
    limit: int | None = None,
) -> list[str]:
    """Normalise, de-duplicate and cap a browser-supplied symbol list.

    Order is preserved so the first symbol a user names stays first. `resolve`
    returns the canonical symbol or None for anything unusable.
    """
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in raw or ():
        symbol = resolve(item)
        if symbol and symbol not in seen:
            seen.add(symbol)
            cleaned.append(symbol)
    return cleaned[:limit] if limit is not None else cleaned


def plan_market_subscriptions(
    desired: Iterable[str],
    focus: Iterable[str],
    current: dict[str, Iterable[str]],
) -> tuple[list[dict], dict[str, set[str]]]:
    """Work out the upstream messages needed to reach the desired subscription set.

    Only the focused symbol gets quotes and bars (Alpaca caps subscription counts);
    every other symbol is trades-only. Returns the messages in send order plus the
    state the caller should remember for the next diff.
    """
    wanted = set(desired)
    focused = set(focus) & wanted
    trades = set(current.get("trades") or ())
    quotes = set(current.get("quotes") or ())
    bars = set(current.get("bars") or ())

    add_trades = wanted - trades
    remove_trades = trades - wanted
    add_quotes = focused - quotes
    remove_quotes = quotes - focused
    add_bars = focused - bars
    remove_bars = bars - focused

    actions: list[dict] = []
    if add_trades:
        actions.append({"action": "subscribe", "trades": sorted(add_trades)})
    if add_quotes or add_bars:
        payload: dict[str, Any] = {"action": "subscribe"}
        if add_quotes:
            payload["quotes"] = sorted(add_quotes)
        if add_bars:
            payload["bars"] = sorted(add_bars)
        actions.append(payload)
    if remove_trades:
        actions.append({"action": "unsubscribe", "trades": sorted(remove_trades)})
    if remove_quotes or remove_bars:
        payload = {"action": "unsubscribe"}
        if remove_quotes:
            payload["quotes"] = sorted(remove_quotes)
        if remove_bars:
            payload["bars"] = sorted(remove_bars)
        actions.append(payload)

    return actions, {"trades": wanted, "quotes": focused, "bars": focused}


def plan_crypto_subscriptions(
    desired: Iterable[str],
    current: Iterable[str],
) -> tuple[list[dict], set[str]]:
    """Crypto subscribes trades, quotes and bars together, so the diff is one set."""
    wanted = set(desired)
    subscribed = set(current)

    add = sorted(wanted - subscribed)
    remove = sorted(subscribed - wanted)

    actions: list[dict] = []
    if add:
        actions.append({"action": "subscribe", "trades": add, "quotes": add, "bars": add})
    if remove:
        actions.append({"action": "unsubscribe", "trades": remove, "quotes": remove, "bars": remove})

    return actions, wanted


def new_trades(
    bucket: Sequence[dict] | None,
    last_seq: int,
    limit: int = 20,
) -> tuple[list[dict], int]:
    """Take the newest unseen trades from a rolling bucket.

    Returns at most `limit` trades plus the sequence number the caller should store.
    Reconnect sets `last_seq` back to 0, so a resend replays the whole window.
    """
    fresh = [item for item in (bucket or ()) if item.get("seq", 0) > last_seq]
    if not fresh:
        return [], last_seq
    return fresh[-limit:], fresh[-1]["seq"]
