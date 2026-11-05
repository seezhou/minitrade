import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass } from "../utils.js";
import { useAsync, useDocumentTitle } from "../hooks.js";
import { useLive } from "../stream.js";
import { loadWatchlists, notify, openSearch, openTrade, refreshTrading, useStore } from "../store.js";
import { navigate, stockPath } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, Empty, ErrorBanner, Skeleton, LoadingRow, Logo, RangeBar, Tabs } from "../ui.js";
import { PriceChart, CompareChart, IVSmileChart, OptionTermChart, OptionHistoryChart } from "../charts.js";
import { OptionsStrategy, OptionPositions } from "../options-strategy.js";
import { WatchStar } from "../components/watch-star.js";

const RANGES = ["1D", "5D", "1M", "3M", "6M", "1Y", "5Y"];
const RANGE_SESSIONS = { "1M": 21, "3M": 63, "6M": 126, "1Y": 252 };
const TABS = [
  { key: "overview", label: "概览" },
  { key: "analysis", label: "分析" },
  { key: "news", label: "新闻" },
  { key: "actions", label: "分红拆股" },
  { key: "options", label: "期权链", options: true },
  { key: "orders", label: "订单" },
];

function liveValue(snapshot, tick, key, fallback) {
  const value = tick?.[key];
  if (value != null) return value;
  if (snapshot?.[key] != null) return snapshot[key];
  return fallback;
}

function livePrice(snapshot, tick) {
  return tick?.price ?? snapshot?.price ?? null;
}

export function StockPage({ symbol, tab = "overview" }) {
  const store = useStore();
  const activeTab = TABS.some((item) => item.key === tab) ? tab : "overview";
  const [range, setRange] = useState("1D");
  const [chartType, setChartType] = useState("candle");
  const [indicators, setIndicators] = useState({ ma: true, boll: false, rsi: false, macd: false });
  const [chartBars, setChartBars] = useState([]);
  const lastBarTime = useRef(null);
  const [chartLive, setChartLive] = useState({ price: null, ts: null });
  const lastChartLiveAt = useRef(0);

  const summaryQuery = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/summary`), [symbol]);
  const barsQuery = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/bars?range=${range}`), [symbol, range]);
  const newsQuery = useAsync(
    () => api(`/api/news?symbols=${encodeURIComponent(symbol)}&limit=16&content=true`),
    [symbol],
  );
  const { ticks, trades, status } = useLive([symbol], { focus: true });

  const summary = summaryQuery.data;
  const asset = summary?.asset;
  const snapshot = summary?.snapshot;
  const analysis = summary?.analysis;
  const tick = ticks[symbol] || {};
  const price = livePrice(snapshot, tick);
  const previousClose = snapshot?.previous_close;
  const session = snapshot?.session;
  const hasSession = Boolean(session);
  const change = price != null && previousClose ? price - previousClose : snapshot?.change;
  const changePct = change != null && previousClose ? change / previousClose : snapshot?.change_pct;
  const tradesAscending = trades.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  useDocumentTitle(asset ? `${symbol} ${asset.name || ""}` : symbol);

  useEffect(() => {
    loadWatchlists();
  }, []);

  useEffect(() => {
    if (activeTab !== "options") return undefined;
    const timer = setTimeout(() => {
      document.getElementById("options-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 160);
    return () => clearTimeout(timer);
  }, [activeTab, symbol, summary]);

  useEffect(() => {
    if (barsQuery.data?.bars) {
      setChartBars(barsQuery.data.bars);
      lastBarTime.current = barsQuery.data.bars.at(-1)?.time || null;
    }
  }, [barsQuery.data]);

  useEffect(() => {
    setChartBars([]);
    lastBarTime.current = null;
    setChartLive({ price: null, ts: null });
    lastChartLiveAt.current = 0;
  }, [range, symbol]);

  useEffect(() => {
    const nextPrice = Number(tick.price);
    const nextTs = tick.ts;
    if (!Number.isFinite(nextPrice) || !nextTs) return undefined;
    const apply = () => {
      lastChartLiveAt.current = Date.now();
      setChartLive((previous) => (previous.price === nextPrice ? previous : { price: nextPrice, ts: nextTs }));
    };
    const elapsed = Date.now() - lastChartLiveAt.current;
    if (elapsed >= 900) {
      apply();
      return undefined;
    }
    const timer = setTimeout(apply, 900 - elapsed);
    return () => clearTimeout(timer);
  }, [tick.price, tick.ts]);

  const liveBar = tick.bar;
  useEffect(() => {
    if (!liveBar?.time || !["1D", "5D"].includes(range)) return;
    if (liveBar.time === lastBarTime.current) return;
    lastBarTime.current = liveBar.time;
    setChartBars((previous) => {
      if (!previous.length) return previous;
      const next = previous.slice();
      const index = next.findIndex((bar) => bar.time === liveBar.time);
      if (index >= 0) next[index] = liveBar;
      else if (liveBar.time > next[next.length - 1].time) next.push(liveBar);
      return next;
    });
  }, [liveBar?.time, range]);

  const availableTabs = useMemo(() => {
    if (!asset) return TABS.filter((item) => !item.options);
    return asset.has_options ? TABS : TABS.filter((item) => !item.options);
  }, [asset]);

  useEffect(() => {
    if (tab === "options" && asset && !asset.has_options) navigate(stockPath(symbol, "overview"));
  }, [tab, asset, symbol]);

  if (summaryQuery.loading && !summary) return html`<${StockSkeleton} symbol=${symbol} />`;
  if (summaryQuery.error) {
    return html`<div>
      <${PageHead} eyebrow=${symbol} title="无法读取这只股票" />
      <div class="stack">
        <${ErrorBanner} message=${summaryQuery.error} onRetry=${summaryQuery.reload} />
        <${Card}><${Empty} icon="search" title="换一只股票试试" description="可以搜索代码或公司名称，例如 AAPL、NVDA、SPY。" action=${html`<button class="btn btn-primary btn-sm" onClick=${openSearch}>打开搜索</button>`} /><//>
      </div>
    </div>`;
  }
  if (!summary) return null;

  const barData = barsQuery.data;
  return html`<div>
    <div class="stock-head">
      <div class="stock-id">
        <${Logo} symbol=${symbol} size="xl" name=${asset.name} />
        <div>
          <div class="row" style="gap:9px">
            <h1>${symbol}</h1>
            <${Badge} tone=${asset.tradable ? "green" : "neutral"}>${asset.tradable ? "可交易" : "仅行情"}<//>
            ${asset.has_options ? html`<${Badge} tone="blue">期权<//>` : null}
          </div>
          <div class="name">${asset.name} · ${asset.exchange || "—"}</div>
          <div class="stock-tags">
            ${asset.fractionable ? html`<span class="chip">支持碎股</span>` : null}
            ${asset.shortable ? html`<span class="chip">可做空</span>` : null}
            ${asset.marginable ? html`<span class="chip">可融资</span>` : null}
            ${asset.easy_to_borrow ? html`<span class="chip">易借券</span>` : null}
          </div>
        </div>
      </div>
      <div>
        <div class="stock-price">
          <span class="big">${price != null ? fmt.price(price) : "—"}</span>
          <span class="delta ${toneClass(changePct)}">${change != null ? fmt.moneySigned(change) : "—"} ${changePct != null ? fmt.pct(changePct) : ""}</span>
          <span class="asof">${tick.ts ? `更新于 ${fmt.time(tick.ts)} ET` : snapshot?.feed_label || "延迟行情"}</span>
        </div>
        <div class="stock-head-actions" style="margin-top:9px">
          <${WatchStar} symbol=${symbol} size=${17} />
          <button class="btn btn-sm" onClick=${openSearch}><${Icon} name="search" size=${13} />切换股票</button>
          ${asset.has_options ? html`<button class="btn btn-sm" onClick=${() => {
            if (activeTab === "options") document.getElementById("option-strategy")?.scrollIntoView({ behavior: "smooth", block: "start" });
            else navigate(stockPath(symbol, "options"));
          }}><${Icon} name="layers" size=${13} />期权交易</button>` : null}
          <button class="btn btn-buy btn-sm" onClick=${() => openTrade(symbol, "buy")}>买入</button>
          <button class="btn btn-sell btn-sm" onClick=${() => openTrade(symbol, "sell")}>卖出</button>
        </div>
      </div>
    </div>

    <div class="fact-strip" title=${hasSession ? `今日盘中统计截至 ${fmt.time(session.to)} ET（延迟行情）` : ""}>
      <div><span>${hasSession ? "今开" : "昨开"}</span><strong>${fmt.price(hasSession ? session.open : liveValue(snapshot, tick, "open"))}</strong></div>
      <div><span>${hasSession ? "今日最高" : "昨日最高"}</span><strong>${fmt.price(hasSession ? session.high : liveValue(snapshot, tick, "high"))}</strong></div>
      <div><span>${hasSession ? "今日最低" : "昨日最低"}</span><strong>${fmt.price(hasSession ? session.low : liveValue(snapshot, tick, "low"))}</strong></div>
      <div><span>${hasSession ? "今日成交量" : "昨日成交量"}</span><strong>${(hasSession ? session.volume : snapshot?.volume) != null ? fmt.compact(hasSession ? session.volume : snapshot?.volume) : "—"}</strong></div>
      <div><span>买价</span><strong>${fmt.price(tick.bid ?? snapshot?.bid)} <small class="muted">${tick.bid_size ?? snapshot?.bid_size ?? ""}</small></strong></div>
      <div><span>卖价</span><strong>${fmt.price(tick.ask ?? snapshot?.ask)} <small class="muted">${tick.ask_size ?? snapshot?.ask_size ?? ""}</small></strong></div>
      <div><span>价差</span><strong>${snapshot?.spread != null ? fmt.price(snapshot.spread) : "—"}</strong></div>
      <div><span>${hasSession ? "今日VWAP" : "昨日VWAP"}</span><strong>${fmt.price(hasSession ? session.vwap : snapshot?.vwap)}</strong></div>
    </div>
    ${hasSession && html`<div class="text-xs text-muted" style="margin:-6px 0 10px;text-align:right">盘中统计截至 ${fmt.time(session.to)} ET · 延迟行情</div>`}

    <div class="stock-layout">
      <div class="stack">
        <${Card} className="chart-card">
          <div class="chart-toolbar">
            <div class="row wrap">
              <div class="range-tabs">
                ${RANGES.map((item) => html`<button class=${cls(range === item && "active")} onClick=${() => setRange(item)}>${item}</button>`)}
              </div>
              <div class="seg">
                <button class=${cls(chartType === "candle" && "active")} onClick=${() => setChartType("candle")}>K 线</button>
                <button class=${cls(chartType === "area" && "active")} onClick=${() => setChartType("area")}>面积</button>
              </div>
            </div>
            <div class="chart-actions">
              <${IndicatorMenu} value=${indicators} onChange=${setIndicators} />
              <button class="btn btn-ghost btn-icon btn-sm" onClick=${barsQuery.reload} title="刷新图表"><${Icon} name="refresh" size=${14} /></button>
            </div>
          </div>
          ${barsQuery.error ? html`<${ErrorBanner} message=${barsQuery.error} onRetry=${barsQuery.reload} />` : null}
          ${barsQuery.loading && chartBars.length === 0 ? html`<div class="chart-empty"><span class="spinner" />正在加载行情…</div>` : html`<${PriceChart}
            bars=${chartBars}
            range=${range}
            displayFrom=${barData?.display_from}
            previousClose=${previousClose}
            indicators=${indicators}
            chartType=${chartType}
            livePrice=${chartLive.price}
            liveTs=${chartLive.ts}
          />`}
          <div class="chart-foot">
            <span>${barData?.range_label || range} · ${barData?.interval || "—"} · ${barData?.source_feed === "iex" ? "IEX 行情" : "SIP 历史综合行情"}</span>
            <span>延迟约 15 分钟 · 日线以上按拆股/分红复权 · 灰色区域为盘前/盘后</span>
          </div>
        <//>

        <${Card}>
          <${Tabs} tabs=${availableTabs} value=${activeTab} onChange=${(key) => navigate(stockPath(symbol, key))} />
          <div class="card-body">
            ${activeTab === "overview" && html`<${OverviewTab} summary=${summary} news=${newsQuery.data || []} symbol=${symbol} tick=${tick} trades=${tradesAscending} />`}
            ${activeTab === "analysis" && html`<${AnalysisTab} summary=${summary} symbol=${symbol} />`}
            ${activeTab === "news" && html`<${NewsTab} news=${newsQuery.data || []} loading=${newsQuery.loading} error=${newsQuery.error} reload=${newsQuery.reload} />`}
            ${activeTab === "actions" && html`<${ActionsTab} symbol=${symbol} />`}
            ${activeTab === "options" && html`<${OptionsTab} symbol=${symbol} spot=${price} />`}
            ${activeTab === "orders" && html`<${OrdersTab} symbol=${symbol} />`}
          </div>
        <//>
      </div>

      <div class="stock-rail stack">
        <${Card} className="rail-card">
          <div class="rail-title">快速交易 <span class="badge badge-green">纸面</span></div>
          <div class="quick-trade">
            <div class="price-hint"><span>最新</span><b class="tabular">${fmt.price(price)}</b></div>
            <div class="row2">
              <button class="btn btn-buy" onClick=${() => openTrade(symbol, "buy")}>买入</button>
              <button class="btn btn-sell" onClick=${() => openTrade(symbol, "sell")}>卖出</button>
            </div>
            <div class="price-hint"><span>买 / 卖</span><b class="tabular">${fmt.price(tick.bid ?? snapshot?.bid)} / ${fmt.price(tick.ask ?? snapshot?.ask)}</b></div>
            <button class="btn btn-sm btn-block" onClick=${openSearch}>查找其他股票</button>
          </div>
        <//>

        <${Card} className="rail-card">
          <div class="rail-title">关键数据 <span class="text-xs text-muted">${snapshot?.feed_label || ""}</span></div>
          <div class="key-stats">
            <div><span>昨收</span><strong>${fmt.price(previousClose)}</strong></div>
            <div><span>${hasSession ? "今日开盘" : "昨日开盘"}</span><strong>${fmt.price(hasSession ? session.open : snapshot?.open)}</strong></div>
            <div><span>${hasSession ? "今日最高" : "昨日最高"}</span><strong>${fmt.price(hasSession ? session.high : snapshot?.high)}</strong></div>
            <div><span>${hasSession ? "今日最低" : "昨日最低"}</span><strong>${fmt.price(hasSession ? session.low : snapshot?.low)}</strong></div>
            <div><span>${hasSession ? "今日成交量" : "昨日成交量"}</span><strong>${fmt.compact(hasSession ? session.volume : snapshot?.volume)}</strong></div>
            <div><span>20 日均量</span><strong>${fmt.compact(analysis?.avg_volume_20)}</strong></div>
            <div><span>RSI(14)</span><strong>${analysis?.rsi14 != null ? analysis.rsi14.toFixed(1) : "—"}</strong></div>
            <div><span>Beta (1Y)</span><strong>${analysis?.beta != null ? analysis.beta.toFixed(2) : "—"}</strong></div>
          </div>
          <${RangeBar} low=${hasSession ? session.low : snapshot?.low} high=${hasSession ? session.high : snapshot?.high} value=${price} left="日内低" right="日内高" />
          ${analysis?.ready ? html`<${RangeBar} low=${analysis.low_52w} high=${analysis.high_52w} value=${price} left="52 周低" right="52 周高" />` : null}
        <//>

        <${Card} className="rail-card">
          <div class="rail-title">实时成交 <span class=${cls("dot", status.state === "connected" ? "live" : "warn")} /></div>
          ${tradesAscending.length ? html`<div class="tape-list">
            ${tradesAscending.slice(-18).reverse().map((trade, index, reversed) => {
              const comparable = reversed[index + 1]?.price;
              return html`<div class="tape-row">
                <span class=${cls(toneClass(comparable == null ? 0 : trade.price - comparable))}>${fmt.price(trade.price)}</span>
                <span class="size">${fmt.num(trade.size)}</span>
                <span class="time">${fmt.time(trade.ts)}</span>
              </div>`;
            })}
          </div>` : html`<div class="text-sm text-muted" style="padding:8px 0">等待成交推送…（延迟 SIP 实时流）</div>`}
        <//>

        <${Card} className="rail-card">
          <div class="rail-title">公司档案</div>
          <div class="key-stats">
            <div><span>交易所</span><strong>${asset.exchange}</strong></div>
            <div><span>资产类别</span><strong>美股</strong></div>
            <div><span>可交易</span><strong>${asset.tradable ? "是" : "否"}</strong></div>
            <div><span>支持碎股</span><strong>${asset.fractionable ? "是" : "否"}</strong></div>
            <div><span>可做空</span><strong>${asset.shortable ? "是" : "否"}</strong></div>
            <div><span>期权</span><strong>${asset.has_options ? "有" : "无"}</strong></div>
          </div>
          <p class="text-xs text-muted" style="margin-top:10px;line-height:1.55">Alpaca 只提供交易属性，不提供公司简介、市值和财务数据。本页所有估值相关空白都不做虚构填充。</p>
        <//>
      </div>
    </div>
  </div>`;
}

function IndicatorMenu({ value, onChange }) {
  function toggle(key) {
    onChange({ ...value, [key]: !value[key] });
  }
  return html`<details class="indicator-menu">
    <summary><${Icon} name="layers" size=${13} />指标<${Icon} name="chevronDown" size=${12} /></summary>
    <div class="indicator-pop">
      <label><input type="checkbox" checked=${value.ma} onChange=${() => toggle("ma")} />均线 MA5/10/20/50/200</label>
      <label><input type="checkbox" checked=${value.boll} onChange=${() => toggle("boll")} />布林带 BOLL(20,2)</label>
      <label><input type="checkbox" checked=${value.rsi} onChange=${() => toggle("rsi")} />RSI(14)</label>
      <label><input type="checkbox" checked=${value.macd} onChange=${() => toggle("macd")} />MACD(12,26,9)</label>
    </div>
  </details>`;
}

function StockSkeleton({ symbol }) {
  return html`<div>
    <div class="stock-head"><div class="stock-id"><div class="skeleton" style="width:56px;height:56px;border-radius:14px" /><div><div class="skeleton sk-line" style="width:90px;height:18px" /><div class="skeleton sk-line" style="width:220px;margin-top:8px" /></div></div></div>
    <div class="fact-strip">${Array.from({ length: 8 }).map(() => html`<div><div class="skeleton sk-line" style="width:40px" /><div class="skeleton sk-line" style="width:62px;margin-top:7px" /></div>`)}</div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) 310px">
      <${Card}><div class="card-pad"><div class="skeleton" style="height:400px" /></div><//>
      <div class="stack"><${Card}><div class="card-pad"><${Skeleton} lines=${5} /></div><//></div>
    </div>
    <div class="text-sm text-muted" style="margin-top:10px">正在读取 ${symbol} 的行情与分析…</div>
  </div>`;
}

function OverviewTab({ summary, news, symbol, tick, trades }) {
  const analysis = summary.analysis || {};
  return html`<div class="stack">
    <div>
      <div class="card-title" style="margin-bottom:9px">区间表现</div>
      ${analysis.ready ? html`<div class="perf-grid">
        ${[["1W", "近 1 周"], ["1M", "近 1 月"], ["3M", "近 3 月"], ["6M", "近 6 月"], ["1Y", "近 1 年"], ["YTD", "年初至今"]].map(([key, label]) => html`<div class="perf"><span>${label}</span><strong class=${toneClass(analysis.returns?.[key])}>${analysis.returns?.[key] != null ? fmt.pct(analysis.returns[key]) : "—"}</strong></div>`)}
      </div>` : html`<div class="text-sm text-muted">历史数据不足。</div>`}
    </div>

    <div class="grid-2" style="gap:14px">
      <div>
        <div class="card-title" style="margin-bottom:8px">多因子信号</div>
        ${analysis.ready ? analysis.signals.map((signal) => html`<div class="signal-row">
          <span class=${cls("signal-dot", signal.tone)} />
          <div class="signal-main"><b>${signal.label}</b><span>${signal.note}</span></div>
          ${signal.value && html`<span class="signal-value">${signal.value}</span>`}
        </div>`) : html`<div class="text-sm text-muted">暂无信号。</div>`}
      </div>
      <div>
        <div class="card-title" style="margin-bottom:8px">关键统计</div>
        <div class="key-stats">
          <div><span>52 周高</span><strong>${fmt.price(analysis.high_52w)}</strong></div>
          <div><span>52 周低</span><strong>${fmt.price(analysis.low_52w)}</strong></div>
          <div><span>年化波动率</span><strong>${analysis.volatility != null ? fmt.pctPlain(analysis.volatility) : "—"}</strong></div>
          <div><span>最大回撤</span><strong class="negative">${analysis.max_drawdown != null ? fmt.pctPlain(analysis.max_drawdown) : "—"}</strong></div>
          <div><span>50 日均线</span><strong>${fmt.price(analysis.sma50)}</strong></div>
          <div><span>200 日均线</span><strong>${fmt.price(analysis.sma200)}</strong></div>
        </div>
        ${analysis.ready ? html`<div class="text-xs text-muted" style="margin-top:10px;line-height:1.55">基于 ${analysis.sessions} 个交易日的复权日线计算，仅用于学习。</div>` : null}
      </div>
    </div>

    <div>
      <div class="row-between" style="margin-bottom:6px"><div class="card-title">相关新闻</div><button class="card-link" onClick=${() => navigate(stockPath(symbol, "news"))}>查看全部 →</button></div>
      ${news.length ? news.slice(0, 3).map((item) => html`<article class="news-item">
        ${item.image ? html`<img class="news-thumb" src=${item.image} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${(event) => { event.currentTarget.style.visibility = "hidden"; }} />` : html`<span class="news-thumb placeholder"><${Icon} name="news" size=${18} /></span>`}
        <div class="news-body"><div class="news-source">${item.source} · ${fmt.ago(item.created_at)}</div><a class="news-title" href=${item.url} target="_blank" rel="noreferrer">${item.headline}</a></div>
      </article>`) : html`<div class="text-sm text-muted">暂时没有相关新闻。</div>`}
    </div>

    <div class="modal-note">价格来自 Alpaca 延迟 SIP 行情；分析指标由历史日线计算，不构成投资建议。</div>
  </div>`;
}

function AnalysisTab({ summary, symbol }) {
  const analysis = summary.analysis || {};
  const [compareRange, setCompareRange] = useState("1Y");
  const { data: optionOverview } = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/options/overview`), [symbol]);
  if (!analysis.ready) {
    return html`<${Empty} icon="activity" title="分析数据还不够" description="这只股票的历史日线不足 30 个交易日，暂时无法计算风险与动量指标。" />`;
  }
  return html`<div class="stack">
    <div>
      <div class="row-between" style="margin-bottom:9px"><div class="card-title">风险与动量</div><span class="text-xs text-muted">基于 ${analysis.sessions} 个交易日</span></div>
      <div class="metric-grid">
        <div class="metric"><span>年化波动率</span><strong>${analysis.volatility != null ? fmt.pctPlain(analysis.volatility) : "—"}</strong><small>日收益标准差 × √252</small></div>
        <div class="metric"><span>Beta vs SPY</span><strong>${analysis.beta != null ? analysis.beta.toFixed(2) : "—"}</strong><small>与标普 500 ETF 的相关波动</small></div>
        <div class="metric"><span>Sharpe</span><strong>${analysis.sharpe != null ? analysis.sharpe.toFixed(2) : "—"}</strong><small>无风险利率按 0 简化</small></div>
        <div class="metric"><span>最大回撤</span><strong class="negative">${analysis.max_drawdown != null ? fmt.pctPlain(analysis.max_drawdown) : "—"}</strong><small>近一年峰值回落</small></div>
        <div class="metric"><span>相关系数</span><strong>${analysis.correlation_spy != null ? analysis.correlation_spy.toFixed(2) : "—"}</strong><small>与 SPY 的日收益相关性</small></div>
        <div class="metric"><span>ATR(14)</span><strong>${analysis.atr14 != null ? fmt.price(analysis.atr14) : "—"}</strong><small>平均真实波幅</small></div>
      </div>
    </div>

    <div>
      <div class="row-between" style="margin-bottom:8px">
        <div><div class="card-title">相对表现</div><div class="card-sub">以区间起点 = 100 归一化，对比 SPY 与 QQQ</div></div>
        <div class="seg">
          ${["1M", "3M", "6M", "1Y"].map((key) => html`<button class=${cls(compareRange === key && "active")} onClick=${() => setCompareRange(key)}>${key}</button>`)}
        </div>
      </div>
      <${CompareChart} compare=${analysis.compare} sessions=${RANGE_SESSIONS[compareRange] || 252} />
    </div>

    <div>
      <div class="card-title" style="margin-bottom:8px">因子明细</div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>维度</th><th>数值</th><th>解读</th></tr></thead>
        <tbody>
          <tr><td>动量 · RSI(14)</td><td><b>${analysis.rsi14 != null ? analysis.rsi14.toFixed(1) : "—"}</b></td><td class="text-muted">${analysis.rsi14 > 70 ? "超买区间，警惕回调" : analysis.rsi14 < 30 ? "超卖区间，关注反弹" : "中性区间"}</td></tr>
          <tr><td>趋势 · 50/200 日</td><td><b>${fmt.price(analysis.sma50)} / ${fmt.price(analysis.sma200)}</b></td><td class="text-muted">${analysis.sma50 > analysis.sma200 ? "多头排列（金叉结构）" : "空头排列（死叉结构）"}</td></tr>
          <tr><td>流动性 · 20 日均量</td><td><b>${fmt.compact(analysis.avg_volume_20)}</b></td><td class="text-muted">20 日平均成交股数，日均成交额约 ${fmt.compact(analysis.dollar_volume)} 美元</td></tr>
          <tr><td>区间 · 52 周位置</td><td><b>${analysis.range_position != null ? `${(analysis.range_position * 100).toFixed(0)}%` : "—"}</b></td><td class="text-muted">${fmt.price(analysis.low_52w)} – ${fmt.price(analysis.high_52w)}</td></tr>
          <tr><td>波动 · ATR</td><td><b>${fmt.price(analysis.atr14)}</b></td><td class="text-muted">约占现价 ${analysis.atr14 && analysis.price ? fmt.pctPlain(analysis.atr14 / analysis.price) : "—"} 的日均波动</td></tr>
          <tr><td>期权 · ATM IV</td><td><b>${optionOverview?.available ? fmt.pctPlain(optionOverview.atm_call_iv) : "—"}</b></td><td class="text-muted">${optionOverview?.available ? `最近到期 ${optionOverview.expiration}，看跌/看涨成交量比 ${optionOverview.put_call_ratio != null ? optionOverview.put_call_ratio.toFixed(2) : "—"}` : "当前账户或标的没有可用期权数据"}</td></tr>
        </tbody>
      </table></div>
    </div>

    <div class="grid-2" style="gap:14px">
      <div>
        <div class="card-title" style="margin-bottom:8px">信号解释</div>
        ${analysis.signals.map((signal) => html`<div class="signal-row"><span class=${cls("signal-dot", signal.tone)} /><div class="signal-main"><b>${signal.label} ${signal.value ? `· ${signal.value}` : ""}</b><span>${signal.note}</span></div></div>`)}
      </div>
      <div class="modal-note" style="align-self:start">
        这些指标只描述历史价格行为，不能预测未来。Beta、波动率和回撤都依赖所选窗口；改变窗口会改变结论。真实交易还要考虑仓位、成本和流动性。
      </div>
    </div>
  </div>`;
}

function NewsTab({ news, loading, error, reload }) {
  const [expanded, setExpanded] = useState(null);
  if (error) return html`<${ErrorBanner} message=${error} onRetry=${reload} />`;
  if (loading && !news.length) return html`<${LoadingRow} label="正在读取相关新闻…" />`;
  if (!news.length) return html`<${Empty} icon="news" title="暂时没有新闻" description="Alpaca 新闻源没有返回这只股票的近期新闻。" />`;
  return html`<div class="stack">
    ${news.map((item) => html`<article class="news-item" style="grid-template-columns:96px minmax(0,1fr)">
      ${item.image ? html`<img class="news-thumb" style="width:96px;height:70px" src=${item.image} alt="" loading="lazy" referrerpolicy="no-referrer" onError=${(event) => { event.currentTarget.style.visibility = "hidden"; }} />` : html`<span class="news-thumb placeholder" style="width:96px;height:70px"><${Icon} name="news" size=${20} /></span>`}
      <div class="news-body">
        <div class="news-source">${item.source} · ${fmt.ago(item.created_at)} ${item.author ? `· ${item.author}` : ""}</div>
        <a class="news-title" style="font-size:13px;-webkit-line-clamp:3" href=${item.url} target="_blank" rel="noreferrer">${item.headline}</a>
        ${item.summary && html`<p class="text-sm text-muted" style="margin-top:5px;line-height:1.55">${item.summary}</p>`}
        ${item.content && html`<div class="mt-8">
          <button class="card-link" onClick=${() => setExpanded(expanded === item.id ? null : item.id)}>${expanded === item.id ? "收起全文" : "展开全文"}</button>
          ${expanded === item.id && html`<div class="text-sm" style="margin-top:8px;line-height:1.7;color:var(--ink-2)">
            ${item.content.split(/\n{2,}/).slice(0, 12).map((paragraph) => html`<p style="margin:0 0 8px">${paragraph}</p>`)}
          </div>`}
        </div>`}
        <div class="news-symbols">${(item.symbols || []).slice(0, 5).map((symbol) => html`<span>${symbol}</span>`)}</div>
      </div>
    </article>`)}
  </div>`;
}

function ActionsTab({ symbol }) {
  const { data, loading, error, reload } = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/actions`), [symbol]);
  if (error) return html`<${ErrorBanner} message=${error} onRetry=${reload} />`;
  if (loading) return html`<${LoadingRow} label="正在读取公司行动…" />`;
  if (!data?.groups?.length) return html`<${Empty} icon="calendar" title="近期没有公司行动" description="Alpaca 公司行动接口没有返回这只股票最近三年的分红或拆股记录。" />`;
  return html`<div class="stack">
    ${data.groups.map((group) => html`<div>
      <div class="row-between" style="margin-bottom:8px"><div class="card-title">${group.title} <span class="badge">${group.items.length}</span></div></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>日期</th>${group.kind === "split" ? html`<th>比例</th>` : html`<th>每股金额</th>`}<th>记录日</th><th>支付日</th><th>备注</th></tr></thead>
        <tbody>${group.items.map((item) => html`<tr>
          <td><b>${item.date || "—"}</b></td>
          <td>${group.kind === "split" ? `${item.old_rate ?? "—"} → ${item.new_rate ?? "—"}` : item.rate != null ? fmt.money(item.rate, "USD", 4) : "—"}</td>
          <td class="text-muted">${item.record_date || "—"}</td>
          <td class="text-muted">${item.payable_date || "—"}</td>
          <td>${item.special ? html`<${Badge} tone="amber">特别<//>` : item.foreign ? html`<${Badge} tone="neutral">境外<//>` : "—"}</td>
        </tr>`)}</tbody>
      </table></div>
    </div>`)}
    <div class="modal-note">分红和拆股数据来自 Alpaca 公司行动接口，历史价格图表使用复权数据。分红税率、预扣税等以券商实际处理为准。</div>
  </div>`;
}

function OptionsTab({ symbol, spot }) {
  const [expiry, setExpiry] = useState(null);
  const [chainView, setChainView] = useState("atm");
  const [historyRange, setHistoryRange] = useState("1M");
  const expirationsQuery = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/options/expirations`), [symbol]);
  const expirations = expirationsQuery.data?.expirations || [];
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  useEffect(() => {
    if (!expiry && expirations.length) {
      const preferred = expirations.find((item) => item.expiration > todayEt) || expirations[0];
      setExpiry(preferred.expiration);
    }
  }, [expirations, expiry, todayEt]);
  const chainQuery = useAsync(
    () => (expiry ? api(`/api/stocks/${encodeURIComponent(symbol)}/options/chain?expiration=${expiry}&width=12${chainView === "full" ? "&full=true" : ""}`) : Promise.resolve(null)),
    [symbol, expiry, chainView],
    { enabled: Boolean(expiry) },
  );
  const chain = chainQuery.data;
  const hasGreeks = Boolean([...(chain?.calls || []), ...(chain?.puts || [])].some((item) => item.iv != null || item.delta != null));
  const termKey = expirations.slice(0, 6).map((item) => item.expiration).join(",");
  const ivTermQuery = useAsync(
    () => (termKey ? api(`/api/stocks/${encodeURIComponent(symbol)}/options/iv-term?expirations=${termKey}`) : Promise.resolve(null)),
    [symbol, termKey],
    { enabled: Boolean(termKey) },
  );
  const termPoints = ivTermQuery.data?.symbol === symbol ? (ivTermQuery.data?.points || []) : [];
  const historySources = useMemo(() => {
    const atm = chain?.atm_strike;
    if (atm == null) return [];
    const nearest = (rows) => (rows || []).filter((item) => item.symbol).reduce((best, item) => (best == null || Math.abs(item.strike - atm) < Math.abs(best.strike - atm) ? item : best), null);
    return [["call", nearest(chain.calls)], ["put", nearest(chain.puts)]]
      .filter(([, row]) => row)
      .map(([kind, row]) => ({
        symbol: row.symbol,
        label: `${kind === "call" ? "C" : "P"} ${fmt.num(row.strike, row.strike % 1 ? 2 : 0)}`,
      }));
  }, [chain]);
  const historyKey = historySources.map((item) => item.symbol).join(",");
  const historyQuery = useAsync(
    () => (historyKey ? api(`/api/stocks/${encodeURIComponent(symbol)}/options/history?contracts=${historyKey}&range=${historyRange}`) : Promise.resolve(null)),
    [symbol, historyKey, historyRange],
    { enabled: Boolean(historyKey) },
  );
  const historyContracts = useMemo(() => {
    if (historyQuery.data?.symbol !== symbol) return [];
    const labelBySymbol = new Map(historySources.map((item) => [item.symbol, item.label]));
    return (historyQuery.data?.contracts || [])
      .filter((item) => labelBySymbol.has(item.symbol))
      .map((item) => ({ ...item, label: labelBySymbol.get(item.symbol) }));
  }, [historyQuery.data, symbol, historySources]);

  if (expirationsQuery.loading) return html`<${LoadingRow} label="正在读取期权到期日…" />`;
  if (expirationsQuery.error) return html`<${ErrorBanner} message=${expirationsQuery.error} onRetry=${expirationsQuery.reload} />`;
  if (!expirations.length) {
    return html`<${Empty} icon="layers" title="没有可用的期权数据" description="当前 Alpaca 账户或这只标的没有返回期权链。期权数据需要相应的 OPRA 权限。" />`;
  }

  return html`<div class="stack" id="options-section">
    <div class="row-between">
      <div><div class="card-title">期权链</div><div class="card-sub">Alpaca 期权快照 · 含 Greeks 与隐含波动率 · 现价 ${fmt.price(spot || chain?.spot)}</div></div>
      <div class="row" style="gap:8px">
        <div class="seg">
          <button class=${cls(chainView === "atm" && "active")} onClick=${() => setChainView("atm")}>ATM ±12</button>
          <button class=${cls(chainView === "full" && "active")} onClick=${() => setChainView("full")}>完整链</button>
        </div>
        <${Badge} tone="blue">OPRA<//>
      </div>
    </div>
    <div class="option-expiries">
      ${expirations.map((item) => html`<button class=${cls("expiry-btn", expiry === item.expiration && "active")} onClick=${() => setExpiry(item.expiration)}>
        <b>${item.expiration}</b><span>${item.expiration === todayEt ? "当日到期 · " : ""}${item.contracts} 个合约</span>
      </button>`)}
    </div>

    ${chainQuery.error && html`<${ErrorBanner} message=${chainQuery.error} onRetry=${chainQuery.reload} />`}
    ${chain?.available ? html`<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">
      <div class="metric"><span>现价</span><strong>${fmt.price(chain.spot)}</strong></div>
      <div class="metric"><span>ATM 行权价</span><strong>${fmt.price(chain.atm_strike)}</strong></div>
      <div class="metric"><span>显示看涨成交量</span><strong>${fmt.compact((chain.calls || []).reduce((sum, item) => sum + (item.volume || 0), 0))}</strong></div>
      <div class="metric"><span>显示看跌成交量</span><strong>${fmt.compact((chain.puts || []).reduce((sum, item) => sum + (item.volume || 0), 0))}</strong></div>
    </div>` : null}
    ${chain?.available ? html`<div class="text-xs text-muted">当前显示 ${(chain.calls || []).length + (chain.puts || []).length} 个合约 · ${chain.full ? "完整链（该到期日全部 active 行权价）" : "ATM ±12 行权价"}</div>` : null}

    ${chain?.available && !hasGreeks ? html`<div class="error-banner" style="border-color:var(--badge-amber-ink);background:var(--badge-amber-bg);color:var(--badge-amber-ink)">
      这个到期日没有返回 IV / Greeks（当日到期合约常见）。切换到其他到期日可查看完整希腊字母与波动率微笑。
    </div>` : null}

    ${chain?.available ? html`<${OptionsStrategy} symbol=${symbol} chain=${chain} expiry=${expiry} spot=${spot || chain?.spot} />` : null}
    <${OptionPositions} symbol=${symbol} />

    ${chain?.available ? html`<div class="options-tables">
      <${OptionTable} title="看涨 CALL" rows=${chain.calls} atm=${chain.atm_strike} spot=${chain.spot} side="calls" autoCenter=${Boolean(chain.full)} />
      <${OptionTable} title="看跌 PUT" rows=${chain.puts} atm=${chain.atm_strike} spot=${chain.spot} side="puts" autoCenter=${Boolean(chain.full)} />
    </div>` : chainQuery.loading ? html`<${LoadingRow} label="正在读取期权链…" />` : html`<div class="text-sm text-muted">这个到期日没有返回合约。</div>`}

    ${chain?.available && hasGreeks ? html`<div>
      <div class="card-title" style="margin-bottom:2px">隐含波动率微笑</div>
      <div class="card-sub">横轴为行权价，纵轴为 IV。曲线越陡，市场对尾部风险的定价越高。</div>
      <${IVSmileChart} calls=${chain.calls} puts=${chain.puts} spot=${chain.spot} />
    </div>` : null}

    <div>
      <div class="card-title" style="margin-bottom:2px">IV Term Structure</div>
      <div class="card-sub">不同到期日的 ATM IV（看涨与看跌平均），曲线越陡表示远端不确定性定价越高。</div>
      ${ivTermQuery.loading && !termPoints.length
        ? html`<${LoadingRow} label="正在计算期限结构…" />`
        : ivTermQuery.error
          ? html`<${ErrorBanner} message=${ivTermQuery.error} onRetry=${ivTermQuery.reload} />`
          : termPoints.length
            ? html`<${OptionTermChart} points=${termPoints} />`
            : html`<${Empty} icon="activity" title="暂时没有 IV 期限结构" description="所选到期日没有返回可用的 ATM 隐含波动率（0DTE 常见）。" />`}
    </div>

    ${historyKey ? html`<div>
      <div class="row-between" style="margin-bottom:6px">
        <div>
          <div class="card-title">ATM 合约日线</div>
          <div class="card-sub">离 ATM 最近的看涨 / 看跌合约收盘价（OPRA 日线）</div>
        </div>
        <div class="seg">
          ${["1M", "3M", "6M"].map((item) => html`<button class=${cls(historyRange === item && "active")} onClick=${() => setHistoryRange(item)}>${item}</button>`)}
        </div>
      </div>
      ${historyQuery.loading && !historyContracts.length
        ? html`<${LoadingRow} label="正在读取合约日线…" />`
        : historyQuery.error
          ? html`<${ErrorBanner} message=${historyQuery.error} onRetry=${historyQuery.reload} />`
          : historyContracts.length
            ? html`<${OptionHistoryChart} contracts=${historyContracts} />`
            : html`<${Empty} icon="activity" title="没有合约日线" description="该到期日的 ATM 合约没有返回日线数据，换一个到期日或时间范围试试。" />`}
    </div>` : null}

    <div class="option-note">期权快照可能延迟；Greeks 和 IV 由 Alpaca 计算。深实值/深虚值合约可能没有 Greeks。期权交易风险高，本页只用于纸面账户学习，不构成投资建议。</div>
  </div>`;
}

function OptionTable({ title, rows = [], atm, spot, side, autoCenter = false }) {
  const scrollRef = useRef(null);
  const showOpenInterest = rows.some((item) => item.open_interest != null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !autoCenter) return;
    const target = node.querySelector("tr.atm");
    if (!target) return;
    const rowTop = target.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    node.scrollTop = Math.max(0, rowTop - node.clientHeight / 2 + target.offsetHeight / 2);
  }, [autoCenter, atm, rows]);

  return html`<div class=${cls("option-table", side)}>
    <div class="option-table-head"><span>${title}</span><span>成交量</span></div>
    <div class="option-scroll" ref=${scrollRef}><table>
      <thead><tr><th>行权价</th><th>最新</th><th>买/卖</th><th>IV</th><th>Delta</th>${showOpenInterest ? html`<th>持仓量</th>` : null}<th>量</th></tr></thead>
      <tbody>${rows.map((item) => html`<tr class=${cls(item.strike === atm && "atm", item.in_the_money && "itm")}>
        <td><b>${fmt.num(item.strike, item.strike % 1 ? 2 : 0)}</b></td>
        <td>${fmt.price(item.last)}</td>
        <td class="text-muted">${fmt.price(item.bid)} / ${fmt.price(item.ask)}</td>
        <td>${item.iv != null ? fmt.pctPlain(item.iv, 1) : "—"}</td>
        <td>${item.delta != null ? item.delta.toFixed(3) : "—"}</td>
        ${showOpenInterest ? html`<td>${item.open_interest != null ? fmt.compact(item.open_interest) : "—"}</td>` : null}
        <td>${fmt.compact(item.volume)}</td>
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}

function OrdersTab({ symbol }) {
  const store = useStore();
  const orders = store.orders.filter((order) => order.symbol === symbol);
  const open = orders.filter((order) => order.is_open);
  const closed = orders.filter((order) => !order.is_open).slice(0, 10);
  const position = store.positions.find((item) => item.symbol === symbol);
  async function closePosition() {
    if (!confirm(`确定要平掉 ${symbol} 的全部持仓吗？`)) return;
    try {
      await api(`/api/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
      notify(`已提交平仓 ${symbol}`, "success");
      await refreshTrading({ silent: true });
    } catch (error) {
      notify(error.message, "error");
    }
  }
  return html`<div class="stack">
    <div class="row-between">
      <div><div class="card-title">当前持仓</div><div class="card-sub">纸面账户中的 ${symbol} 持仓</div></div>
      <button class="btn btn-sm btn-primary" onClick=${() => openTrade(symbol, "buy")}>新订单</button>
    </div>
    ${position ? html`<div class="metric-grid">
      <div class="metric"><span>持有数量</span><strong>${fmt.num(position.qty, 4)}</strong></div>
      <div class="metric"><span>平均成本</span><strong>${fmt.price(position.avg_entry_price)}</strong></div>
      <div class="metric"><span>当前价格</span><strong>${fmt.price(position.current_price)}</strong></div>
      <div class="metric"><span>市值</span><strong>${fmt.money(position.market_value)}</strong></div>
      <div class="metric"><span>浮动盈亏</span><strong class=${toneClass(position.unrealized_pl)}>${fmt.moneySigned(position.unrealized_pl)}</strong></div>
      <div class="metric"><span>今日变化</span><strong class=${toneClass(position.change_today)}>${fmt.pct(position.change_today)}</strong></div>
    </div>
    <div><button class="btn btn-sm btn-danger" onClick=${closePosition}>平掉全部持仓</button></div>` : html`<div class="text-sm text-muted">当前没有 ${symbol} 持仓。</div>`}

    <div>
      <div class="card-title" style="margin-bottom:8px">未完成订单 <span class="badge">${open.length}</span></div>
      ${open.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>方向</th><th>类型</th><th class="r">数量</th><th class="r">价格</th><th>状态</th><th class="r">操作</th></tr></thead>
        <tbody>${open.map((order) => html`<tr>
          <td><${Badge} tone=${order.side === "buy" ? "green" : "red"}>${order.side === "buy" ? "买入" : "卖出"}<//></td>
          <td>${order.type}${order.extended_hours ? " · 延长" : ""}</td>
          <td class="r">${fmt.num(order.qty, 4)}</td>
          <td class="r">${order.limit_price ? fmt.price(order.limit_price) : order.stop_price ? fmt.price(order.stop_price) : "市价"}</td>
          <td>${order.status}</td>
          <td class="r"><button class="btn btn-sm" onClick=${async () => { try { await api(`/api/orders/${order.id}`, { method: "DELETE" }); notify("订单已取消"); await refreshTrading({ silent: true }); } catch (error) { notify(error.message, "error"); } }}>取消</button></td>
        </tr>`)}</tbody>
      </table></div>` : html`<div class="text-sm text-muted">没有未完成订单。</div>`}
    </div>

    <div>
      <div class="card-title" style="margin-bottom:8px">最近订单</div>
      ${closed.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>时间</th><th>方向</th><th class="r">数量</th><th class="r">成交均价</th><th>状态</th></tr></thead>
        <tbody>${closed.map((order) => html`<tr>
          <td class="text-muted">${fmt.dateTime(order.submitted_at || order.created_at)}</td>
          <td>${order.side === "buy" ? "买入" : "卖出"}</td>
          <td class="r">${fmt.num(order.filled_qty || order.qty, 4)}</td>
          <td class="r">${fmt.price(order.filled_avg_price)}</td>
          <td>${order.status}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<div class="text-sm text-muted">没有历史订单。</div>`}
    </div>

    <${IEXHistory} symbol=${symbol} />
  </div>`;
}

function IEXHistory({ symbol }) {
  const [view, setView] = useState("trades");
  const tradesQuery = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/trades?limit=100`), [symbol]);
  const quotesQuery = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/quotes?limit=100`), [symbol]);
  const trades = tradesQuery.data?.symbol === symbol ? (tradesQuery.data?.trades || []) : [];
  const quotes = quotesQuery.data?.symbol === symbol ? (quotesQuery.data?.quotes || []) : [];
  const isTrades = view === "trades";
  const active = isTrades ? tradesQuery : quotesQuery;
  const rows = isTrades ? trades : quotes;

  return html`<div>
    <div class="row-between" style="margin-bottom:8px">
      <div>
        <div class="card-title">最近逐笔 / 报价 <${Badge} tone="amber">IEX<//></div>
        <div class="card-sub">来自 IEX 交易所的逐笔成交与报价，非 consolidated SIP 全市场数据，条数与价格可能偏离综合行情。</div>
      </div>
      <div class="seg">
        <button class=${cls(isTrades && "active")} onClick=${() => setView("trades")}>逐笔 ${trades.length}</button>
        <button class=${cls(!isTrades && "active")} onClick=${() => setView("quotes")}>报价 ${quotes.length}</button>
      </div>
    </div>
    ${active.error
      ? html`<${ErrorBanner} message=${active.error} onRetry=${active.reload} />`
      : active.loading && !rows.length
        ? html`<${LoadingRow} label="正在读取 IEX 逐笔数据…" />`
        : !rows.length
          ? html`<div class="text-sm text-muted">IEX 没有返回最近的${isTrades ? "逐笔成交" : "报价"}。</div>`
          : html`<div class="table-wrap" style="max-height:320px;overflow:auto"><table class="table">
            ${isTrades ? html`<thead><tr><th>时间</th><th class="r">价格</th><th class="r">数量</th><th>交易所</th><th>条件码</th></tr></thead>
            <tbody>${rows.map((item) => html`<tr>
              <td class="text-muted">${fmt.time(item.time)}</td>
              <td class="r"><b>${fmt.price(item.price)}</b></td>
              <td class="r">${fmt.num(item.size)}</td>
              <td>${item.exchange || "—"}</td>
              <td class="text-muted">${(item.conditions || []).join(" ") || "—"}</td>
            </tr>`)}</tbody>` : html`<thead><tr><th>时间</th><th class="r">买价</th><th class="r">买量</th><th class="r">卖价</th><th class="r">卖量</th><th>交易所</th></tr></thead>
            <tbody>${rows.map((item) => html`<tr>
              <td class="text-muted">${fmt.time(item.time)}</td>
              <td class="r">${fmt.price(item.bid)}</td>
              <td class="r">${fmt.num(item.bid_size)}</td>
              <td class="r">${fmt.price(item.ask)}</td>
              <td class="r">${fmt.num(item.ask_size)}</td>
              <td>${item.exchange || "—"}${item.ask_exchange && item.ask_exchange !== item.exchange ? ` / ${item.ask_exchange}` : ""}</td>
            </tr>`)}</tbody>`}
          </table></div>`}
  </div>`;
}
