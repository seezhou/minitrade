import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass } from "../utils.js";
import { useAsync, useDocumentTitle } from "../hooks.js";
import { useLive } from "../stream.js";
import { notify, openSearch, openTrade, refreshTrading, useStore } from "../store.js";
import { navigate, stockPath } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, Empty, ErrorBanner, LoadingRow, Logo, Change } from "../ui.js";
import { EquityChart, AllocationChart } from "../charts.js";

const PERIODS = ["1D", "1W", "1M", "3M", "1Y", "ALL"];
const COLORS = ["#0f9d76", "#3b82f6", "#8b5cf6", "#f59e0b", "#14b8a6", "#ec4899", "#64748b", "#ef4444", "#6366f1", "#84cc16"];

function optionRoot(symbol) {
  const match = /^([A-Z]+)\d{6}[CP]\d{8}$/.exec(symbol || "");
  return match ? match[1] : null;
}

export function PortfolioPage() {
  const store = useStore();
  const [period, setPeriod] = useState("1M");
  useDocumentTitle("投资组合");
  const historyQuery = useAsync(() => api(`/api/account/history?period=${period}`), [period]);
  const activitiesQuery = useAsync(() => api("/api/activities?types=FILL,DIV,INT&limit=30"), []);
  const allPositions = store.positions;
  const equityPositions = allPositions.filter((item) => (item.asset_class || "us_equity") === "us_equity" && !optionRoot(item.symbol));
  const optionPositions = allPositions.filter((item) => item.asset_class === "us_option" || optionRoot(item.symbol));
  const cryptoPositions = allPositions.filter((item) => item.asset_class === "crypto" || (item.symbol || "").includes("/"));
  const symbols = equityPositions.map((item) => item.symbol);
  const { ticks } = useLive(symbols);

  useEffect(() => {
    refreshTrading({ silent: true });
  }, []);

  const positions = useMemo(() => {
    const rows = equityPositions.map((position) => {
      const tick = ticks[position.symbol] || {};
      const price = tick.price ?? position.current_price;
      const qty = Number(position.qty || 0);
      const marketValue = price != null ? price * qty : Number(position.market_value || 0);
      const cost = Number(position.cost_basis || 0);
      const pnl = price != null ? marketValue - cost : Number(position.unrealized_pl || 0);
      const pnlPct = cost ? pnl / cost : null;
      return { ...position, price, market_value: marketValue, unrealized_pl: pnl, unrealized_plpc: pnlPct };
    });
    const totalValue = rows.reduce((sum, item) => sum + Number(item.market_value || 0), 0);
    return rows.map((item) => ({ ...item, weight: totalValue ? Number(item.market_value) / totalValue : 0 }));
  }, [equityPositions, ticks]);

  const otherPositions = [...optionPositions, ...cryptoPositions];
  const otherValue = otherPositions.reduce((sum, item) => sum + Number(item.market_value || 0), 0);
  const holdingsValue = positions.reduce((sum, item) => sum + Number(item.market_value || 0), 0) + otherValue;
  const unrealized = positions.reduce((sum, item) => sum + Number(item.unrealized_pl || 0), 0)
    + otherPositions.reduce((sum, item) => sum + Number(item.unrealized_pl || 0), 0);
  const costBasis = positions.reduce((sum, item) => sum + Number(item.cost_basis || 0), 0)
    + otherPositions.reduce((sum, item) => sum + Number(item.cost_basis || 0), 0);
  const account = store.account;
  const cash = Number(account?.cash || 0);
  const equity = account?.portfolio_value ?? account?.equity;
  const dayPl = account?.day_pl;
  const dayPct = account?.day_pl_pct;
  const concentration = positions.length ? Math.max(...positions.map((item) => item.weight)) : 0;
  const marginUsed = Number(account?.initial_margin || 0);
  const history = historyQuery.data;
  const historyPoints = history?.points || [];
  const periodReturn = historyPoints.length > 1 && historyPoints[0].equity ? historyPoints[historyPoints.length - 1].equity / historyPoints[0].equity - 1 : null;

  const allocation = useMemo(() => {
    const items = [...positions, ...otherPositions].filter((item) => item.market_value > 0).map((item, index) => ({ name: item.symbol, value: Number(item.market_value), itemStyle: { color: COLORS[index % COLORS.length] } }));
    if (cash > 0) items.push({ name: "现金", value: cash, itemStyle: { color: "#cbd5e1" } });
    return items;
  }, [positions, otherPositions, cash]);
  const allocationTotal = allocation.reduce((sum, item) => sum + item.value, 0);

  async function closePosition(symbol) {
    if (!confirm(`确定要平掉 ${symbol} 的全部持仓吗？`)) return;
    try {
      await api(`/api/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
      notify(`已提交平仓 ${symbol}`, "success");
      await refreshTrading({ silent: true });
      activitiesQuery.reload();
    } catch (error) {
      notify(error.message, "error");
    }
  }

  async function closeOther(item) {
    const isOption = Boolean(optionRoot(item.symbol));
    const root = optionRoot(item.symbol) || item.symbol;
    if (!confirm(`确定要平掉 ${item.symbol} 的全部持仓吗？`)) return;
    try {
      if (isOption) await api(`/api/stocks/${encodeURIComponent(root)}/options/positions/${encodeURIComponent(item.symbol)}`, { method: "DELETE" });
      else await api(`/api/crypto/positions?symbol=${encodeURIComponent(item.symbol)}`, { method: "DELETE" });
      notify(`已提交平仓 ${item.symbol}`, "success");
      await refreshTrading({ silent: true });
    } catch (error) {
      notify(error.message, "error");
    }
  }

  return html`<div>
    <${PageHead}
      eyebrow="账户概览 · 纸面账户"
      title="投资组合"
      sub="把账户权益、现金、持仓盈亏和集中度放在一起看。所有数字来自 Alpaca 模拟账户。"
      actions=${html`<button class="btn btn-sm" onClick=${() => { refreshTrading({ silent: true }); historyQuery.reload(); activitiesQuery.reload(); }}><${Icon} name="refresh" size=${14} />刷新</button><button class="btn btn-primary btn-sm" onClick=${openSearch}><${Icon} name="search" size=${14} />搜索股票</button>`}
    />
    ${store.tradingError && html`<${ErrorBanner} message=${store.tradingError} onRetry=${() => refreshTrading()} />`}

    <div class="card card-pad mb-12" style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:24px;align-items:center">
      <div>
        <div class="eyebrow">账户总资产</div>
        <div style="font-size:38px;font-weight:800;letter-spacing:-1.4px;line-height:1.1" class="tabular">${fmt.money(equity)}</div>
        <div class="row wrap" style="margin-top:6px;gap:14px">
          <${Change} value=${dayPl} percent=${dayPct} />
          <span class="text-xs text-muted">今日盈亏</span>
          <span class=${cls("text-xs", toneClass(unrealized))}>持仓浮动 ${fmt.moneySigned(unrealized)}</span>
          ${periodReturn != null ? html`<span class="text-xs text-muted">区间（${period}）${fmt.pct(periodReturn)}</span>` : null}
        </div>
      </div>
      <div class="grid grid-2" style="gap:12px">
        <div class="metric"><span>现金</span><strong>${fmt.money(cash)}</strong><small>可用于买入</small></div>
        <div class="metric"><span>购买力</span><strong>${fmt.money(account?.buying_power)}</strong><small>含保证金</small></div>
        <div class="metric"><span>持仓市值</span><strong>${fmt.money(holdingsValue)}</strong><small>${positions.length} 只股票 + ${otherPositions.length} 个其他持仓</small></div>
        <div class="metric"><span>最大集中度</span><strong>${fmt.pctPlain(concentration)}</strong><small>单一持仓占比</small></div>
      </div>
    </div>

    <div class="portfolio-layout mb-12">
      <${Card}>
        <div class="card-head">
          <div><div class="card-title">账户权益曲线</div><div class="card-sub">Alpaca 投资组合历史 · 含延长时段估值</div></div>
          <div class="seg">
            ${PERIODS.map((item) => html`<button class=${cls(period === item && "active")} onClick=${() => setPeriod(item)}>${item}</button>`)}
          </div>
        </div>
        <div class="card-body">
          ${historyQuery.error ? html`<${ErrorBanner} message=${historyQuery.error} onRetry=${historyQuery.reload} />` : null}
          ${historyPoints.length ? html`<${EquityChart} points=${historyPoints} />` : historyQuery.loading ? html`<${LoadingRow} label="正在读取权益历史…" />` : html`<${Empty} icon="activity" title="还没有权益历史" description="账户刚创建，完成第一笔交易后这里会出现权益曲线。" />`}
        </div>
      <//>

      <${Card}>
        <div class="card-head"><div><div class="card-title">资产配置</div><div class="card-sub">按当前市值计算</div></div></div>
        <div class="card-body">
          <${AllocationChart} items=${allocation} total=${allocationTotal} label="资产配置" />
          <div class="alloc-legend">
            ${allocation.slice(0, 7).map((item) => {
              const total = allocation.reduce((sum, entry) => sum + entry.value, 0);
              return html`<div class="alloc-row">
                <span class="alloc-dot" style=${`background:${item.itemStyle.color}`} />
                <span class="name">${item.name === "现金" ? "现金" : item.name}</span>
                <b>${fmt.pctPlain(item.value / (total || 1))}</b>
              </div>`;
            })}
          </div>
        </div>
      <//>
    </div>

    <div class="grid grid-4 mb-12">
      <div class="card card-pad"><div class="eyebrow">持仓成本</div><div class="metric-value" style="font-size:18px;font-weight:800">${fmt.money(costBasis)}</div><div class="text-xs text-muted" style="margin-top:4px">所有持仓的建仓成本</div></div>
      <div class="card card-pad"><div class="eyebrow">未实现盈亏</div><div class=${cls("metric-value", toneClass(unrealized))} style="font-size:18px;font-weight:800">${fmt.moneySigned(unrealized)}</div><div class="text-xs text-muted" style="margin-top:4px">相对持仓成本</div></div>
      <div class="card card-pad"><div class="eyebrow">保证金占用</div><div class="metric-value" style="font-size:18px;font-weight:800">${fmt.money(marginUsed)}</div><div class="text-xs text-muted" style="margin-top:4px">初始保证金</div></div>
      <div class="card card-pad"><div class="eyebrow">持仓数量</div><div class="metric-value" style="font-size:18px;font-weight:800">${positions.length} 只</div><div class="text-xs text-muted" style="margin-top:4px">股票与 ETF · 另有 ${otherPositions.length} 个期权/加密</div></div>
    </div>

    <${Card} className="mb-12">
      <div class="card-head"><div><div class="card-title">持仓明细</div><div class="card-sub">实时价格叠加延迟 SIP 行情，盈亏随之更新</div></div><button class="card-link" onClick=${openSearch}>添加持仓 →</button></div>
      ${store.tradingLoading && !positions.length ? html`<${LoadingRow} label="正在读取持仓…" />` : positions.length ? html`<div class="table-wrap" style="margin-top:8px"><table class="table">
        <thead><tr><th>股票</th><th class="r">数量</th><th class="r">成本</th><th class="r">现价</th><th class="r">市值</th><th class="r">浮动盈亏</th><th class="r">今日</th><th class="r">权重</th><th class="r">操作</th></tr></thead>
        <tbody>${positions.map((position) => html`<tr>
          <td><div class="sym-cell" style="cursor:pointer" onClick=${() => navigate(stockPath(position.symbol))}><${Logo} symbol=${position.symbol} /><div><div class="sym">${position.symbol}</div><div class="nm">${position.name || "—"}</div></div></div></td>
          <td class="r">${fmt.num(position.qty, 4)}</td>
          <td class="r text-muted">${fmt.price(position.avg_entry_price)}</td>
          <td class="r"><b>${fmt.price(position.price)}</b></td>
          <td class="r">${fmt.money(position.market_value)}</td>
          <td class=${cls("r", toneClass(position.unrealized_pl))}><b>${fmt.moneySigned(position.unrealized_pl)}</b><div class="text-xs">${position.unrealized_plpc != null ? fmt.pct(position.unrealized_plpc) : "—"}</div></td>
          <td class=${cls("r", toneClass(position.change_today))}>${position.change_today != null ? fmt.pct(position.change_today) : "—"}</td>
          <td class="r text-muted">${fmt.pctPlain(position.weight)}</td>
          <td class="r"><div class="watch-actions"><button class="btn btn-sm" onClick=${() => openTrade(position.symbol, "sell")}>卖出</button><button class="btn btn-ghost btn-icon btn-sm" title="平仓" onClick=${() => closePosition(position.symbol)}><${Icon} name="x" size=${13} /></button></div></td>
        </tr>`)}</tbody>
      </table></div>` : html`<${Empty} icon="briefcase" title="还没有持仓" description="搜索一只你熟悉或想研究的股票，先做一笔模拟买入。" action=${html`<button class="btn btn-primary btn-sm" onClick=${openSearch}>搜索股票</button>`} />`}
    <//>

    ${otherPositions.length ? html`<${Card} className="mb-12">
      <div class="card-head"><div><div class="card-title">期权与加密持仓</div><div class="card-sub">衍生品和加密资产单独展示，不计入股票权重</div></div><${Badge} tone="blue">${otherPositions.length}<//></div>
      <div class="table-wrap" style="margin-top:8px"><table class="table">
        <thead><tr><th>资产</th><th>类型</th><th class="r">数量</th><th class="r">成本</th><th class="r">现价</th><th class="r">市值</th><th class="r">浮动盈亏</th><th class="r">操作</th></tr></thead>
        <tbody>${otherPositions.map((item) => {
          const option = optionRoot(item.symbol);
          const root = option || item.symbol;
          return html`<tr>
            <td><div class="sym-cell" style="cursor:pointer" onClick=${() => navigate(option ? stockPath(root, "options") : `/crypto/${encodeURIComponent(item.symbol)}`)}>
              ${option ? html`<${Logo} symbol=${root} />` : html`<span class="crypto-mark small">${item.symbol.slice(0, 1)}</span>`}
              <div><div class="sym">${item.symbol}</div><div class="nm">${item.name || (option ? `${root} 期权` : item.symbol)}</div></div>
            </div></td>
            <td><${Badge} tone=${option ? "blue" : "green"}>${option ? "期权" : "加密"}<//></td>
            <td class="r">${fmt.num(item.qty, option ? 4 : 8)}</td>
            <td class="r text-muted">${fmt.price(item.avg_entry_price)}</td>
            <td class="r">${fmt.price(item.current_price)}</td>
            <td class="r">${fmt.money(item.market_value)}</td>
            <td class=${cls("r", toneClass(item.unrealized_pl))}>${fmt.moneySigned(item.unrealized_pl)}</td>
            <td class="r"><button class="btn btn-sm btn-danger" onClick=${() => closeOther(item)}>平仓</button></td>
          </tr>`;
        })}</tbody>
      </table></div>
    <//>` : null}

    <${Card}>
      <div class="card-head"><div><div class="card-title">账户活动</div><div class="card-sub">Alpaca 活动记录 · 成交与分红</div></div><span class="badge">${activitiesQuery.data?.length || 0}</span></div>
      <div class="card-body">
        ${activitiesQuery.data?.length ? html`<div class="table-wrap"><table class="table table-compact">
          <thead><tr><th>时间</th><th>类型</th><th>股票</th><th class="r">数量</th><th class="r">价格</th><th class="r">金额</th></tr></thead>
          <tbody>${activitiesQuery.data.map((item, index) => html`<tr>
            <td class="text-muted">${fmt.dateTime(item.transaction_time || item.date)}</td>
            <td><${Badge} tone=${item.activity_type === "DIV" ? "amber" : item.activity_type === "FILL" ? "green" : "neutral"}>${item.activity_type === "DIV" ? "分红" : item.activity_type === "FILL" ? "成交" : item.activity_type || "—"}<//></td>
            <td><b>${item.symbol || "—"}</b></td>
            <td class="r">${item.quantity != null ? fmt.num(item.quantity, 4) : "—"}</td>
            <td class="r">${item.price != null ? fmt.price(item.price) : "—"}</td>
            <td class="r">${item.amount != null ? fmt.moneySigned(item.amount) : "—"}</td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="text-sm text-muted">还没有成交或分红记录。完成第一笔模拟交易后会显示在这里。</div>`}
      </div>
    <//>
  </div>`;
}
