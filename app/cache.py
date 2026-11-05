"""Small thread-safe TTL cache with stale-value fallback."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable


class TTLCache:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._values: dict[str, tuple[float, Any]] = {}

    def get(self, key: str, ttl: float) -> Any | None:
        with self._lock:
            entry = self._values.get(key)
            if not entry:
                return None
            stored_at, value = entry
            if time.monotonic() - stored_at <= ttl:
                return value
            return None

    def peek(self, key: str) -> Any | None:
        with self._lock:
            entry = self._values.get(key)
            return entry[1] if entry else None

    def set(self, key: str, value: Any) -> Any:
        with self._lock:
            self._values[key] = (time.monotonic(), value)
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


cache = TTLCache()
