"""Alpaca crypto real-time bridge: one upstream connection shared by all browsers.

The upstream is a background thread so the FastAPI event loop is never blocked;
browser sockets get coalesced ~300ms batches of price/bid/ask/bar updates.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .alpaca_api import as_float, as_int, iso, normalize_bar
from .config import CRYPTO_STREAM_URL, credentials
from .crypto import CRYPTO_SYMBOLS

log = logging.getLogger("minitrade.crypto_stream")
router = APIRouter()

CRYPTO_SYMBOL_SET = frozenset(CRYPTO_SYMBOLS)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def crypto_symbol(value: Any) -> str | None:
    """Crypto pairs contain '/', so the stock SYMBOL_RE validator does not apply."""
    text = str(value or "").strip().upper()
    return text if text in CRYPTO_SYMBOL_SET else None


@dataclass
class _Client:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue
    symbols: set[str] = field(default_factory=set)


class CryptoHub:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: dict[int, _Client] = {}
        self._next_id = 1
        self._refs: Counter[str] = Counter()
        self._latest: dict[str, dict] = {}
        self._dirty: set[str] = set()
        self._status = {
            "type": "crypto_status",
            "state": "idle",
            "message": "加密实时流尚未连接",
        }
        self._upstream: _CryptoUpstream | None = None
        self._stopping = threading.Event()
        self._flusher = threading.Thread(target=self._flush_loop, name="crypto-flush", daemon=True)
        self._flusher.start()

    # -- clients -----------------------------------------------------------
    def add_client(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> int:
        with self._lock:
            client_id = self._next_id
            self._next_id += 1
            self._clients[client_id] = _Client(loop=loop, queue=queue)
            status = self._status
        self._enqueue(queue, status)
        return client_id

    def remove_client(self, client_id: int) -> None:
        with self._lock:
            client = self._clients.pop(client_id, None)
            if client:
                for symbol in client.symbols:
                    self._release(symbol)

    def update_client(self, client_id: int, symbols: list[str]) -> None:
        cleaned: list[str] = []
        for symbol in symbols:
            resolved = crypto_symbol(symbol)
            if resolved and resolved not in cleaned:
                cleaned.append(resolved)
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
            ticks = {
                symbol: dict(self._latest.get(symbol) or {})
                for symbol in client.symbols
                if self._latest.get(symbol)
            }
            queue = client.queue
            status = self._status
        self._enqueue(queue, {"type": "crypto", "at": _now(), "ticks": ticks})
        self._enqueue(queue, status)
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

    def _ensure_upstream(self) -> None:
        with self._lock:
            if self._upstream and self._upstream.is_alive():
                return
            self._upstream = _CryptoUpstream(self)
            upstream = self._upstream
        upstream.start()

    # -- upstream callbacks ------------------------------------------------
    def on_trade(self, message: dict) -> None:
        symbol = message.get("S")
        price = as_float(message.get("p"))
        if symbol not in CRYPTO_SYMBOL_SET or price is None:
            return
        with self._lock:
            state = self._latest.setdefault(symbol, {})
            state["price"] = price
            state["size"] = as_float(message.get("s"))
            state["ts"] = iso(message.get("t"))
            self._dirty.add(symbol)

    def on_quote(self, message: dict) -> None:
        symbol = message.get("S")
        if symbol not in CRYPTO_SYMBOL_SET:
            return
        with self._lock:
            state = self._latest.setdefault(symbol, {})
            bid = as_float(message.get("bp"))
            ask = as_float(message.get("ap"))
            if bid is not None:
                state["bid"] = bid
            if ask is not None:
                state["ask"] = ask
            if bid is not None and ask is not None:
                # Crypto trades on this feed are sparse; mid price keeps the header moving.
                state["mid"] = (bid + ask) / 2
            state["bid_size"] = as_float(message.get("bs"))
            state["ask_size"] = as_float(message.get("as"))
            state["quote_ts"] = iso(message.get("t"))
            self._dirty.add(symbol)

    def on_bar(self, message: dict) -> None:
        symbol = message.get("S")
        close = as_float(message.get("c"))
        if symbol not in CRYPTO_SYMBOL_SET or close is None:
            return
        bar = normalize_bar(message, symbol=symbol)
        with self._lock:
            state = self._latest.setdefault(symbol, {})
            state["bar"] = bar
            state["price"] = close
            state["ts"] = bar.get("time")
            self._dirty.add(symbol)

    def set_status(self, state: str, message: str) -> None:
        log.info("crypto stream status -> %s (%s)", state, message)
        with self._lock:
            self._status = {
                "type": "crypto_status",
                "state": state,
                "message": message,
                "at": _now(),
            }
            queues = [client.queue for client in self._clients.values()]
        for queue in queues:
            self._enqueue(queue, self._status)

    # -- fan-out -----------------------------------------------------------
    def _flush_loop(self) -> None:
        while not self._stopping.is_set():
            time.sleep(0.3)
            try:
                self._flush()
            except Exception:
                log.exception("crypto flush failed")

    def _flush(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            dirty = set(self._dirty)
            self._dirty.clear()
            clients = list(self._clients.values())
            latest = {symbol: dict(self._latest.get(symbol) or {}) for symbol in dirty}

        for client in clients:
            symbols = dirty & client.symbols
            if not symbols:
                continue
            ticks = {symbol: latest[symbol] for symbol in symbols if latest.get(symbol)}
            if not ticks:
                continue
            self._enqueue(client.queue, {"type": "crypto", "at": _now(), "ticks": ticks})

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
        upstream = self._upstream
        if upstream:
            upstream.stop()
        with self._lock:
            self._clients.clear()
            self._refs.clear()


class _CryptoUpstream(threading.Thread):
    def __init__(self, hub: CryptoHub) -> None:
        super().__init__(name="alpaca-crypto-stream", daemon=True)
        self.hub = hub
        self._stop_event = threading.Event()
        self._subscribed: set[str] = set()

    def stop(self) -> None:
        self._stop_event.set()

    @staticmethod
    def _send(ws, payload: dict) -> None:
        ws.send(json.dumps(payload))

    def _sync_subscriptions(self, ws) -> None:
        desired = self.hub.desired_symbols()
        add = sorted(desired - self._subscribed)
        remove = sorted(self._subscribed - desired)
        if add:
            self._send(ws, {"action": "subscribe", "trades": add, "quotes": add, "bars": add})
        if remove:
            self._send(ws, {"action": "unsubscribe", "trades": remove, "quotes": remove, "bars": remove})
        if add or remove:
            log.info("crypto subscriptions add=%s remove=%s", add, remove)
        self._subscribed = set(desired)

    def run(self) -> None:
        from websockets.sync.client import connect

        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                key, secret = credentials()
                self.hub.set_status("connecting", "正在连接加密实时行情…")
                with connect(
                    CRYPTO_STREAM_URL,
                    open_timeout=15,
                    close_timeout=5,
                    max_size=16 * 1024 * 1024,
                    ping_interval=20,
                ) as ws:
                    self._send(ws, {"action": "auth", "key": key, "secret": secret})
                    if not _success(json.loads(ws.recv(timeout=15))):
                        raise RuntimeError("加密实时行情认证失败")
                    self._subscribed = set()
                    self.hub.set_status("connected", "加密实时行情已连接")
                    backoff = 1.0
                    last_sync = 0.0
                    while not self._stop_event.is_set():
                        now = time.monotonic()
                        if now - last_sync > 0.5:
                            self._sync_subscriptions(ws)
                            last_sync = now
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
                                log.warning("crypto stream error: %s", message.get("msg"))
                                self.hub.set_status("error", str(message.get("msg") or "加密实时行情返回错误"))
            except Exception as exc:
                if self._stop_event.is_set():
                    break
                log.warning("crypto stream disconnected: %s", exc)
                self.hub.set_status("reconnecting", "加密实时行情中断，正在重连…")
                if self._stop_event.wait(min(backoff, 30)):
                    break
                backoff = min(backoff * 2, 30)


def _success(message: Any) -> bool:
    if isinstance(message, list):
        return any(isinstance(item, dict) and item.get("T") == "success" for item in message)
    if isinstance(message, dict):
        return message.get("T") == "success"
    return False


crypto_hub = CryptoHub()


@router.websocket("/ws/crypto")
async def crypto_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=120)
    client_id = crypto_hub.add_client(loop, queue)

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
                if isinstance(symbols, list):
                    crypto_hub.update_client(client_id, [str(item) for item in symbols])
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
                log.debug("crypto socket closed: %s", exception)
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            task.cancel()
        crypto_hub.remove_client(client_id)
