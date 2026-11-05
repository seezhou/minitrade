"""Safely verify Alpaca Paper Trading connectivity without printing credentials."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PAPER_BASE = "https://paper-api.alpaca.markets"
ENV_PATH = Path(__file__).resolve().with_name(".env")


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[name.strip()] = value
    return values


def get(path: str, key: str, secret: str) -> dict:
    request = Request(
        f"{PAPER_BASE}{path}",
        headers={
            "APCA-API-KEY-ID": key,
            "APCA-API-SECRET-KEY": secret,
            "Accept": "application/json",
        },
        method="GET",
    )
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    values = read_env(ENV_PATH)
    key = values.get("ALPACA_API_KEY", "").strip()
    secret = values.get("ALPACA_SECRET_KEY", "").strip()
    if not key or not secret:
        print("Authentication not attempted. Missing ALPACA_API_KEY or ALPACA_SECRET_KEY.")
        return 2

    try:
        account = get("/v2/account", key, secret)
        clock = get("/v2/clock", key, secret)
    except HTTPError as exc:
        print(f"Paper account request failed (HTTP {exc.code}). Check the paper key pair.")
        return 1
    except URLError:
        print("Paper account request failed (network or TLS error).")
        return 1
    except (TimeoutError, OSError, ValueError, UnicodeError):
        print("Paper account request failed (network or unexpected response).")
        return 1

    print("Paper account connection succeeded.")
    print(f"  status: {account.get('status')}")
    print(f"  mode: paper (fixed)")
    print(f"  currency: {account.get('currency')}")
    print(f"  portfolio value: {account.get('portfolio_value')}")
    print(f"  market open: {clock.get('is_open')}")
    print(f"  next open: {clock.get('next_open')}")
    print(f"  next close: {clock.get('next_close')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
