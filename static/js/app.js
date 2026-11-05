import { Component, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html, cls, fmt, toneClass, SESSION_LABEL } from "./utils.js";
import { useLive, useOrderUpdates } from "./stream.js";
import { usePriceAlerts } from "./alerts.js";
import { clearToast, loadOverview, loadWatchlists, notify, openSearch, preload, refreshTrading, useStore } from "./store.js";
import { parseRoute, navigate } from "./router.js";
import { useTheme } from "./theme.js";
import { Icon } from "./icons.js";
import { SearchButton, SearchOverlay } from "./components/search.js";
import { TradeTicketOverlay } from "./components/trade-ticket.js";
import { Toast, StatusDot } from "./ui.js";
import { MarketPage } from "./pages/market.js";
import { StockPage } from "./pages/stock.js";
import { WatchlistPage } from "./pages/watchlist.js";
import { PortfolioPage } from "./pages/portfolio.js";
import { OrdersPage } from "./pages/orders.js";
import { AccountPage } from "./pages/account.js";
import { CryptoPage } from "./pages/crypto.js";
import { DataPage } from "./pages/data.js";

const NAV = [
  { key: "market", label: "市场", icon: "market" },
  { key: "watchlist", label: "自选", icon: "star" },
  { key: "crypto", label: "加密", icon: "crypto" },
  { key: "portfolio", label: "投资组合", icon: "portfolio" },
  { key: "orders", label: "订单", icon: "orders" },
  { key: "account", label: "账户", icon: "account" },
  { key: "data", label: "数据", icon: "layers" },
];

const TITLES = { market: "市场总览", watchlist: "自选", crypto: "加密市场", portfolio: "投资组合", orders: "订单", account: "账户", data: "数据与 API" };

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("MiniTrade render error", error);
  }
  render() {
    if (this.state.error) {
      return html`<div class="card card-pad" style="margin:20px">
        <div class="card-title">页面渲染出错</div>
        <p class="text-sm text-muted" style="margin:8px 0 14px">${this.state.error.message || "未知错误"}</p>
        <button class="btn btn-primary btn-sm" onClick=${() => { this.setState({ error: null }); location.reload(); }}>重新加载</button>
      </div>`;
    }
    return this.props.children;
  }
}

function useHashRoute() {
  const [route, setRoute] = useState(parseRoute);
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);
  useEffect(() => {
    const handler = () => {
      const decoded = parseRoute();
      const previous = routeRef.current;
      const changedPage = previous.page !== decoded.page || previous.symbol !== decoded.symbol;
      routeRef.current = decoded;
      setRoute(decoded);
      if (changedPage) window.scrollTo({ top: 0, behavior: "instant" });
    };
    window.addEventListener("hashchange", handler);
    if (!location.hash) location.hash = "#/market";
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}

function TickerTape({ overview, ticks, status }) {
  const indices = overview?.indices || [];
  const crypto = overview?.crypto || [];
  return html`<div class="tape">
    <div class="tape-label"><span class="dot live" />MARKET</div>
    <div class="tape-track">
      ${indices.map((item) => {
        const tick = ticks[item.symbol] || {};
        const price = tick.price ?? item.price;
        const pct = tick.price != null && item.previous_close ? tick.price / item.previous_close - 1 : item.change_pct;
        return html`<button class="tape-item" onClick=${() => navigate(`/stock/${item.symbol}`)}>
          <b>${item.symbol}</b>
          <span>${price != null ? fmt.price(price) : "—"}</span>
          <em class=${toneClass(pct)}>${pct != null ? fmt.pct(pct) : "—"}</em>
        </button>`;
      })}
      ${crypto.slice(0, 3).map((item) => html`<button class="tape-item" onClick=${() => navigate(`/crypto/${encodeURIComponent(item.symbol)}`)}>
        <b>${item.symbol}</b>
        <span>${fmt.money(item.price)}</span>
        <em class=${toneClass(item.change_pct)}>${fmt.pct(item.change_pct)}</em>
      </button>`)}
      ${!indices.length && [1, 2, 3, 4].map(() => html`<div class="tape-item"><span class="skeleton sk-line" style="width:80px;background:rgba(255,255,255,.12)" /></div>`)}
    </div>
    <div class="tape-spacer" />
    <div class="tape-status"><${StatusDot} status=${status} />DELAYED 15M</div>
  </div>`;
}

function Sidebar({ route, store }) {
  const openOrders = store.orders.filter((order) => order.is_open).length;
  const watchCount = store.watchlists[0]?.symbols?.length || 0;
  return html`<aside class="sidebar">
    <button class="brand" onClick=${() => navigate("/market")} style="border:0;background:none">
      <span class="brand-mark">↗</span>
      <span>MiniTrade<small>PAPER TERMINAL</small></span>
    </button>
    <div class="nav-group">
      <div class="nav-label">工作空间</div>
      <nav class="nav">
        ${NAV.map((item) => html`<button class=${cls("nav-item", route.page === item.key && "active")} onClick=${() => navigate(`/${item.key}`)}>
          <${Icon} name=${item.icon} size=${18} />
          <span>${item.label}</span>
          ${item.key === "orders" && openOrders > 0 ? html`<span class="nav-badge">${openOrders}</span>` : null}
          ${item.key === "watchlist" && watchCount > 0 ? html`<span class="nav-badge">${watchCount}</span>` : null}
        </button>`)}
      </nav>
    </div>
    <div class="nav-group shortcuts">
      <div class="nav-label">快捷入口</div>
      <nav class="nav">
        <button class="nav-item" onClick=${openSearch}><${Icon} name="search" size=${18} /><span>股票搜索</span></button>
        <button class="nav-item" onClick=${() => window.open("/api/docs", "_blank", "noopener")}><${Icon} name="external" size=${18} /><span>API 文档</span></button>
      </nav>
    </div>
    <div class="sidebar-foot">
      <span class="feed-pill" title=${store.streamStatus?.message || ""}><span class=${cls("dot", store.streamStatus?.state === "connected" ? "live" : store.streamStatus?.state === "error" ? "bad" : "warn")} /><span>${route.page === "crypto" ? "加密行情 · Alpaca Crypto" : store.streamStatus?.state === "connected" ? "延迟行情流已连接" : store.streamStatus?.state === "error" ? "行情受限" : "行情连接中"}</span></span>
      <p class="sidebar-note">Alpaca Paper Trading<br />${route.page === "crypto" ? "Crypto · 24/7 · 仅用于学习" : "延迟 SIP · 仅用于学习"}<br />不构成投资建议</p>
    </div>
  </aside>`;
}

function Topbar({ route, store, status }) {
  const [theme, toggleTheme] = useTheme();
  const title = route.page === "stock" ? route.symbol : TITLES[route.page] || "市场";
  const dayPct = store.account?.day_pl_pct;
  const isCrypto = route.page === "crypto";
  const marketLabel = isCrypto ? "24/7" : store.overview?.clock?.is_open ? "交易中" : SESSION_LABEL[store.overview?.clock?.session] || "休市";
  const marketOpen = isCrypto || Boolean(store.overview?.clock?.is_open);
  return html`<header class="topbar">
    <div class="topbar-title">${title} <span>/ ${route.page === "stock" ? "个股详情" : "MiniTrade"}</span></div>
    <${SearchButton} />
    <div class="topbar-right">
      <button
        class="btn btn-sm theme-toggle"
        onClick=${toggleTheme}
        title=${theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        aria-label=${theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        aria-pressed=${theme === "dark"}
      >
        <${Icon} name=${theme === "dark" ? "sun" : "moon"} size=${15} />
        <span>${theme === "dark" ? "浅色" : "深色"}</span>
      </button>
      <span class="market-state"><span class=${cls("dot", marketOpen ? "live" : "")} />${marketLabel}<small>${isCrypto ? "CRYPTO" : marketOpen ? "OPEN" : "CLOSED"}</small></span>
      <div class="equity-mini">
        <strong>${fmt.money(store.account?.portfolio_value ?? store.account?.equity)}</strong>
        <span class=${toneClass(dayPct)}>${dayPct != null ? fmt.pct(dayPct) : "—"}</span>
      </div>
      <span class="avatar" title="纸面账户">M</span>
    </div>
  </header>`;
}

function Page({ route }) {
  if (route.page === "stock") {
    return html`<${StockPage} key=${route.symbol} symbol=${route.symbol} tab=${route.tab || "overview"} />`;
  }
  if (route.page === "watchlist") return html`<${WatchlistPage} />`;
  if (route.page === "crypto") return html`<${CryptoPage} key=${route.symbol} symbol=${route.symbol} />`;
  if (route.page === "portfolio") return html`<${PortfolioPage} />`;
  if (route.page === "orders") return html`<${OrdersPage} />`;
  if (route.page === "account") return html`<${AccountPage} />`;
  if (route.page === "data") return html`<${DataPage} />`;
  return html`<${MarketPage} />`;
}

function App() {
  const route = useHashRoute();
  const store = useStore();
  const indexSymbols = useMemo(() => (store.overview?.indices || []).map((item) => item.symbol), [store.overview]);
  const { ticks, status } = useLive(indexSymbols);

  useEffect(() => {
    preload();
    const tradingTimer = setInterval(() => {
      if (document.visibilityState === "visible") refreshTrading({ silent: true });
    }, 30000);
    const overviewTimer = setInterval(() => {
      if (document.visibilityState === "visible") loadOverview(true);
    }, 60000);
    return () => {
      clearInterval(tradingTimer);
      clearInterval(overviewTimer);
    };
  }, []);

  useEffect(() => {
    if (!store.overview) loadOverview();
    if (!store.watchlists.length) loadWatchlists();
  }, []);

  // Price alerts are evaluated app-wide, so a rule fires whichever page is open.
  usePriceAlerts();

  useOrderUpdates((event) => {
    const order = event.order || {};
    const labels = {
      fill: "已成交",
      partial_fill: "部分成交",
      canceled: "已取消",
      rejected: "被拒绝",
      expired: "已过期",
      new: "已接受",
      accepted: "已接受",
      pending_new: "待确认",
      replaced: "已替换",
    };
    const label = labels[event.event] || event.event || "状态更新";
    if (["fill", "partial_fill", "canceled", "rejected"].includes(event.event)) {
      const labelSymbol = order.symbol || order.legs?.[0]?.symbol || "多腿组合";
      const qtyText = order.filled_qty ? ` ${fmt.num(order.filled_qty)}` : "";
      notify(`${labelSymbol} ${order.side === "sell" ? "卖出" : "买入"}${qtyText} ${label}`, event.event === "rejected" ? "error" : "success");
    }
    refreshTrading({ silent: true });
  });

  useEffect(() => {
    const handler = (event) => {
      const tag = document.activeElement?.tagName;
      const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || document.activeElement?.isContentEditable;
      if ((event.key === "/" && !editing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return html`<div class="app">
    <${Sidebar} route=${route} store=${store} />
    <div class="main">
      <${Topbar} route=${route} store=${store} status=${status} />
      <${TickerTape} overview=${store.overview} ticks=${ticks} status=${status} />
      <main class="content">
        <${ErrorBoundary} key=${route.page === "stock" ? route.symbol : route.page}>
          <${Page} route=${route} />
        <//>
      </main>
    </div>
    <${SearchOverlay} />
    <${TradeTicketOverlay} />
    <${Toast} toast=${store.toast} onClose=${clearToast} />
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
