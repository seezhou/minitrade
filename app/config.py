"""Application configuration and shared constants."""
from __future__ import annotations

import os
import re
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
load_dotenv(ROOT / ".env")

PAPER_BASE = "https://paper-api.alpaca.markets"
DATA_BASE = "https://data.alpaca.markets"
MARKET_STREAM_URL = "wss://stream.data.alpaca.markets/v2/delayed_sip"
TRADE_STREAM_URL = "wss://paper-api.alpaca.markets/stream"
CRYPTO_STREAM_URL = "wss://stream.data.alpaca.markets/v1beta3/crypto/us"
DATA_FEED = "delayed_sip"
DATA_FEED_LABEL = "SIP 综合行情（约延迟 15 分钟）"

ET = ZoneInfo("America/New_York")

SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,11}$")
OCC_RE = re.compile(r"^(?P<root>[A-Z]+)(?P<y>\d{2})(?P<m>\d{2})(?P<d>\d{2})(?P<kind>[CP])(?P<strike>\d{8})$")

MAX_STREAM_SYMBOLS = 28


class CredentialsError(RuntimeError):
    """Raised when the local Alpaca key pair is missing."""


def credentials() -> tuple[str, str]:
    key = os.getenv("ALPACA_API_KEY", "").strip()
    secret = os.getenv("ALPACA_SECRET_KEY", "").strip()
    if not key or not secret:
        raise CredentialsError("未配置 Alpaca 模拟账户密钥，请检查 .env。")
    return key, secret


def headers() -> dict[str, str]:
    key, secret = credentials()
    return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}


def valid_symbol(symbol: str) -> bool:
    return bool(SYMBOL_RE.fullmatch(symbol.upper()))
