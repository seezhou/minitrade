"""Small thread-safe TTL cache with stale-value fallback and an LRU cap."""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any, Callable

DEFAULT_MAX_ENTRIES = 2048


class TTLCache:
    """TTL map that also evicts the least recently used entry once it is full.

    TTL alone lets the process grow without bound while someone browses many
    symbols; the cap keeps memory flat. `peek` deliberately does not touch the
    recency order, so stale fallback cannot keep a dead key alive.
    """

    def __init__(self, max_entries: int = DEFAULT_MAX_ENTRIES) -> None:
        self._lock = threading.RLock()
        self._values: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self.max_entries = max(1, int(max_entries))

    def get(self, key: str, ttl: float) -> Any | None:
        with self._lock:
            entry = self._values.get(key)
            if not entry:
                return None
            stored_at, value = entry
            if time.monotonic() - stored_at <= ttl:
                self._values.move_to_end(key)
                return value
            return None

    def peek(self, key: str) -> Any | None:
        with self._lock:
            entry = self._values.get(key)
            return entry[1] if entry else None

    def set(self, key: str, value: Any) -> Any:
        with self._lock:
            self._values[key] = (time.monotonic(), value)
            self._values.move_to_end(key)
            while len(self._values) > self.max_entries:
                self._values.popitem(last=False)
        return value

    def get_or_set(
        self,
        key: str,
        ttl: float,
        loader: Callable[[], Any],
        *,
        stale_ttl: float | None = None,
    ) -> Any:
        hit = self.get(key, ttl)
        if hit is not None:
            return hit
        try:
            return self.set(key, loader())
        except Exception:
            if stale_ttl is not None:
                stale = self.peek(key)
                if stale is not None and time.monotonic() - self._values[key][0] <= stale_ttl:
                    return stale
            raise

    def invalidate(self, prefix: str = "") -> None:
        with self._lock:
            if not prefix:
                self._values.clear()
                return
            for key in [key for key in self._values if key.startswith(prefix)]:
                self._values.pop(key, None)

    def __len__(self) -> int:
        with self._lock:
            return len(self._values)


cache = TTLCache()
