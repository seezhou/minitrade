import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass } from "../utils.js";
import { useAsync, useDebounced, useDocumentTitle } from "../hooks.js";
import { useLive } from "../stream.js";
import { addWatchlistLocal, loadWatchlists, mutateWatchlist, notify, openTrade, removeWatchlistLocal, useStore } from "../store.js";
import { navigate, stockPath } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, Empty, ErrorBanner, LoadingRow, Logo, Sparkline, Modal } from "../ui.js";

const SUGGESTIONS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL", "SPY"];

export function WatchlistPage() {
  const store = useStore();
  const lists = store.watchlists;
  const [activeId, setActiveId] = useState(null);
  const [modal, setModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  useDocumentTitle("自选");

  useEffect(() => {
    loadWatchlists();
  }, []);

  useEffect(() => {
    if (!lists.length) {
      setActiveId(null);
      return;
    }
    if (!activeId || !lists.some((item) => item.id === activeId)) setActiveId(lists[0].id);
  }, [lists, activeId]);

  const active = lists.find((item) => item.id === activeId) || lists[0] || null;
  const symbols = active?.symbols || [];
  const quotesQuery = useAsync(
    () => (symbols.length ? api(`/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}&sparkline=true`) : Promise.resolve([])),
    [active?.id, symbols.join(",")],
  );
  const { ticks } = useLive(symbols);
  const quoteMap = Object.fromEntries((quotesQuery.data || []).map((item) => [item.symbol, item]));
  const rows = (active?.assets || []).map((asset) => {
    const quote = quoteMap[asset.symbol] || {};
    const tick = ticks[asset.symbol] || {};
    const price = tick.price ?? quote.price;
    const previousClose = quote.previous_close;
    const change = price != null && previousClose ? price - previousClose : quote.change;
    const changePct = change != null && previousClose ? change / previousClose : quote.change_pct;
    return { ...asset, ...quote, ...tick, price, change, change_pct: changePct };
  });

  async function createList(name) {
    try {
      const created = await api("/api/watchlists", { method: "POST", body: { name: name || "我的自选", symbols: [] } });
      addWatchlistLocal(created);
      setActiveId(created.id);
      setModal(null);
      notify(`已创建自选列表「${created.name}」`, "success");
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function renameList(list, name) {
    try {
      const updated = await api(`/api/watchlists/${list.id}`, { method: "PUT", body: { name, symbols: list.symbols } });
      mutateWatchlist(updated);
      setModal(null);
      notify("列表已重命名", "success");
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function deleteList(list) {
    try {
      await api(`/api/watchlists/${list.id}`, { method: "DELETE" });
      removeWatchlistLocal(list.id);
      setConfirmDelete(null);
      notify(`已删除「${list.name}」`);
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function removeSymbol(symbol) {
    if (!active) return;
    try {
      const updated = await api(`/api/watchlists/${active.id}/symbols/${symbol}`, { method: "DELETE" });
      mutateWatchlist(updated);
      notify(`已移除 ${symbol}`);
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function addSymbol(symbol) {
    if (!active) return;
    const code = symbol.trim().toUpperCase();
    if (!code) return;
    if (active.symbols.includes(code)) {
      notify(`${code} 已在「${active.name}」中`);
      return;
    }
    try {
      const updated = await api(`/api/watchlists/${active.id}/symbols`, { method: "POST", body: { symbol: code } });
      mutateWatchlist(updated);
      notify(`已加入 ${code}`, "success");
    } catch (error) {
      notify(error.message, "error");
    }
  }

  if (store.watchlistsLoading && !lists.length) {
    return html`<div><${PageHead} eyebrow="关注列表" title="自选" /><${Card}><${LoadingRow} label="正在读取 Alpaca 自选列表…" /><//></div>`;
  }

  return html`<div>
    <${PageHead}
      eyebrow="关注列表 · 保存在 Alpaca 账户"
      title="自选"
      sub="多个列表、服务器端持久化、实时价格与迷你走势。用星标从任何页面添加股票。"
      actions=${html`<button class="btn btn-primary btn-sm" onClick=${() => setModal({ type: "create" })}><${Icon} name="plus" size=${14} />新建列表</button>`}
    />
    ${store.watchlistsError && html`<${ErrorBanner} message=${store.watchlistsError} onRetry=${() => loadWatchlists(true)} />`}

    ${!lists.length ? html`<${Card}>
      <${Empty} icon="star" title="还没有自选列表" description="创建一个列表，把想跟踪的股票放进去。列表会保存在 Alpaca 纸面账户中。" action=${html`<button class="btn btn-primary btn-sm" onClick=${() => setModal({ type: "create" })}>创建我的自选</button>`} />
    <//>` : html`<div class="stack">
      <${Card}>
        <div class="watch-toolbar">
          <div class="list-tabs">
            ${lists.map((list) => html`<button class=${cls(active?.id === list.id && "active")} onClick=${() => setActiveId(list.id)}>${list.name} <span class="badge" style="margin-left:4px">${list.symbols.length}</span></button>`)}
            <button class="btn btn-ghost btn-icon btn-sm" onClick=${() => setModal({ type: "create" })} title="新建列表"><${Icon} name="plus" size=${14} /></button>
          </div>
          <div class="grow" />
          ${active && html`<div class="row">
            <button class="btn btn-ghost btn-icon btn-sm" title="重命名" onClick=${() => setModal({ type: "rename", list: active })}><${Icon} name="edit" size=${14} /></button>
            <button class="btn btn-ghost btn-icon btn-sm" title="删除列表" onClick=${() => setConfirmDelete(active)}><${Icon} name="trash" size=${14} /></button>
          </div>`}
        </div>
        <div class="watch-toolbar" style="border-bottom:1px solid var(--line)">
          <${SymbolAdder} onAdd=${addSymbol} />
          <div class="grow" />
          <button class="btn btn-sm" onClick=${quotesQuery.reload}><${Icon} name="refresh" size=${13} />刷新</button>
        </div>

        ${rows.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>股票</th><th class="r">最新价</th><th class="r">涨跌幅</th><th class="r col-range">日区间</th><th class="r col-volume">成交量</th><th class="c col-spark">30 日走势</th><th class="r col-actions">操作</th></tr></thead>
          <tbody>${rows.map((row) => html`<tr>
            <td><div class="sym-cell" style="cursor:pointer" onClick=${() => navigate(stockPath(row.symbol))}>
              <${Logo} symbol=${row.symbol} />
              <div><div class="sym">${row.symbol}</div><div class="nm">${row.name}</div></div>
            </div></td>
            <td class="r"><b>${fmt.price(row.price)}</b><div class=${cls("text-xs", toneClass(row.change))}>${row.change != null ? fmt.moneySigned(row.change) : "—"}</div></td>
            <td class=${cls("r", toneClass(row.change_pct))}><b>${row.change_pct != null ? fmt.pct(row.change_pct) : "—"}</b></td>
            <td class="r text-muted col-range">${row.day_is_today ? `${fmt.price(row.low)} – ${fmt.price(row.high)}` : `昨收 ${fmt.price(row.previous_close)}`}</td>
            <td class="r text-muted col-volume">${row.volume != null ? fmt.compact(row.volume) : "—"}</td>
            <td class="c col-spark"><${Sparkline} values=${row.spark || []} width=${74} height=${26} /></td>
            <td class="r col-actions"><div class="watch-actions">
              <button class="btn btn-sm" onClick=${() => openTrade(row.symbol, "buy")}>买入</button>
              <button class="btn btn-ghost btn-icon btn-sm" title="移除" onClick=${() => removeSymbol(row.symbol)}><${Icon} name="trash" size=${13} /></button>
            </div></td>
          </tr>`)}</tbody>
        </table></div>` : html`<${Empty} icon="star" title="这个列表还是空的" description="搜索代码加入，或从下面的热门股票开始。" action=${html`<div class="row wrap" style="justify-content:center">${SUGGESTIONS.slice(0, 5).map((symbol) => html`<button class="chip" onClick=${() => addSymbol(symbol)}>＋ ${symbol}</button>`)}</div>`} />`}
      <//>

      <div class="card card-pad">
        <div class="row-between"><div><div class="card-title">从热门股票开始</div><div class="card-sub">一键加入当前列表「${active?.name}」</div></div><${Badge} tone="neutral">${SUGGESTIONS.length} 个<//></div>
        <div class="row wrap" style="margin-top:10px">${SUGGESTIONS.map((symbol) => html`<button class="chip ${active?.symbols.includes(symbol) ? "chip-active" : ""}" onClick=${() => addSymbol(symbol)}>${active?.symbols.includes(symbol) ? "✓" : "＋"} ${symbol}</button>`)}</div>
      </div>
    </div>`}

    ${modal?.type === "create" && html`<${NameModal} title="新建自选列表" placeholder="例如：科技股、分红股" onClose=${() => setModal(null)} onSubmit=${(name) => createList(name)} />`}
    ${modal?.type === "rename" && html`<${NameModal} title="重命名列表" initial=${modal.list.name} onClose=${() => setModal(null)} onSubmit=${(name) => renameList(modal.list, name)} />`}
    ${confirmDelete && html`<${Modal} title="删除自选列表" subtitle=${confirmDelete.name} onClose=${() => setConfirmDelete(null)}>
      <div class="text-sm">删除后列表和其中的股票都会从 Alpaca 账户移除，但不会影响持仓或订单。</div>
      <div class="modal-actions"><button class="btn" onClick=${() => setConfirmDelete(null)}>取消</button><button class="btn btn-danger" onClick=${() => deleteList(confirmDelete)}>确认删除</button></div>
    <//>`}
  </div>`;
}

function NameModal({ title, initial = "", placeholder, onClose, onSubmit }) {
  const [name, setName] = useState(initial);
  return html`<${Modal} title=${title} onClose=${onClose}>
    <form class="stack" onSubmit=${(event) => { event.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
      <div class="field"><label>列表名称</label><input class="input" value=${name} onInput=${(event) => setName(event.currentTarget.value)} placeholder=${placeholder || "我的自选"} autofocus maxlength="64" /></div>
      <div class="modal-actions"><button type="button" class="btn" onClick=${onClose}>取消</button><button class="btn btn-primary" disabled=${!name.trim()}>保存</button></div>
    </form>
  <//>`;
}

function SymbolAdder({ onAdd }) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const debounced = useDebounced(query.trim(), 180);
  const { data, loading } = useAsync(
    () => (debounced ? api(`/api/search?q=${encodeURIComponent(debounced)}`) : Promise.resolve([])),
    [debounced],
  );
  const results = (data || []).slice(0, 6);
  return html`<div style="position:relative;min-width:260px;flex:1;max-width:420px">
    <div class="input-wrap">
      <input
        class="input input-sm"
        value=${query}
        onInput=${(event) => setQuery(event.currentTarget.value)}
        onFocus=${() => setFocused(true)}
        onBlur=${() => setTimeout(() => setFocused(false), 160)}
        onKeyDown=${(event) => { if (event.key === "Enter" && query.trim()) { onAdd(query.trim().toUpperCase()); setQuery(""); } }}
        placeholder="输入代码添加到当前列表，回车确认"
      />
      <span class="input-suffix">${loading ? "…" : "ADD"}</span>
    </div>
    ${focused && query.trim() && results.length > 0 && html`<div class="indicator-pop" style="left:0;right:auto;top:34px;min-width:300px;max-height:260px;overflow:auto">
      ${results.map((item) => html`<button class="search-row" style="padding:8px" onMouseDown=${(event) => event.preventDefault()} onClick=${() => { onAdd(item.symbol); setQuery(""); }}>
        <${Logo} symbol=${item.symbol} />
        <span class="meta"><b>${item.symbol}</b><small>${item.name}</small></span>
        <span class="quote"><b>${item.price != null ? fmt.price(item.price) : ""}</b><small class=${toneClass(item.change_pct)}>${item.change_pct != null ? fmt.pct(item.change_pct) : ""}</small></span>
      </button>`)}
    </div>`}
  </div>`;
}
