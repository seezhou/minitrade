import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass, SESSION_LABEL, dateShort, timeRange, isEarlyClose } from "../utils.js";
import { useAsync, useNow, useDocumentTitle } from "../hooks.js";
import { useLive } from "../stream.js";
import { loadOverview, loadWatchlists, notify, openSearch, openTrade, refreshTrading, useStore } from "../store.js";
import { navigate, stockPath } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Sparkline, Badge, Empty, ErrorBanner, Skeleton, LoadingRow, Logo } from "../ui.js";
import { WatchStar } from "../components/watch-star.js";

function applyTick(item, tick) {
  if (!tick) return item;
  const price = tick.price ?? item.price;
  const previousClose = item.previous_close;
  const change = price != null && previousClose ? price - previousClose : item.change;
  const changePct = change != null && previousClose ? change / previousClose : item.change_pct;
  return { ...item, ...tick, price, change, change_pct: changePct };
}

function AccountHero({ account, positions, history, status }) {
  const equity = account?.portfolio_value ?? account?.equity;
  const dayPl = account?.day_pl;
  const dayPct = account?.day_pl_pct;
  const pnl = positions.reduce((sum, item) => sum + Number(item.unrealized_pl || 0), 0);
  const spark = (history?.points || []).slice(-50).map((point) => point.equity);
  const showSpark = spark.length > 2 && new Set(spark).size > 1;
  if (!account) {
    return html`<div class="hero-account"><${Skeleton} lines=${3} /><div class="skeleton sk-block" style="margin-top:16px;background:rgba(255,255,255,.08)" /></div>`;
  }
  return html`<div class="hero-account">
    <div class="hero-label"><span class=${cls("dot", status?.state === "connected" ? "live" : "warn")} />模拟账户总资产</div>
    <div class="hero-value">${fmt.money(equity)}</div>
    <div class="hero-delta ${toneClass(dayPl)}">
      ${dayPl != null ? `${fmt.moneySigned(dayPl)} (${fmt.pct(dayPct)})` : "—"}
      <span class="muted">今日盈亏</span>
    </div>
    <div class="hero-metrics">
      <div class="hero-metric"><span>可用购买力</span><strong>${fmt.money(account.buying_power)}</strong></div>
      <div class="hero-metric"><span>现金</span><strong>${fmt.money(account.cash)}</strong></div>
      <div class="hero-metric"><span>持仓浮动盈亏</span><strong class=${toneClass(pnl)}>${fmt.moneySigned(pnl)}</strong></div>
      <div class="hero-metric"><span>持仓数量</span><strong>${positions.length} 只</strong></div>
    </div>
    <div class="hero-actions">
      <button class="btn btn-sm" style="background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.16);color:#fff" onClick=${openSearch}>查找股票</button>
      <button class="btn btn-sm" style="background:#fff;border-color:#fff;color:#0b1220" onClick=${() => navigate("/portfolio")}>投资组合</button>
    </div>
    ${showSpark && html`<div class="hero-spark"><${Sparkline} values=${spark} width=${190} height=${54} color="#6ee7b7" strokeWidth=${1.8} /></div>`}
  </div>`;
}

function ClockCard({ clock }) {
  useNow(1000);
  const now = new Date();
  const isOpen = Boolean(clock?.is_open);
  const session = clock?.session || (isOpen ? "regular" : "closed");
  const nextEvent = isOpen ? clock?.next_close : clock?.next_open;
  const nextLabel = isOpen ? "距离收盘" : "距离开盘";
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const minutes = etNow.getHours() * 60 + etNow.getMinutes();
  const progress = isOpen ? Math.min(100, Math.max(0, ((minutes - 570) / 390) * 100)) : 0;

  return html`<${Card} className="clock-card">
    <div class="row-between">
      <div class="clock-status">
        <span class=${cls("ring", !isOpen && "closed")}><${Icon} name="clock" size=${19} /></span>
        <div>
          <h3>${isOpen ? "美股交易中" : session === "premarket" ? "盘前交易时段" : session === "afterhours" ? "盘后交易时段" : "市场已休市"}</h3>
          <p>${fmt.dateLong(clock?.now_et)} · 纽约时间</p>
        </div>
      </div>
      <${Badge} tone=${isOpen ? "green" : "neutral"}>${isOpen ? "OPEN" : "CLOSED"}<//>
    </div>
    <div>
      <div class="row-between" style="font-size:11px;margin-bottom:5px"><span class="text-muted">${nextLabel}</span><b class="tabular">${clock?.next_open ? fmt.countdown(nextEvent) : "—"}</b></div>
      <div class="session-bar"><i style=${`width:${isOpen ? progress : 0}%`} /></div>
      <div class="session-meta"><span>09:30</span><span>${isOpen ? `${progress.toFixed(0)}% 交易时段` : "等待下一次开盘"}</span><span>16:00</span></div>
    </div>
    <div class="row-between text-xs text-muted" style="border-top:1px solid var(--line);padding-top:10px">
      <span>下一次开盘 · ${fmt.time(clock?.next_open)} ET</span>
      <span>下一次收盘 · ${fmt.time(clock?.next_close)} ET</span>
    </div>
  <//>`;
}

function IndexCard({ item, tick }) {
  const live = applyTick(item, tick);
  return html`<button class="card index-card" style="text-align:left" onClick=${() => navigate(stockPath(item.symbol))}>
    <div class="index-top"><span class="index-name">${item.short}</span><span class="index-sym">${item.symbol}</span></div>
    <div class="index-price">${live.price != null ? fmt.price(live.price) : "—"}</div>
    <div class="index-meta">
      <div>
        <div class=${cls("index-change", toneClass(live.change_pct))}>${live.change_pct != null ? fmt.pct(live.change_pct) : "—"}</div>
        <div class="text-xs text-muted">${live.change != null ? fmt.moneySigned(live.change) : "等待行情"}</div>
      </div>
      <${Sparkline} values=${item.spark || []} width=${72} height=${28} />
    </div>
  </button>`;
}

function WatchlistPeek({ list, ticks }) {
  if (!list) {
    return html`<${Card}>
      <div class="card-head"><div><div class="card-title">自选速览</div><div class="card-sub">在 Alpaca 账户中保存的关注列表</div></div></div>
      <${Empty} icon="star" title="还没有自选列表" description="搜索你感兴趣的股票，点击星标即可加入自选。" action=${html`<button class="btn btn-primary btn-sm" onClick=${openSearch}>搜索股票</button>`} />
    <//>`;
  }
  const assets = (list.assets || []).slice(0, 6);
  return html`<${Card}>
    <div class="card-head"><div><div class="card-title">自选速览 <span class="badge">${list.name}</span></div><div class="card-sub">${list.symbols.length} 只股票 · 实时价格来自延迟 SIP</div></div><button class="card-link" onClick=${() => navigate("/watchlist")}>管理自选 →</button></div>
    ${assets.length ? html`<div class="table-wrap" style="margin-top:8px"><table class="table table-compact">
      <thead><tr><th>股票</th><th class="r">最新价</th><th class="r">涨跌幅</th><th class="r col-volume">成交量</th><th class="col-actions"></th></tr></thead>
      <tbody>${assets.map((asset) => {
        const live = applyTick(asset, ticks[asset.symbol]);
        return html`<tr style="cursor:pointer" onClick=${() => navigate(stockPath(asset.symbol))}>
          <td><div class="sym-cell"><${Logo} symbol=${asset.symbol} /><div><div class="sym">${asset.symbol}</div><div class="nm">${asset.name}</div></div></div></td>
          <td class="r"><b>${live.price != null ? fmt.price(live.price) : "—"}</b></td>
          <td class=${cls("r", toneClass(live.change_pct))}>${live.change_pct != null ? fmt.pct(live.change_pct) : "—"}</td>
          <td class="r col-volume">${live.volume != null ? fmt.compact(live.volume) : "—"}</td>
          <td class="r col-actions"><${WatchStar} symbol=${asset.symbol} /></td>
        </tr>`;
      })}</tbody>
    </table></div>` : html`<${Empty} icon="star" title="列表还是空的" description="添加股票后，这里会显示实时价格。" />`}
  <//>`;
}

function ActivesCard({ actives, ticks }) {
  return html`<${Card}>
    <div class="card-head"><div><div class="card-title">成交量榜</div><div class="card-sub">Alpaca 筛选器 · 按当日成交量排序，价格低于 $0.5 的标的不展示</div></div><${Badge} tone="neutral">SCREENER<//></div>
    ${actives.length ? html`<div class="table-wrap" style="margin-top:8px"><table class="table table-compact">
      <thead><tr><th>#</th><th>股票</th><th class="r">最新价</th><th class="r">涨跌幅</th><th class="r col-volume">成交量</th><th class="col-actions"></th></tr></thead>
      <tbody>${actives.map((item, index) => {
        const live = applyTick(item, ticks[item.symbol]);
        return html`<tr style="cursor:pointer" onClick=${() => navigate(stockPath(item.symbol))}>
          <td><span class="rank">${index + 1}</span></td>
          <td><div class="sym-cell"><${Logo} symbol=${item.symbol} /><div><div class="sym">${item.symbol}</div><div class="nm">${item.name}</div></div></div></td>
          <td class="r"><b>${live.price != null ? fmt.price(live.price) : "—"}</b></td>
          <td class=${cls("r", toneClass(live.change_pct))}>${live.change_pct != null ? fmt.pct(live.change_pct) : "—"}</td>
          <td class="r text-muted col-volume">${live.volume != null ? fmt.compact(live.volume) : "—"}</td>
          <td class="r col-actions"><${WatchStar} symbol=${item.symbol} /></td>
        </tr>`;
      })}</tbody>
    </table></div>` : html`<${LoadingRow} label="正在读取成交量榜…" />`}
  <//>`;
}

function MoversCard({ movers, ticks }) {
  const [tab, setTab] = useState("gainers");
  const rows = tab === "gainers" ? movers?.gainers || [] : movers?.losers || [];
  return html`<${Card}>
    <div class="card-head">
      <div><div class="card-title">涨跌榜</div><div class="card-sub">筛选器返回的当日波动最大标的</div></div>
      <div class="seg">
        <button class=${cls(tab === "gainers" && "active")} onClick=${() => setTab("gainers")}>涨幅</button>
        <button class=${cls(tab === "losers" && "active")} onClick=${() => setTab("losers")}>跌幅</button>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:8px"><table class="table table-compact">
      <thead><tr><th>股票</th><th class="r">最新价</th><th class="r col-change">涨跌</th><th class="r">涨跌幅</th><th class="col-actions"></th></tr></thead>
      <tbody>${rows.length ? rows.map((item) => {
        const live = applyTick(item, ticks[item.symbol]);
        return html`<tr style="cursor:pointer" onClick=${() => navigate(stockPath(item.symbol))}>
          <td><div class="sym-cell"><${Logo} symbol=${item.symbol} /><div><div class="sym">${item.symbol}</div><div class="nm">${item.name}</div></div></div></td>
          <td class="r"><b>${live.price != null ? fmt.price(live.price) : "—"}</b></td>
          <td class=${cls("r col-change", toneClass(live.change))}>${live.change != null ? fmt.moneySigned(live.change) : "—"}</td>
          <td class=${cls("r", toneClass(live.change_pct))}>${live.change_pct != null ? fmt.pct(live.change_pct) : "—"}</td>
          <td class="r col-actions"><${WatchStar} symbol=${item.symbol} /></td>
        </tr>`;
      }) : html`<tr><td colspan="5"><${LoadingRow} label="正在读取涨跌榜…" /></td></tr>`}</tbody>
    </table></div>
  <//>`;
}

function NewsCard({ news }) {
  return html`<${Card}>
    <div class="card-head"><div><div class="card-title">市场新闻</div><div class="card-sub">Alpaca 新闻 API · 按发布时间排序</div></div><${Icon} name="news" size=${16} className="muted" /></div>
    <div class="card-body" style="padding-top:6px">
      ${news?.length ? news.slice(0, 6).map((item) => html`<article class="news-item">
        ${item.image ? html`<img class="news-thumb" src=${item.image} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${(event) => { event.currentTarget.style.visibility = "hidden"; }} />` : html`<span class="news-thumb placeholder"><${Icon} name="news" size=${18} /></span>`}
        <div class="news-body">
          <div class="news-source"><span>${item.source}</span><span>·</span><span>${fmt.ago(item.created_at)}</span></div>
          <a class="news-title" href=${item.url || "#"} target="_blank" rel="noreferrer">${item.headline}</a>
          ${item.symbols?.length ? html`<div class="news-symbols">${item.symbols.slice(0, 3).map((symbol) => html`<span>${symbol}</span>`)}</div>` : null}
        </div>
      </article>`) : html`<${LoadingRow} label="正在读取新闻…" />`}
    </div>
  <//>`;
}

function CryptoCard({ crypto }) {
  const iconFor = (symbol) => symbol?.startsWith("BTC") ? "₿" : symbol?.startsWith("ETH") ? "Ξ" : "◎";
  return html`<${Card}>
    <div class="card-head"><div><div class="card-title">加密资产</div><div class="card-sub">Alpaca 加密行情 · 24 小时市场</div></div><${Badge} tone="neutral">CRYPTO<//></div>
    <div class="card-body" style="padding-top:8px">
      ${crypto?.length ? crypto.map((item) => html`<div class="crypto-row" style="cursor:pointer" onClick=${() => navigate(`/crypto/${encodeURIComponent(item.symbol)}`)}>
        <span class=${cls("crypto-icon", item.symbol.startsWith("ETH") && "eth", item.symbol.startsWith("SOL") && "sol")}>${iconFor(item.symbol)}</span>
        <div class="crypto-meta"><b>${item.name}</b><span>${item.symbol}</span></div>
        <div class="crypto-quote"><b>${fmt.money(item.price)}</b><span class=${toneClass(item.change_pct)}>${fmt.pct(item.change_pct)}</span></div>
      </div>`) : html`<div class="text-sm text-muted">加密行情暂不可用</div>`}
    </div>
  <//>`;
}

function CalendarCard({ calendar }) {
  const rows = calendar?.upcoming || [];
  const today = calendar?.today;
  return html`<${Card}>
    <div class="card-head"><div><div class="card-title">交易日历</div><div class="card-sub">Alpaca 市场日历 · 美东时间</div></div><${Icon} name="calendar" size=${16} className="muted" /></div>
    <div class="card-body" style="padding-top:8px">
      ${rows.slice(0, 5).map((item) => html`<div class="calendar-row">
        <div class="date"><b>${dateShort(item.date)}</b>${item.date === today ? html`<${Badge} tone="green">今天<//>` : null}</div>
        <span>${timeRange(item.open, item.close)}${isEarlyClose(item.close) ? " · 提前收盘" : ""}</span>
      </div>`)}
    </div>
  <//>`;
}

export function MarketPage() {
  const store = useStore();
  const overview = store.overview;
  const watchlist = store.watchlists[0];
  useDocumentTitle("市场总览");
  const { data: history, reload: reloadHistory } = useAsync(() => api("/api/account/history?period=1M"), []);
  const watchSymbols = watchlist?.symbols || [];
  const { data: watchQuotes } = useAsync(
    () => (watchSymbols.length ? api(`/api/quotes?symbols=${encodeURIComponent(watchSymbols.join(","))}`) : Promise.resolve([])),
    [watchlist?.id, watchSymbols.join(",")],
  );

  useEffect(() => {
    loadOverview();
    loadWatchlists();
    refreshTrading({ silent: true });
  }, []);

  const symbols = useMemo(() => {
    const list = new Set();
    for (const item of overview?.indices || []) list.add(item.symbol);
    for (const item of overview?.actives || []) list.add(item.symbol);
    for (const item of [...(overview?.movers?.gainers || []), ...(overview?.movers?.losers || [])]) list.add(item.symbol);
    for (const asset of watchlist?.assets || []) list.add(asset.symbol);
    return [...list].filter(Boolean).slice(0, 55);
  }, [overview, watchlist]);

  const { ticks, status } = useLive(symbols);
  const quoteMap = Object.fromEntries((watchQuotes || []).map((item) => [item.symbol, item]));
  const watchlistWithQuotes = watchlist
    ? { ...watchlist, assets: (watchlist.assets || []).map((asset) => ({ ...asset, ...(quoteMap[asset.symbol] || {}) })) }
    : null;

  const clock = overview?.clock;
  const sessionText = clock?.is_open ? "交易中" : SESSION_LABEL[clock?.session] || "休市";
  const streamText = status.state === "connected" ? "行情已连接" : status.state === "error" ? "行情受限" : status.state === "reconnecting" ? "行情重连中" : "行情连接中";

  return html`<div>
    <${PageHead}
      eyebrow=${`市场总览 · ${new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" })}`}
      title="今天的市场，一屏看懂"
      sub="实时（延迟）行情、成交量榜、涨跌榜、自选、新闻和账户状态都来自 Alpaca。"
      actions=${html`
        <span class=${cls("market-state")} title=${status.message || ""}><span class=${cls("dot", status.state === "connected" ? "live" : status.state === "reconnecting" || status.state === "error" ? "warn" : "")} />${streamText}<small>${sessionText}</small></span>
        <button class="btn btn-sm" onClick=${() => { loadOverview(true); refreshTrading({ silent: true }); reloadHistory(); }}><${Icon} name="refresh" size=${14} />刷新</button>
      `}
    />

    ${store.overviewError && html`<${ErrorBanner} message=${store.overviewError} onRetry=${() => loadOverview(true)} />`}

    <div class="market-top mb-12">
      <${AccountHero} account=${store.account} positions=${store.positions} history=${history} status=${status} />
      <${ClockCard} clock=${clock} />
    </div>

    <div class="grid grid-4 mb-12">
      ${(overview?.indices || []).map((item) => html`<${IndexCard} item=${item} tick=${ticks[item.symbol]} />`)}
      ${!overview && html`${[1, 2, 3, 4].map(() => html`<${Card} className="card-pad"><${Skeleton} lines=${2} /><div class="skeleton sk-block" style="margin-top:10px;height:34px" /><//>`)}`}
    </div>

    <div class="market-layout">
      <div class="stack">
        <${WatchlistPeek} list=${watchlistWithQuotes} ticks=${ticks} />
        <${ActivesCard} actives=${overview?.actives || []} ticks=${ticks} />
        <${MoversCard} movers=${overview?.movers} ticks=${ticks} />
      </div>
      <div class="stack">
        <${NewsCard} news=${overview?.news} />
        <${CryptoCard} crypto=${overview?.crypto} />
        <${CalendarCard} calendar=${overview?.calendar} />
        <div class="card card-pad">
          <div class="card-title" style="margin-bottom:6px">学习提示</div>
          <p class="text-sm text-muted" style="line-height:1.65">行情来自 Alpaca 延迟 SIP 综合数据，约滞后 15 分钟。所有下单都进入纸面账户，不涉及真实资金。用这里的指标练习判断，而不是追求“抓涨停”。</p>
          <div class="row" style="margin-top:10px"><${Badge} tone="green">PAPER ONLY<//><button class="card-link" onClick=${() => navigate("/account")}>数据说明 →</button></div>
        </div>
      </div>
    </div>
  </div>`;
}
