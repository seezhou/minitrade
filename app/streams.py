"""Real-time bridges: one delayed SIP market stream and one paper trade-update stream.

Browser clients share the upstream connections. The market bridge coalesces ticks
into ~400ms batches so many symbols can update the UI without flooding it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .alpaca_api import as_float, as_int, iso
from .config import (
    DATA_FEED,
    DATA_FEED_LABEL,
    MAX_STREAM_SYMBOLS,
    MARKET_STREAM_URL,
    TRADE_STREAM_URL,
    credentials,
    valid_symbol,
)
from .stream_logic import (
    clean_symbols,
    new_trades,
    next_backoff,
    plan_market_subscriptions,
    success_message,
)

log = logging.getLogger("minitrade.streams")
router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _market_symbol(value: Any) -> str | None:
    """Canonical stock symbol for the stream, or None when it is not tradable."""
    symbol = str(value or "").strip().upper()
    return symbol if valid_symbol(symbol) else None


@dataclass
class _Client:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue
    symbols: set[str] = field(default_factory=set)
    focus: str | None = None
    last_trade_seq: int = 0


class MarketHub:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: dict[int, _Client] = {}
        self._next_id = 1
        self._refs: Counter[str] = Counter()
        self._latest: dict[str, dict] = {}
        self._dirty: set[str] = set()
        self._trades: dict[str, deque] = {}
        self._seq = 0
        self._status = {
            "type": "status",
            "state": "idle",
            "message": "实时行情尚未连接",
            "feed": DATA_FEED,
            "feed_label": DATA_FEED_LABEL,
            "delay_minutes": 15,
        }
        self._upstream: _MarketUpstream | None = None
        self._stopping = threading.Event()
        self._flusher = threading.Thread(target=self._flush_loop, name="market-flush", daemon=True)
        self._flusher.start()

    # -- client management -------------------------------------------------
    def add_client(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> int:
        with self._lock:
            client_id = self._next_id
            self._next_id += 1
            self._clients[client_id] = _Client(loop=loop, queue=queue)
            self._enqueue(queue, self._status)
        return client_id

    def remove_client(self, client_id: int) -> None:
        with self._lock:
            client = self._clients.pop(client_id, None)
            if client:
                for symbol in client.symbols:
                    self._release(symbol)

    def update_client(self, client_id: int, symbols: list[str], focus: str | None = None) -> None:
        cleaned = clean_symbols(symbols, _market_symbol, MAX_STREAM_SYMBOLS)
        with self._lock:
            client = self._clients.get(client_id)
            if not client:
                return
            previous = set(client.symbols)
            target = set(cleaned)
            for symbol in previous - target:
                self._release(symbol)
            for symbol in target - previous:
                self._refs[symbol] += 1
            client.symbols = target
            if focus is not None:
                client.focus = _market_symbol(focus)
                if client.focus:
                    trades = self._trades.get(client.focus)
                    client.last_trade_seq = trades[-1]["seq"] if trades else 0
            current = self._latest_for(client)
            self._enqueue(client.queue, {"type": "snapshot", "at": _now(), "ticks": current})
            self._enqueue(client.queue, self._status)
            self._ensure_upstream()

    def _release(self, symbol: str) -> None:
        if self._refs[symbol] > 0:
            self._refs[symbol] -= 1
        if self._refs[symbol] <= 0:
            self._refs.pop(symbol, None)
            self._latest.pop(symbol, None)

    def desired_symbols(self) -> set[str]:
        with self._lock:
            return {symbol for symbol, count in self._refs.items() if count > 0}

    def has_symbols(self) -> bool:
        return bool(self.desired_symbols())

    def focus_symbols(self) -> set[str]:
        """Only the focused symbol needs quotes and bars; everything else uses trades."""
        with self._lock:
            for client in self._clients.values():
                if client.focus and client.focus in client.symbols:
                    return {client.focus}
        return set()

    def current_client(self, client_id: int) -> _Client | None:
        with self._lock:
            return self._clients.get(client_id)

    def _ensure_upstream(self) -> None:
        if self._upstream and self._upstream.is_alive():
            return
        self._upstream = _MarketUpstream(self)
        self._upstream.start()

    # -- upstream callbacks ------------------------------------------------
    def on_trade(self, message: dict) -> None:
        symbol = message.get("S")
        price = as_float(message.get("p"))
        if not symbol or price is None:
            return
        with self._lock:
            state = self._latest.setdefault(symbol, {})
            state["price"] = price
            state["size"] = as_int(message.get("s"))
            state["ts"] = iso(message.get("t"))
            state["exchange"] = message.get("x")
            self._seq += 1
            trade = {
                "seq": self._seq,
                "price": price,
                "size": as_int(message.get("s")),
                "ts": iso(message.get("t")),
                "exchange": message.get("x"),
            }
            bucket = self._trades.setdefault(symbol, deque(maxlen=60))
            bucket.append(trade)
            self._dirty.add(symbol)

    def on_quote(self, message: dict) -> None:
        symbol = message.get("S")
        if not symbol:
            return
        with self._lock:
            state = self._latest.setdefault(symbol, {})
            state["bid"] = as_float(message.get("bp"))
            state["ask"] = as_float(message.get("ap"))
            state["bid_size"] = as_int(message.get("bs"))
            state["ask_size"] = as_int(message.get("as"))
            state["quote_ts"] = iso(message.get("t"))
            self._dirty.add(symbol)

    def on_bar(self, message: dict) -> None:
        symbol = message.get("S")
        close = as_float(message.get("c"))
        if not symbol or close is None:
            return
        with self._lock:
            state = self._latest.setdefault(symbol, {})
            state["bar"] = {
                "time": iso(message.get("t")),
                "open": as_float(message.get("o")),
                "high": as_float(message.get("h")),
                "low": as_float(message.get("l")),
                "close": close,
                "volume": as_int(message.get("v")) or 0,
                "vwap": as_float(message.get("vw")),
            }
            state["price"] = close
            state["ts"] = iso(message.get("t"))
            self._dirty.add(symbol)

    def set_status(self, state: str, message: str) -> None:
        log.info("market stream status -> %s (%s)", state, message)
        with self._lock:
            self._status = {
                "type": "status",
                "state": state,
                "message": message,
                "feed": DATA_FEED,
                "feed_label": DATA_FEED_LABEL,
                "delay_minutes": 15,
                "at": _now(),
            }
            clients = list(self._clients.values())
        for client in clients:
            self._enqueue(client.queue, self._status)

    # -- fan-out -----------------------------------------------------------
    def _latest_for(self, client: _Client) -> dict:
        return {
            symbol: dict(self._latest.get(symbol) or {})
            for symbol in client.symbols
            if self._latest.get(symbol)
        }

    def _flush_loop(self) -> None:
        while not self._stopping.is_set():
            time.sleep(0.4)
            try:
                self._flush()
            except Exception:
                log.exception("market flush failed")

    def _flush(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            dirty = set(self._dirty)
            self._dirty.clear()
            clients = list(self._clients.values())

        for client in clients:
            symbols = dirty & client.symbols
            if not symbols:
                continue
            with self._lock:
                ticks = {symbol: dict(self._latest.get(symbol) or {}) for symbol in symbols if self._latest.get(symbol)}
                trades: list[dict] = []
                if client.focus:
                    trades, client.last_trade_seq = new_trades(
                        self._trades.get(client.focus), client.last_trade_seq
                    )
            if not ticks and not trades:
                continue
            payload = {"type": "ticks", "at": _now(), "ticks": ticks}
            if trades:
                payload["trades"] = trades
                payload["focus"] = client.focus
            self._enqueue(client.queue, payload)

    def _enqueue(self, queue: asyncio.Queue, payload: dict) -> None:
        loop = self._loop_for(queue)
        if loop is None:
            return

        def put() -> None:
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:
            pass

    def _loop_for(self, queue: asyncio.Queue):
        for client in list(self._clients.values()):
            if client.queue is queue:
                return client.loop
        return None

    def stop(self) -> None:
        self._stopping.set()
        if self._upstream:
            self._upstream.stop()
        with self._lock:
            self._clients.clear()
            self._refs.clear()


class _MarketUpstream(threading.Thread):
    def __init__(self, hub: MarketHub) -> None:
        super().__init__(name="alpaca-market-stream", daemon=True)
        self.hub = hub
        self._stop_event = threading.Event()
        self._trades: set[str] = set()
        self._quotes: set[str] = set()
        self._bars: set[str] = set()

    def stop(self) -> None:
        self._stop_event.set()

    def _send(self, ws, payload: dict) -> None:
        ws.send(json.dumps(payload))

    def _sync_subscriptions(self, ws) -> None:
        actions, state = plan_market_subscriptions(
            self.hub.desired_symbols(),
            self.hub.focus_symbols(),
            {"trades": self._trades, "quotes": self._quotes, "bars": self._bars},
        )
        for payload in actions:
            self._send(ws, payload)
        self._trades = state["trades"]
        self._quotes = state["quotes"]
        self._bars = state["bars"]

    def run(self) -> None:
        from websockets.sync.client import connect

        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                key, secret = credentials()
                self.hub.set_status("connecting", "正在连接 Alpaca 实时行情…")
                with connect(MARKET_STREAM_URL, open_timeout=15, close_timeout=5, max_size=16 * 1024 * 1024, ping_interval=20) as ws:
                    self._send(ws, {"action": "auth", "key": key, "secret": secret})
                    first = json.loads(ws.recv(timeout=15))
                    if not success_message(first):
                        raise RuntimeError("Alpaca 实时行情认证失败")
                    self._trades = set()
                    self._quotes = set()
                    self._bars = set()
                    self.hub.set_status("connected", "延迟 SIP 行情流已连接")
                    backoff = 1.0
                    last_subscription_sync = 0.0
                    while not self._stop_event.is_set():
                        now = time.monotonic()
                        if now - last_subscription_sync > 0.5:
                            self._sync_subscriptions(ws)
                            last_subscription_sync = now
                        try:
                            raw = ws.recv(timeout=0.5)
                        except TimeoutError:
                            continue
                        try:
                            messages = json.loads(raw)
                        except (TypeError, ValueError):
                            continue
                        if isinstance(messages, dict):
                            messages = [messages]
                        for message in messages:
                            kind = message.get("T")
                            if kind == "t":
                                self.hub.on_trade(message)
                            elif kind == "q":
                                self.hub.on_quote(message)
                            elif kind == "b":
                                self.hub.on_bar(message)
                            elif kind == "error":
                                log.warning("market stream error: %s", message.get("msg"))
                                self.hub.set_status("error", str(message.get("msg") or "实时行情返回错误"))
            except Exception as exc:
                log.warning("market stream disconnected: %s", exc)
                self.hub.set_status("reconnecting", "实时行情连接中断，正在重连…")
                if self._stop_event.wait(min(backoff, 20.0)):
                    break
                backoff = next_backoff(backoff, factor=1.8, cap=20.0)


class TradeUpdateHub:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self._latest: list[dict] = []
        self._thread: _TradeUpstream | None = None
        self._status = {"type": "order_status", "state": "idle", "message": "订单更新流尚未连接"}

    def add_client(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        with self._lock:
            self._clients.append((loop, queue))
            history = self._latest[-20:]
            self._thread = self._thread or _TradeUpstream(self)
            if not self._thread.is_alive():
                self._thread.start()
            queue_loop = loop
        for event in history:
            self._send_to(queue_loop, queue, event)
        self._send_to(queue_loop, queue, self._status)

    def remove_client(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        with self._lock:
            self._clients = [(l, q) for l, q in self._clients if not (l is loop and q is queue)]

    def on_event(self, event: dict) -> None:
        payload = {"type": "order_update", "at": _now(), **event}
        with self._lock:
            self._latest = (self._latest + [payload])[-50:]
            clients = list(self._clients)
        for loop, queue in clients:
            self._send_to(loop, queue, payload)

    def set_status(self, state: str, message: str) -> None:
        with self._lock:
            self._status = {"type": "order_status", "state": state, "message": message}
            clients = list(self._clients)
        for loop, queue in clients:
            self._send_to(loop, queue, self._status)

    def _send_to(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, payload: dict) -> None:
        if loop.is_closed():
            return

        def put() -> None:
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass

        try:
            loop.call_soon_threadsafe(put)
        except RuntimeError:
            pass


class _TradeUpstream(threading.Thread):
    def __init__(self, hub: TradeUpdateHub) -> None:
        super().__init__(name="alpaca-trade-updates", daemon=True)
        self.hub = hub
        self._stop_event = threading.Event()

    def run(self) -> None:
        from websockets.sync.client import connect

        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                key, secret = credentials()
                self.hub.set_status("connecting", "正在连接订单更新流…")
                with connect(TRADE_STREAM_URL, open_timeout=15, close_timeout=5, ping_interval=20) as ws:
                    ws.send(json.dumps({"action": "auth", "key": key, "secret": secret}))
                    if not success_message(json.loads(ws.recv(timeout=15))):
                        raise RuntimeError("订单更新流认证失败")
                    ws.send(json.dumps({"action": "listen", "data": {"streams": ["trade_updates"]}}))
                    self.hub.set_status("connected", "订单更新流已连接")
                    backoff = 1.0
                    while not self._stop_event.is_set():
                        try:
                            raw = ws.recv(timeout=1)
                        except TimeoutError:
                            continue
                        message = json.loads(raw)
                        if message.get("stream") == "trade_updates":
                            data = message.get("data") or {}
                            event = {
                                "event": data.get("event"),
                                "order": data.get("order"),
                                "execution_id": data.get("execution_id"),
                                "timestamp": data.get("timestamp"),
                            }
                            self.hub.on_event(event)
            except Exception as exc:
                log.warning("trade update stream disconnected: %s", exc)
                self.hub.set_status("reconnecting", "订单更新流中断，正在重连…")
                if self._stop_event.wait(min(backoff, 20.0)):
                    break
                backoff = next_backoff(backoff, factor=1.8, cap=20.0)


market_hub = MarketHub()
trade_hub = TradeUpdateHub()


@router.websocket("/ws/market")
async def market_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=120)
    client_id = market_hub.add_client(loop, queue)

    async def sender() -> None:
        while True:
            payload = await queue.get()
            await websocket.send_json(payload)

    async def receiver() -> None:
        while True:
            message = await websocket.receive_json()
            action = message.get("action")
            if action == "subscribe":
                symbols = message.get("symbols") or []
                focus = message.get("focus")
                if not isinstance(symbols, list):
                    continue
                market_hub.update_client(client_id, [str(item) for item in symbols], focus)
            elif action == "focus":
                focus = message.get("symbol")
                current = market_hub.current_client(client_id)
                if current:
                    market_hub.update_client(client_id, sorted(current.symbols), focus)
            elif action == "ping":
                await websocket.send_json({"type": "pong", "at": _now()})

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exception = task.exception()
            if exception and not isinstance(exception, WebSocketDisconnect):
                log.error("market socket task failed", exc_info=(type(exception), exception, exception.__traceback__))
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            task.cancel()
        market_hub.remove_client(client_id)


@router.websocket("/ws/orders")
async def order_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=60)
    trade_hub.add_client(loop, queue)

    async def sender() -> None:
        while True:
            payload = await queue.get()
            await websocket.send_json(payload)

    async def receiver() -> None:
        while True:
            await websocket.receive_text()

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exception = task.exception()
            if exception and not isinstance(exception, WebSocketDisconnect):
                log.debug("order socket closed: %s", exception)
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            task.cancel()
        trade_hub.remove_client(loop, queue)
