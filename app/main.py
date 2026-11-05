"""MiniTrade: an Alpaca paper-trading terminal for learning markets."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import requests
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .alpaca_api import UpstreamError
from .cache import cache
from .config import DATA_FEED, DATA_FEED_LABEL, STATIC_DIR, credentials
from .crypto import router as crypto_router
from .market import router as market_router
from .options import router as options_router
from .streams import market_hub, router as stream_router, trade_hub
from .trading import router as trading_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("minitrade")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("MiniTrade starting (paper trading only, feed=%s)", DATA_FEED)
    yield
    market_hub.stop()
    log.info("MiniTrade stopped")


app = FastAPI(
    title="MiniTrade API",
    version="2.0.0",
    description="Alpaca 模拟交易与多维股票分析终端。所有交易均发送到 Alpaca Paper Trading。",
    docs_url="/api/docs",
    redoc_url=None,
    lifespan=lifespan,
)

app.include_router(market_router)
app.include_router(options_router)
app.include_router(crypto_router)
app.include_router(trading_router)
app.include_router(stream_router)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    return response


@app.exception_handler(UpstreamError)
async def upstream_error_handler(request: Request, exc: UpstreamError):
    code = 422 if exc.status in (400, 422) else 502
    return JSONResponse(status_code=code, content={"detail": exc.message})


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception):
    log.exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "服务内部出现异常，请查看服务端日志。"})


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health() -> dict:
    try:
        credentials()
        configured = True
    except Exception:
        configured = False
    return {
        "status": "ok",
        "mode": "paper",
        "configured": configured,
        "feed": DATA_FEED,
        "feed_label": DATA_FEED_LABEL,
        "version": app.version,
    }


_alpaca_logo_supported: bool | None = None


def _image_response(content: bytes, content_type: str) -> dict | None:
    if content and content_type.startswith("image/"):
        return {"bytes": content, "content_type": content_type}
    return None


def _logo_from_alpaca(symbol: str) -> dict | None:
    """Alpaca's logo API is entitlement-gated; remember a 403 so we do not retry every icon."""
    global _alpaca_logo_supported
    if _alpaca_logo_supported is False:
        return None
    try:
        key, secret = credentials()
        result = requests.get(
            f"https://data.alpaca.markets/v1beta1/logos/{symbol}",
            headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
            timeout=6,
        )
    except requests.RequestException:
        return None
    except Exception:
        return None
    if result.status_code == 200:
        _alpaca_logo_supported = True
        return _image_response(result.content, result.headers.get("content-type", ""))
    if result.status_code in (401, 403):
        _alpaca_logo_supported = False
    return None


def _logo_from_public(symbol: str) -> dict | None:
    """Fallback logo CDN for accounts without Alpaca's logo entitlement.

    Alpaca's endpoint returns 403 for the current paper/data subscription. These
    public sources are only used server-side; no key or user data is exposed.
    """
    candidates = [
        # Colored, high-coverage source; falls back to FMP/Parqet for symbols it lacks.
        f"https://companiesmarketcap.com/img/company-logos/64/{symbol}.png",
        f"https://financialmodelingprep.com/image-stock/{symbol}.png",
        f"https://assets.parqet.com/logos/symbol/{symbol}?format=png",
    ]
    for url in candidates:
        try:
            result = requests.get(
                url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; MiniTrade/2.0; learning project)"},
                timeout=6,
            )
        except requests.RequestException:
            continue
        if result.status_code == 200:
            image = _image_response(result.content, result.headers.get("content-type", ""))
            if image:
                return image
    return None


def _load_logo(symbol: str) -> dict:
    image = _logo_from_alpaca(symbol) or _logo_from_public(symbol)
    return image or {"missing": True}


@app.get("/api/stocks/{symbol}/logo", include_in_schema=False)
def stock_logo(symbol: str):
    symbol = symbol.upper()
    from .config import valid_symbol

    if not valid_symbol(symbol):
        return Response(status_code=404, headers={"Cache-Control": "public, max-age=3600"})

    record = cache.get_or_set(f"logo:{symbol}", 6 * 3600, lambda: _load_logo(symbol), stale_ttl=24 * 3600)
    if record.get("missing") or not record.get("bytes"):
        # A 404 lets the browser hide the <img>, revealing the themed CSS letter tile.
        return Response(status_code=404, headers={"Cache-Control": "public, max-age=3600"})
    return Response(
        content=record["bytes"],
        media_type=record.get("content_type", "image/png"),
        headers={"Cache-Control": "public, max-age=604800"},
    )


@app.post("/api/cache/clear")
def clear_cache() -> dict:
    cache.invalidate()
    return {"cleared": True}
