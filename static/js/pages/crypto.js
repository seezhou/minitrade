import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass } from "../utils.js";
import { useAsync, useDocumentTitle } from "../hooks.js";
import { notify, refreshTrading, useStore } from "../store.js";
import { navigate } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, Empty, ErrorBanner, LoadingRow } from "../ui.js";
import { PriceChart } from "../charts.js";

const RANGES = ["1D", "1W", "1M", "3M", "6M", "1Y"];
const RANGE_LABEL = { "1D": "1D", "1W": "5D", "1M": "1M", "3M": "3M", "6M": "6M", "1Y": "1Y" };

function coinPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 1000) return fmt.money(number, "USD", 2);
  if (number >= 1) return fmt.money(number, "USD", 2);
  return `$${number.toFixed(4)}`;
}

function cryptoSymbol(value) {
  return (value || "BTC/USD").toUpperCase();
}

export function CryptoPage({ symbol = "BTC/USD" }) {
  useDocumentTitle("加密 · MiniTrade");
  const store = useStore();
  const selected = cryptoSymbol(symbol);
  const [range, setRange] = useState("1D");
  const marketsQuery = useAsync(() => api("/api/crypto/markets"), [], { pollMs: 15000 });
  const snapshotQuery = useAsync(() => api(`/api/crypto/snapshot?symbol=${encodeURIComponent(selected)}`), [selected], { pollMs: 15000 });
  const barsQuery = useAsync(
    () => api(`/api/crypto/bars?symbol=${encodeURIComponent(selected)}&range=${range}`),
    [selected, range],
    { pollMs: 30000 },
  );
  const markets = marketsQuery.data || [];
  const snapshot = snapshotQuery.data;
  const bars = barsQuery.data?.bars || [];
  const cryptoPositions = store.positions.filter((item) => item.asset_class === "crypto" || (item.symbol || "").includes("/"));
  const cryptoOrders = store.orders.filter((item) => (item.symbol || "").includes("/") || item.asset_class === "crypto");
  const recentCryptoOrders = cryptoOrders.filter((item) => item.is_open || item.status === "filled");
  const openOrders = cryptoOrders.filter((item) => item.is_open);

  useEffect(() => {
    if (markets.length && !markets.some((item) => item.symbol === selected)) {
      navigate(`/crypto/${encodeURIComponent(markets[0].symbol)}`);
    }
  }, [markets, selected]);

  const price = snapshot?.price;
  const change = snapshot?.change;
  const changePct = snapshot?.change_pct;

  return html`<div class="stack">
    <${PageHead}
      eyebrow="加密 · ALPACA CRYPTO"
      title="加密市场"
      sub="24/7 现货行情与模拟交易。行情来自 Alpaca Crypto，所有订单发送到纸面账户。"
      actions=${html`<button class="btn btn-sm" onClick=${() => { marketsQuery.reload(); snapshotQuery.reload(); barsQuery.reload(); }}><${Icon} name="refresh" size=${14} />刷新</button>`}
    />

    <div class="crypto-top">
      ${markets.slice(0, 5).map((item) => html`<button class=${cls("crypto-card", item.symbol === selected && "active")} onClick=${() => navigate(`/crypto/${encodeURIComponent(item.symbol)}`)}>
        <div class="crypto-card-head"><b>${item.symbol.split("/")[0]}</b><span>${item.name}</span></div>
        <strong>${coinPrice(item.price)}</strong>
        <div class=${cls("crypto-change", toneClass(item.change_pct))}>${item.change_pct != null ? fmt.pct(item.change_pct) : "—"}</div>
      </button>`)}
    </div>

    <div class="crypto-layout">
      <div class="stack">
        <${Card} className="crypto-chart-card">
          <div class="crypto-symbol-head">
            <div class="crypto-symbol-id">
              <span class="crypto-mark">${selected.split("/")[0].slice(0, 1)}</span>
              <div>
                <div class="crypto-symbol-title">${selected}<${Badge} tone="green">CRYPTO<//></div>
                <div class="card-sub">${snapshot?.name || "Alpaca Crypto"} · 24/7</div>
              </div>
            </div>
            <div class="crypto-quote">
              <strong>${price != null ? coinPrice(price) : "—"}</strong>
              <div class=${cls("crypto-change", toneClass(changePct))}>${change != null ? `${change >= 0 ? "+" : ""}${coinPrice(change)}` : "—"} ${changePct != null ? fmt.pct(changePct) : ""}</div>
            </div>
          </div>
          <div class="chart-toolbar">
            <div class="range-tabs">
              ${RANGES.map((key) => html`<button class=${cls(key === range && "active")} onClick=${() => setRange(key)}>${RANGE_LABEL[key]}</button>`)}
            </div>
            <div class="chart-foot-inline">5Min · 24/7</div>
          </div>
          ${barsQuery.error ? html`<${ErrorBanner} message=${barsQuery.error} onRetry=${barsQuery.reload} />` : null}
          ${bars.length ? html`<${PriceChart}
            bars=${bars}
            range=${range}
            previousClose=${snapshot?.previous_close}
            indicators=${{}}
            chartType="area"
            showSessions=${false}
          />` : barsQuery.loading ? html`<div class="chart-skeleton"><span class="skeleton" /></div>` : html`<div class="chart-empty">暂无 K 线数据</div>`}
          <div class="chart-foot">
            <span>Alpaca Crypto · ${range} · ${bars.length} 根 K 线</span>
            <span>数据仅供学习</span>
          </div>
        <//>

        <${Card} className="crypto-market-card">
          <div class="card-head"><div><div class="card-title">加密市场</div><div class="card-sub">点击切换交易对，行情约每 15 秒刷新</div></div><${Badge} tone="green">10 PAIRS<//></div>
          <div class="card-body" style="padding-top:8px">
            <div class="crypto-table-wrap"><table class="table crypto-table">
              <thead><tr><th>交易对</th><th class="r">最新价</th><th class="r">24h</th><th class="r">买 / 卖</th><th class="r">24h 成交量</th></tr></thead>
              <tbody>${markets.map((item) => html`<tr class=${cls(item.symbol === selected && "selected")} onClick=${() => navigate(`/crypto/${encodeURIComponent(item.symbol)}`)}>
                <td><div class="crypto-row-name"><span class="crypto-mark small">${item.symbol.slice(0, 1)}</span><div><b>${item.symbol}</b><small>${item.name}</small></div></div></td>
                <td class="r"><b>${coinPrice(item.price)}</b></td>
                <td class="r ${toneClass(item.change_pct)}">${item.change_pct != null ? fmt.pct(item.change_pct) : "—"}</td>
                <td class="r text-muted">${coinPrice(item.bid)} / ${coinPrice(item.ask)}</td>
                <td class="r text-muted">${fmt.compact(item.volume)}</td>
              </tr>`)}</tbody>
            </table></div>
          </div>
        <//>
      </div>

      <div class="stack">
        <${CryptoTicket} symbol=${selected} snapshot=${snapshot} onSubmitted=${() => { refreshTrading({ silent: true }); snapshotQuery.reload(); }} />
        <${Card} className="crypto-side-card">
          <div class="card-head"><div><div class="card-title">关键数据</div><div class="card-sub">${snapshot?.name || selected}</div></div></div>
          <div class="card-body" style="padding-top:8px">
            <div class="crypto-facts">
              <div><span>24h 开盘</span><b>${coinPrice(snapshot?.open)}</b></div>
              <div><span>24h 最高</span><b>${coinPrice(snapshot?.high)}</b></div>
              <div><span>24h 最低</span><b>${coinPrice(snapshot?.low)}</b></div>
              <div><span>24h 成交量</span><b>${fmt.compact(snapshot?.volume)}</b></div>
              <div><span>买价</span><b>${coinPrice(snapshot?.bid)}</b></div>
              <div><span>卖价</span><b>${coinPrice(snapshot?.ask)}</b></div>
            </div>
          </div>
        <//>
      </div>
    </div>

    <div class="crypto-bottom">
      <${Card}>
        <div class="card-head"><div><div class="card-title">加密持仓</div><div class="card-sub">纸面账户中的加密现货</div></div><${Badge} tone="blue">${cryptoPositions.length}<//></div>
        <div class="card-body" style="padding-top:8px">
          ${cryptoPositions.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>交易对</th><th class="r">数量</th><th class="r">成本</th><th class="r">现价</th><th class="r">市值</th><th class="r">浮动盈亏</th><th class="r">操作</th></tr></thead>
            <tbody>${cryptoPositions.map((item) => html`<tr>
              <td><b>${item.symbol}</b></td>
              <td class="r">${fmt.num(item.qty, 8)}</td>
              <td class="r text-muted">${coinPrice(item.avg_entry_price)}</td>
              <td class="r">${coinPrice(item.current_price)}</td>
              <td class="r">${fmt.money(item.market_value)}</td>
              <td class="r ${toneClass(item.unrealized_pl)}">${fmt.moneySigned(item.unrealized_pl)}</td>
              <td class="r"><button class="btn btn-sm btn-danger" onClick=${async () => {
                if (!confirm(`确定平掉 ${item.symbol} 的全部加密持仓吗？`)) return;
                try { await api(`/api/crypto/positions?symbol=${encodeURIComponent(item.symbol)}`, { method: "DELETE" }); notify(`已提交平仓 ${item.symbol}`, "success"); await refreshTrading({ silent: true }); } catch (error) { notify(error.message, "error"); }
              }}>平仓</button></td>
            </tr>`)}</tbody>
          </table></div>` : html`<${Empty} icon="wallet" title="还没有加密持仓" description="在上面选择交易对，下一笔模拟加密订单。" />`}
        </div>
      <//>

      <${Card}>
        <div class="card-head"><div><div class="card-title">加密订单</div><div class="card-sub">未完成 ${openOrders.length} 笔 · 最近成交</div></div><${Badge} tone="blue">${recentCryptoOrders.length}<//></div>
        <div class="card-body" style="padding-top:8px">
          ${recentCryptoOrders.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th class="r">数量</th><th class="r">价格</th><th>状态</th><th class="r">操作</th></tr></thead>
            <tbody>${recentCryptoOrders.slice(0, 20).map((order) => html`<tr>
              <td class="text-muted">${fmt.dateTime(order.submitted_at || order.created_at)}</td>
              <td><b>${order.symbol}</b></td>
              <td><${Badge} tone=${order.side === "buy" ? "green" : "red"}>${order.side === "buy" ? "买入" : "卖出"}<//></td>
              <td class="r">${fmt.num(order.filled_qty || order.qty, 8)}</td>
              <td class="r">${order.limit_price ? coinPrice(order.limit_price) : "市价"}</td>
              <td><${Badge} tone=${order.status === "filled" ? "green" : order.status === "rejected" ? "red" : "blue"}>${order.status}<//></td>
              <td class="r">${order.is_open ? html`<button class="btn btn-sm" onClick=${async () => { try { await api(`/api/orders/${order.id}`, { method: "DELETE" }); notify("订单已取消", "success"); await refreshTrading({ silent: true }); } catch (error) { notify(error.message, "error"); } }}>取消</button>` : "—"}</td>
            </tr>`)}</tbody>
          </table></div>` : html`<${Empty} icon="orders" title="还没有加密订单" description="提交一笔模拟加密订单后会显示在这里。" />`}
        </div>
      <//>
    </div>
  </div>`;
}

function CryptoTicket({ symbol, snapshot, onSubmitted }) {
  const store = useStore();
  const [side, setSide] = useState("buy");
  const [orderType, setOrderType] = useState("market");
  const [amountMode, setAmountMode] = useState("qty");
  const [qty, setQty] = useState("0.001");
  const [notional, setNotional] = useState("100");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [tif, setTif] = useState("gtc");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const price = Number(snapshot?.price);
  const buyingPower = Number(store.account?.buying_power ?? 0);
  const position = store.positions.find((item) => item.symbol === symbol);

  useEffect(() => {
    setQty("0.001");
    setNotional("100");
    setLimitPrice("");
    setStopPrice("");
    setError("");
  }, [symbol]);

  useEffect(() => {
    if (!Number.isFinite(price) || price <= 0) return;
    setLimitPrice((current) => (current === "" ? price.toFixed(2) : current));
    setStopPrice((current) => (current === "" ? (price * 0.95).toFixed(2) : current));
    setQty((current) => (current === "0.001" && Number(current) * price < 10 ? (50 / price).toFixed(6) : current));
  }, [price]);

  useEffect(() => {
    if (orderType !== "market" && amountMode === "notional") setAmountMode("qty");
    if (side === "sell" && amountMode === "notional") setAmountMode("qty");
  }, [orderType, amountMode, side]);

  const estimatedQty = amountMode === "notional" ? (price ? Number(notional || 0) / price : 0) : Number(qty || 0);
  const estimatedValue = amountMode === "notional" ? Number(notional || 0) : estimatedQty * price;
  const needsLimit = orderType === "limit" || orderType === "stop_limit";
  const needsStop = orderType === "stop_limit";

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (!Number.isFinite(price) || price <= 0) return setError("行情尚未加载完成。");
    if (amountMode === "qty" && (!qty || Number(qty) <= 0)) return setError("请输入有效的数量。");
    if (amountMode === "notional" && (!notional || Number(notional) <= 0)) return setError("请输入有效的金额。");
    if (needsLimit && (!limitPrice || Number(limitPrice) <= 0)) return setError("请输入有效限价。");
    if (needsStop && (!stopPrice || Number(stopPrice) <= 0)) return setError("请输入有效触发价。");
    const orderValue = amountMode === "notional" ? Number(notional || 0) : Number(qty || 0) * (needsLimit ? Number(limitPrice || 0) : price);
    if (orderValue <= 10) return setError("加密订单最低金额需高于 $10。");
    setBusy(true);
    try {
      const payload = { symbol, side, order_type: orderType, time_in_force: tif };
      if (amountMode === "notional") payload.notional = Number(notional);
      else payload.qty = Number(qty);
      if (needsLimit) payload.limit_price = Number(limitPrice);
      if (needsStop) payload.stop_price = Number(stopPrice);
      await api("/api/crypto/orders", { method: "POST", body: payload });
      notify(`${side === "buy" ? "买入" : "卖出"} ${symbol} 的模拟订单已提交`, "success");
      onSubmitted?.();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<${Card} className="crypto-ticket">
    <div class="card-head"><div><div class="card-title">快速交易</div><div class="card-sub">${symbol} · 24/7 纸面交易</div></div><${Badge} tone="green">PAPER<//></div>
    <form class="card-body" style="padding-top:10px" onSubmit=${submit}>
      <div class="ticket-side">
        <button type="button" class=${cls("buy", side === "buy" && "active")} onClick=${() => setSide("buy")}>买入</button>
        <button type="button" class=${cls("sell", side === "sell" && "active")} onClick=${() => setSide("sell")}>卖出</button>
      </div>
      <div class="crypto-last">
        <span>最新价</span><b>${coinPrice(price)}</b>
        <span class=${toneClass(snapshot?.change_pct)}>${snapshot?.change_pct != null ? fmt.pct(snapshot.change_pct) : "—"}</span>
      </div>
      ${position ? html`<div class="text-xs text-muted" style="margin-top:6px">当前持仓 ${fmt.num(position.qty, 8)} · 可卖 ${fmt.num(position.qty_available ?? position.qty, 8)}</div>` : null}
      <div class="field">
        <label>订单类型</label>
        <select class="select" value=${orderType} onChange=${(event) => setOrderType(event.currentTarget.value)}>
          <option value="market">市价单</option>
          <option value="limit">限价单</option>
          <option value="stop_limit">止损限价单</option>
        </select>
      </div>
      ${orderType === "market" && side === "buy" ? html`<div class="seg">
        <button type="button" class=${cls(amountMode === "qty" && "active")} onClick=${() => setAmountMode("qty")}>按数量</button>
        <button type="button" class=${cls(amountMode === "notional" && "active")} onClick=${() => setAmountMode("notional")}>按金额</button>
      </div>` : null}
      ${amountMode === "notional" ? html`<div class="field"><label>金额（USD）</label><div class="input-wrap"><input class="input" type="number" min="1" step="1" value=${notional} onInput=${(event) => setNotional(event.currentTarget.value)} /><span class="input-suffix">USD</span></div></div>` : html`<div class="field"><label>数量</label><div class="input-wrap"><input class="input" type="number" min="0.00000001" step="0.00000001" value=${qty} onInput=${(event) => setQty(event.currentTarget.value)} /><span class="input-suffix">${symbol.split("/")[0]}</span></div></div>`}
      ${needsLimit ? html`<div class="field"><label>限价</label><div class="input-wrap"><input class="input" type="number" min="0.0001" step="0.0001" value=${limitPrice} onInput=${(event) => setLimitPrice(event.currentTarget.value)} /><span class="input-suffix">USD</span></div></div>` : null}
      ${needsStop ? html`<div class="field"><label>触发价</label><div class="input-wrap"><input class="input" type="number" min="0.0001" step="0.0001" value=${stopPrice} onInput=${(event) => setStopPrice(event.currentTarget.value)} /><span class="input-suffix">USD</span></div></div>` : null}
      <div class="field"><label>有效期</label><select class="select" value=${tif} onChange=${(event) => setTif(event.currentTarget.value)}><option value="gtc">GTC · 撤销前有效</option><option value="ioc">IOC · 立即成交否则取消</option></select></div>
      <div class="ticket-summary">
        <div><span>预估数量</span><b>${fmt.num(estimatedQty, 8)} ${symbol.split("/")[0]}</b></div>
        <div><span>预估金额</span><b>${fmt.money(estimatedValue)}</b></div>
        <div><span>可用购买力</span><b>${fmt.money(buyingPower)}</b></div>
      </div>
      ${error ? html`<div class="error-banner">${error}</div>` : null}
      <button class="btn btn-primary" style="width:100%;margin-top:12px" disabled=${busy}>${busy ? "提交中…" : `${side === "buy" ? "买入" : "卖出"} ${symbol}`}</button>
      <div class="modal-note" style="margin-top:9px">加密订单仅发送到 Alpaca 纸面账户，单笔最低约 $10。加密资产 24/7 交易，价格波动较大。</div>
    </form>
  <//>`;
}
