import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html, cls, fmt, toneClass } from "../utils.js";
import { api } from "../api.js";
import { useAsync, useDebounced } from "../hooks.js";
import { closeSearch, openSearch, useStore } from "../store.js";
import { navigate, stockPath } from "../router.js";
import { Icon } from "../icons.js";
import { Logo } from "../ui.js";

const RECENT_KEY = "minitrade-recent";
const FALLBACK_TRENDING = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"];

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 8);
  } catch {
    return [];
  }
}

export function SearchOverlay() {
  const store = useStore();
  if (!store.searchOpen) return null;
  return html`<${SearchPanel} overview=${store.overview} watchlists=${store.watchlists} />`;
}

function SearchPanel({ overview, watchlists }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [recent, setRecent] = useState(readRecent);
  const inputRef = useRef(null);
  const debounced = useDebounced(query.trim(), 170);
  const { data, loading, error } = useAsync(
    () => (debounced ? api(`/api/search?q=${encodeURIComponent(debounced)}`) : Promise.resolve([])),
    [debounced],
  );

  const trending = useMemo(() => {
    const symbols = [];
    for (const asset of overview?.actives || []) symbols.push(asset.symbol);
    for (const list of watchlists || []) symbols.push(...list.symbols);
    for (const symbol of FALLBACK_TRENDING) symbols.push(symbol);
    return [...new Set(symbols)].slice(0, 10);
  }, [overview, watchlists]);

  const results = data || [];
  const showResults = Boolean(debounced);
  const rows = showResults ? results : [];

  useEffect(() => {
    inputRef.current?.focus();
    const handler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [debounced, results.length]);

  function choose(symbol) {
    if (!symbol) return;
    const next = [symbol, ...recent.filter((item) => item !== symbol)].slice(0, 8);
    setRecent(next);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    closeSearch();
    navigate(stockPath(symbol));
  }

  function onKeyDown(event) {
    if (!showResults) {
      if (event.key === "Enter" && query.trim()) choose(query.trim().toUpperCase());
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((value) => Math.min(rows.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[selected]?.symbol || query.trim().toUpperCase());
    }
  }

  return html`<div class="overlay" onMouseDown=${(event) => { if (event.target === event.currentTarget) closeSearch(); }}>
    <div class="search-panel" role="dialog" aria-modal="true" aria-label="搜索股票">
      <div class="search-bar">
        <${Icon} name="search" size=${19} className="muted" />
        <input
          ref=${inputRef}
          value=${query}
          onInput=${(event) => setQuery(event.currentTarget.value)}
          onKeyDown=${onKeyDown}
          placeholder="搜索股票代码或公司名称，例如 AAPL、特斯拉"
          autocomplete="off"
          spellcheck="false"
        />
        ${loading && html`<span class="spinner" />`}
        <kbd>ESC</kbd>
      </div>

      ${error && html`<div class="error-banner" style="margin:10px">${error}</div>`}

      ${!showResults ? html`
        ${recent.length > 0 && html`<div class="search-section">最近查看</div>
          <div class="search-recents">
            ${recent.map((symbol) => html`<button class="chip" onClick=${() => choose(symbol)}>${symbol}</button>`)}
          </div>`}
        <div class="search-section">热门与自选</div>
        <div class="search-recents">
          ${trending.map((symbol) => html`<button class="chip" onClick=${() => choose(symbol)}>${symbol}</button>`)}
        </div>
        <div class="search-empty" style="padding-top:18px">
          输入代码、公司名或关键词开始搜索。支持 <b>BRK.B</b>、<b>BF-B</b> 等代码。
        </div>
      ` : html`
        <div class="search-list">
          ${rows.length === 0 && !loading ? html`<div class="search-empty">没有找到匹配的股票，试试完整代码。</div>` : null}
          ${rows.map((item, index) => html`<button
            class=${cls("search-row", index === selected && "selected")}
            onMouseEnter=${() => setSelected(index)}
            onClick=${() => choose(item.symbol)}
          >
            <${Logo} symbol=${item.symbol} />
            <span class="meta">
              <b>${item.symbol}</b>
              <small>${item.name || "公司名称暂不可用"} · ${item.exchange || "—"}</small>
              <small>${item.fractionable ? "支持碎股" : "整股"} · ${item.tradable ? "可交易" : "仅行情"}${item.has_options ? " · 有期权" : ""}</small>
            </span>
            <span class="quote">
              <b>${item.price != null ? fmt.price(item.price) : "—"}</b>
              <small class=${toneClass(item.change_pct)}>${item.change_pct != null ? fmt.pct(item.change_pct) : "—"}</small>
            </span>
          </button>`)}
        </div>
      `}

      <div class="card-sub" style="border-top:1px solid var(--line);padding:9px 16px;display:flex;gap:14px">
        <span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span>
        <span style="margin-left:auto">数据来自 Alpaca</span>
      </div>
    </div>
  </div>`;
}

export function SearchButton() {
  return html`<button class="search-trigger" onClick=${openSearch}>
    <${Icon} name="search" size=${16} />
    <span>搜索股票、代码或公司…</span>
    <kbd>/</kbd>
  </button>`;
}
