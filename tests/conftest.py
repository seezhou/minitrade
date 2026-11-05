"""Offline test harness for MiniTrade.

The suite never reaches the real Alpaca endpoints. Outbound HTTP is blocked at the
``requests.Session.request`` boundary, and each test swaps the `data_get` /
`trading_get` / `trading_send` helpers of the module under test for a fake table.

Why this shape: the app is a thin wrapper over a remote API, so the logic worth
locking down is our own normalisation, validation, paging and P&L derivation — not
Alpaca's live values. Everything here runs without credentials or network.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any, Callable

import pytest
import requests

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    """Any accidental upstream call fails loudly instead of silently hitting the API."""

    def _blocked(self, method, url, *args, **kwargs):
        raise AssertionError(f"test attempted a real network call: {method} {url}")

    monkeypatch.setattr(requests.Session, "request", _blocked)


@pytest.fixture(autouse=True)
def clean_cache():
    """The TTL cache is process-global; never let one test serve another's data."""
    from app.cache import cache

    cache.invalidate()
    yield
    cache.invalidate()


@pytest.fixture()
def client():
    """ASGI client without the lifespan context, so no upstream websocket hub starts."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture()
def upstream(monkeypatch):
    """Patch a module's Alpaca helpers with a handler and return the call log.

    Usage::

        calls = upstream("app.trading", lambda path, params: [])
        assert calls[0][0] == "/v2/orders"
    """
    logs: list[list[tuple[str, dict[str, Any]]]] = []

    def _patch(module_name: str, handler: Callable[[str, dict[str, Any]], Any]):
        module = importlib.import_module(module_name)
        calls: list[tuple[str, dict[str, Any]]] = []

        def fake_get(path, params=None, **_kwargs):
            calls.append((path, dict(params or {})))
            return handler(path, dict(params or {}))

        def fake_send(method, path, payload=None, **_kwargs):
            calls.append((path, dict(payload or {})))
            return handler(path, dict(payload or {}))

        for attr, fake in (
            ("data_get", fake_get),
            ("trading_get", fake_get),
            ("trading_send", fake_send),
        ):
            if hasattr(module, attr):
                monkeypatch.setattr(module, attr, fake)
        logs.append(calls)
        return calls

    return _patch
