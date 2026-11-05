"""Route wiring.

These go through the real FastAPI app, but every upstream helper is faked. They do
not re-test business rules — they catch the plumbing kind of regression: wrong
status codes, lost query parameters, and validation that accidentally forwards an
invalid order to Alpaca.
"""
from __future__ import annotations

import pytest

from app.alpaca_api import UpstreamError

ACCOUNT_RAW = {
    "id": "acct-1",
    "status": "ACTIVE",
    "currency": "USD",
    "cash": "1000",
    "equity": "1100",
    "last_equity": "1000",
    "buying_power": "4000",
}


def test_health_answers_without_upstream(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] == "paper"


def test_account_is_normalized(client, upstream):
    upstream("app.trading", lambda path, params: ACCOUNT_RAW)
    response = client.get("/api/account")
    assert response.status_code == 200
    body = response.json()
    assert body["equity"] == 1100.0
    assert body["day_pl"] == 100.0


def test_upstream_403_becomes_502(client, upstream):
    def denied(path, params):
        raise UpstreamError(403, "forbidden", "http_403")

    upstream("app.trading", denied)
    assert client.get("/api/account").status_code == 502


def test_upstream_400_becomes_422(client, upstream):
    def rejected(path, params):
        raise UpstreamError(400, "bad request", "http_400")

    upstream("app.trading", rejected)
    assert client.get("/api/account").status_code == 422


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------


def test_order_list_adds_is_open_and_remaining(client, upstream):
    def handler(path, params):
        if path == "/v2/orders":
            return [
                {"id": "o1", "symbol": "AAPL", "status": "new", "qty": "10", "filled_qty": "4"},
                {"id": "o2", "symbol": "MSFT", "status": "filled", "qty": "5", "filled_qty": "5"},
            ]
        raise AssertionError(path)

    calls = upstream("app.trading", handler)
    response = client.get("/api/orders?status=open&symbol=aapl")
    assert response.status_code == 200
    body = response.json()
    assert body[0]["is_open"] is True
    assert body[0]["remaining_qty"] == 6.0
    assert body[1]["is_open"] is False
    # the query is uppercased before it reaches Alpaca
    assert calls[0][1]["symbols"] == "AAPL"
    assert calls[0][1]["status"] == "open"


def test_invalid_order_never_reaches_alpaca(client, upstream):
    def handler(path, params):
        raise AssertionError(f"validation should have stopped this before {path}")

    calls = upstream("app.trading", handler)
    response = client.post("/api/orders", json={"symbol": "AAPL", "side": "buy", "order_type": "limit"})
    assert response.status_code == 422
    assert calls == []


def test_create_order_returns_the_normalized_order(client, upstream):
    def handler(path, params):
        if path == "/v2/orders":
            return {"id": "ord-9", "symbol": "AAPL", "side": "buy", "type": "market", "qty": "1", "status": "accepted"}
        raise AssertionError(path)

    calls = upstream("app.trading", handler)
    response = client.post("/api/orders", json={"symbol": "AAPL", "side": "buy", "order_type": "market", "qty": 1})
    assert response.status_code == 201
    body = response.json()
    assert body["id"] == "ord-9"
    assert body["filled_qty"] == 0.0
    assert calls[0][1]["qty"] == "1"


def test_create_order_forwards_client_order_id(client, upstream):
    def handler(path, params):
        return {"id": "ord-10", "client_order_id": "mt-test", "status": "accepted"}

    calls = upstream("app.trading", handler)
    response = client.post(
        "/api/orders",
        json={"symbol": "AAPL", "side": "buy", "order_type": "limit", "limit_price": 1.0, "qty": 1, "client_order_id": " mt-test "},
    )
    assert response.status_code == 201
    assert calls[0][1]["client_order_id"] == "mt-test"


def test_oversell_is_refused_before_submitting(client, upstream):
    def handler(path, params):
        if path == "/v2/positions":
            return [{"symbol": "AAPL", "qty": "1"}]
        if path == "/v2/orders":
            return []
        raise AssertionError(path)

    calls = upstream("app.trading", handler)
    response = client.post("/api/orders", json={"symbol": "AAPL", "side": "sell", "order_type": "market", "qty": 5})
    assert response.status_code == 422
    assert "可卖数量不足" in response.json()["detail"]
    # only the position/order lookups happened; no POST was sent
    assert [call[0] for call in calls] == ["/v2/positions", "/v2/orders"]


def test_client_order_id_lookup_maps_upstream_404(client, upstream):
    def handler(path, params):
        raise UpstreamError(404, "not found", "http_404")

    upstream("app.trading", handler)
    response = client.get("/api/orders/by-client-id/does-not-exist")
    assert response.status_code == 404


@pytest.mark.parametrize("client_id", ["x" * 49])
def test_client_order_id_lookup_validates_length(client, upstream, client_id):
    upstream("app.trading", lambda path, params: {})
    assert client.get(f"/api/orders/by-client-id/{client_id}").status_code == 422


# ---------------------------------------------------------------------------
# Account configuration
# ---------------------------------------------------------------------------


def test_account_config_get_is_shaped(client, upstream):
    upstream(
        "app.trading",
        lambda path, params: {"no_shorting": False, "max_margin_multiplier": "4", "suspend_trade": False},
    )
    body = client.get("/api/account/config").json()
    assert body["max_margin_multiplier"] == 4.0
    assert body["no_shorting"] is False
    assert body["raw"]


def test_account_config_patch_rejects_an_empty_body(client, upstream):
    calls = upstream("app.trading", lambda path, params: {})
    assert client.patch("/api/account/config", json={}).status_code == 422
    assert calls == []


def test_account_config_patch_ignores_unknown_fields(client, upstream):
    calls = upstream("app.trading", lambda path, params: {})
    assert client.patch("/api/account/config", json={"not_a_field": True}).status_code == 422
    assert calls == []


def test_account_config_patch_rejects_out_of_range_margin(client, upstream):
    calls = upstream("app.trading", lambda path, params: {})
    assert client.patch("/api/account/config", json={"max_margin_multiplier": 9}).status_code == 422
    assert calls == []


def test_account_config_patch_forwards_whitelisted_fields(client, upstream):
    calls = upstream("app.trading", lambda path, params: {"no_shorting": True})
    response = client.patch("/api/account/config", json={"no_shorting": True})
    assert response.status_code == 200
    assert response.json()["no_shorting"] is True
    assert calls[0] == ("/v2/account/configurations", {"no_shorting": True})


def test_account_config_patch_stringifies_the_margin_multiplier(client, upstream):
    calls = upstream("app.trading", lambda path, params: {"max_margin_multiplier": "4"})
    response = client.patch("/api/account/config", json={"max_margin_multiplier": 4})
    assert response.status_code == 200
    assert calls[0][1] == {"max_margin_multiplier": "4"}
