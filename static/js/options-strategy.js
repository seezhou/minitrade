import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "./api.js";
import { payoffCurve, requiredShares } from "./payoff.js";
import { html, cls, fmt, toneClass } from "./utils.js";
import { notify, refreshTrading, useStore } from "./store.js";
import { Badge } from "./ui.js";
import { Icon } from "./icons.js";

const STRATEGIES = {
  long_call: {
    label: "买入看涨",
    desc: "看涨，风险有限、收益无限",
    legs: [{ kind: "call", side: "buy", offset: 0 }],
  },
  long_put: {
    label: "买入看跌",
    desc: "看跌，风险有限、收益有限",
    legs: [{ kind: "put", side: "buy", offset: 0 }],
  },
  bull_call_spread: {
    label: "牛市看涨价差",
    desc: "买入低行权价 Call，卖出高行权价 Call",
    legs: [{ kind: "call", side: "buy", offset: 0 }, { kind: "call", side: "sell", offset: 2 }],
  },
  bear_put_spread: {
    label: "熊市看跌价差",
    desc: "买入高行权价 Put，卖出低行权价 Put",
    legs: [{ kind: "put", side: "buy", offset: 0 }, { kind: "put", side: "sell", offset: -2 }],
  },
  long_straddle: {
    label: "买入跨式",
    desc: "同一行权价同时买入 Call 和 Put",
    legs: [{ kind: "call", side: "buy", offset: 0 }, { kind: "put", side: "buy", offset: 0 }],
  },
  long_strangle: {
    label: "买入宽跨式",
    desc: "买入虚值 Call + 虚值 Put，等待大波动",
    legs: [{ kind: "call", side: "buy", offset: 2 }, { kind: "put", side: "buy", offset: -2 }],
  },
  // The two `stock` strategies carry a share leg that is NOT part of the order:
  // you must already own 100 shares per contract, and only the option leg is sent.
  covered_call: {
    label: "备兑看涨",
    desc: "持有 100 股 + 卖出 Call，收权利金、封顶上方收益",
    stock: "long",
    legs: [{ kind: "call", side: "sell", offset: 2 }],
  },
  protective_put: {
    label: "保护性看跌",
    desc: "持有 100 股 + 买入 Put，为下跌买保险",
    stock: "long",
    legs: [{ kind: "put", side: "buy", offset: -2 }],
  },
};

function optionRoot(symbol) {
  const match = /^([A-Z]+)\d{6}[CP]\d{8}$/.exec(symbol || "");
  return match ? match[1] : null;
}

function nearestIndex(rows, target) {
  if (!rows.length) return 0;
  let best = 0;
  let distance = Infinity;
  rows.forEach((row, index) => {
    const current = Math.abs(Number(row.strike) - target);
    if (current < distance) { distance = current; best = index; }
  });
  return best;
}

function contractPrice(item) {
  return Number(item?.mid ?? item?.last ?? 0);
}

function defaultStrikes(strategy, calls, puts, spot) {
  const def = STRATEGIES[strategy] || STRATEGIES.long_call;
  const center = Number(spot) || 0;
  return def.legs.map((leg) => {
    const rows = leg.kind === "call" ? calls : puts;
    const atm = nearestIndex(rows, center);
    const index = Math.max(0, Math.min(rows.length - 1, atm + leg.offset));
    return Number(rows[index]?.strike);
  });
}

export function OptionsStrategy({ symbol, chain, expiry, spot }) {
  const [strategy, setStrategy] = useState("long_call");
  const [strikes, setStrikes] = useState({});
  const [qty, setQty] = useState(1);
  const [orderType, setOrderType] = useState("limit");
  const [limitPrice, setLimitPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const store = useStore();
  const calls = chain?.calls || [];
  const puts = chain?.puts || [];
  const def = STRATEGIES[strategy] || STRATEGIES.long_call;
  const canMarket = def.legs.length === 1;
  // A covered call receives premium; every other strategy on this desk pays it.
  const isCredit = def.legs.reduce((sum, leg) => sum + (leg.side === "buy" ? 1 : -1), 0) < 0;
  const unboundedProfit = ["long_call", "long_straddle", "long_strangle", "protective_put"].includes(strategy);

  const stockPosition = useMemo(() => {
    const row = store.positions.find((item) => (
      item.symbol === symbol && item.asset_class !== "us_option" && !optionRoot(item.symbol)
    ));
    if (!row) return { qty: 0, basis: null };
    return { qty: Number(row.qty) || 0, basis: Number(row.avg_entry_price) || null };
  }, [store.positions, symbol]);

  // Covered strategies need 100 shares per contract; those shares are never part of the order.
  const shareTarget = def.stock ? requiredShares(qty) : 0;
  const missingShares = Math.max(0, shareTarget - stockPosition.qty);
  const stockBlocked = missingShares > 0;

  const defaults = useMemo(
    () => defaultStrikes(strategy, calls, puts, spot || chain?.spot),
    [strategy, calls, puts, spot, chain?.spot],
  );

  useEffect(() => {
    setStrikes({});
    setPriceTouched(false);
    setOrderType("limit");
    setError("");
  }, [strategy, expiry, symbol]);

  useEffect(() => {
    if (!canMarket && orderType === "market") setOrderType("limit");
  }, [canMarket, orderType]);

  const legs = def.legs.map((leg, index) => {
    const rows = leg.kind === "call" ? calls : puts;
    const target = strikes[index] ?? defaults[index];
    const contract = rows.reduce((best, item) => (
      !best || Math.abs(Number(item.strike) - target) < Math.abs(Number(best.strike) - target) ? item : best
    ), null);
    return { ...leg, index, contract, rows };
  });

  const netMid = legs.reduce((sum, leg) => sum + (leg.side === "buy" ? 1 : -1) * contractPrice(leg.contract), 0);

  useEffect(() => {
    if (priceTouched) return;
    if (calls.length || puts.length) {
      // The premium is always shown as a positive per-share price; the debit/credit
      // direction is carried separately, so a credit ticket must not clamp to 0.01.
      setLimitPrice(Math.max(0.01, Math.abs(Number(netMid || 0))).toFixed(2));
    }
  }, [netMid, priceTouched, calls.length, puts.length]);

  const entry = orderType === "market" ? Math.abs(netMid) : Number(limitPrice) || 0;
  const payoff = useMemo(() => {
    const priced = legs
      .filter((leg) => leg.contract)
      .map((leg) => ({ kind: leg.kind, side: leg.side, strike: Number(leg.contract.strike) }));
    return payoffCurve({
      legs: priced,
      entry,
      qty,
      spot: Number(spot || chain?.spot) || 0,
      // Covered strategies draw the share leg into the chart; it is not an order leg.
      shares: def.stock ? stockPosition.qty : 0,
      basis: stockPosition.basis,
      credit: isCredit,
      unbounded: unboundedProfit,
    });
  }, [legs, entry, qty, spot, chain?.spot, stockPosition.qty, stockPosition.basis, isCredit, unboundedProfit, def.stock]);

  async function submit() {
    setError("");
    if (!legs.length || legs.some((leg) => !leg.contract)) return setError("当前到期日没有可用的期权合约。");
    if (!Number.isInteger(Number(qty)) || Number(qty) <= 0) return setError("合约数需要为正整数。");
    if (orderType === "limit" && (!entry || entry <= 0)) return setError("请输入有效的净限价。");
    if (stockBlocked) return setError(`正股不足：需要 ${shareTarget} 股 ${symbol}，当前持有 ${stockPosition.qty} 股。`);
    const summary = legs.map((leg) => `${leg.side === "buy" ? "买" : "卖"} ${leg.contract.symbol}`).join(" / ");
    const stockLine = def.stock ? `\n正股 ${symbol}：持有 ${stockPosition.qty} 股 / 需要 ${shareTarget} 股（不计入本次订单）` : "";
    const priceLine = `${def.legs.length > 1 ? "净限价" : "限价"} $${entry.toFixed(2)}`;
    if (!confirm(`${def.label}\n${summary}${stockLine}\n${qty} 组，${orderType === "limit" ? priceLine : "市价"}。\n\n确认发送到 Alpaca 纸面账户？`)) return;
    setBusy(true);
    try {
      const payload = {
        qty: Number(qty),
        order_type: orderType,
        time_in_force: "day",
        legs: legs.map((leg) => ({
          symbol: leg.contract.symbol,
          side: leg.side,
          ratio_qty: 1,
          position_intent: leg.side === "buy" ? "buy_to_open" : "sell_to_open",
        })),
      };
      if (orderType === "limit") payload.limit_price = Number(entry.toFixed(2));
      await api(`/api/stocks/${encodeURIComponent(symbol)}/options/orders`, { method: "POST", body: payload });
      notify(`${def.label} 已提交到 Alpaca 纸面账户`, "success");
      await refreshTrading({ silent: true });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<div class="card card-pad strategy-card" id="option-strategy">
    <div class="strategy-head">
      <div>
        <div class="card-title">期权策略台 <${Badge} tone="blue">LEVEL 3<//></div>
        <div class="card-sub">${def.desc} · 到期 ${expiry} · 现价 ${fmt.price(spot || chain?.spot)}</div>
      </div>
      <div class="text-right text-xs text-muted">账户期权等级 3<br />${def.stock ? "正股腿不计入订单" : "多腿按组合限价提交"}</div>
    </div>

    <div class="strategy-controls" style="margin-top:12px">
      <div class="field">
        <label>策略</label>
        <select class="select" value=${strategy} onChange=${(event) => setStrategy(event.currentTarget.value)}>
          ${Object.entries(STRATEGIES).map(([key, item]) => html`<option value=${key}>${item.label}</option>`)}
        </select>
      </div>
      <div class="field">
        <label>合约数</label>
        <input class="input" type="number" min="1" step="1" value=${qty} onInput=${(event) => setQty(Number(event.currentTarget.value))} />
      </div>
      <div class="field">
        <label>订单类型</label>
        <select class="select" value=${orderType} onChange=${(event) => setOrderType(event.currentTarget.value)}>
          <option value="limit">限价单</option>
          ${canMarket ? html`<option value="market">市价单</option>` : null}
        </select>
      </div>
      <div class="field">
        <label>${def.legs.length > 1 ? "净限价（每股）" : "限价（每股）"}</label>
        <div class="input-wrap">
          <input class="input" type="number" min="0.01" step="0.01" value=${limitPrice} disabled=${orderType === "market"} onInput=${(event) => { setPriceTouched(true); setLimitPrice(event.currentTarget.value); }} />
          <span class="input-suffix">USD</span>
        </div>
      </div>
    </div>

    <div class="strategy-legs" style="margin-top:10px">
      ${legs.map((leg) => html`<div class="strategy-leg">
        <span class=${cls("leg-side", leg.side)}>${leg.side === "buy" ? "买入" : "卖出"}</span>
        <span class="text-sm">${leg.kind === "call" ? "看涨 CALL" : "看跌 PUT"}</span>
        <select class="select" value=${leg.contract?.strike ?? ""} onChange=${(event) => { setStrikes((current) => ({ ...current, [leg.index]: Number(event.currentTarget.value) })); setPriceTouched(false); }}>
          ${leg.rows.map((item) => html`<option value=${item.strike}>${fmt.num(item.strike, item.strike % 1 ? 2 : 0)} · ${fmt.price(item.mid ?? item.last)}</option>`)}
        </select>
        <span class="leg-mid text-muted">买 ${fmt.price(leg.contract?.bid)} / 卖 ${fmt.price(leg.contract?.ask)}</span>
        <span class="leg-mid">× ${leg.ratio ?? 1}</span>
      </div>`)}
    </div>

    ${def.stock ? html`<div class="text-sm" style="margin-top:10px;display:flex;gap:14px;flex-wrap:wrap;align-items:baseline">
      <span class="text-muted">正股腿</span>
      <span>持有 <b>${fmt.num(stockPosition.qty, 4)}</b> 股 ${symbol}</span>
      <span>需要 <b>${fmt.num(shareTarget, 0)}</b> 股（${qty} 张 × 100）</span>
      ${stockPosition.basis ? html`<span class="text-muted">成本 ${fmt.price(stockPosition.basis)}</span>` : null}
      ${stockBlocked ? html`<span class="negative">还差 ${fmt.num(missingShares, 0)} 股</span>` : html`<span class="positive">正股已覆盖</span>`}
    </div>` : null}
    ${stockBlocked ? html`<div class="error-banner" style="margin-top:8px">正股不足：${def.label} 每张合约需要 100 股 ${symbol}，当前只有 ${fmt.num(stockPosition.qty, 4)} 股。请先买入正股，或改用不依赖正股的策略。</div>` : null}

    <div class="strategy-summary" style="margin-top:10px">
      <div class="metric"><span>净权利金</span><strong>${fmt.money(Math.abs(netMid) * 100 * qty)}</strong><small>${netMid >= 0 ? "净支出" : "净收入"} · ${qty} 组</small></div>
      <div class="metric"><span>最大亏损</span><strong class="negative">${payoff.maxLoss != null ? fmt.money(payoff.maxLoss) : "—"}</strong><small>${def.stock ? "含正股腿、按当前限价估算" : "按当前净限价估算"}</small></div>
      <div class="metric"><span>最大收益</span><strong class="positive">${payoff.maxProfit != null ? fmt.money(payoff.maxProfit) : "无限"}</strong><small>到期日、未计费用</small></div>
      <div class="metric"><span>盈亏平衡</span><strong>${payoff.breakevens.length ? payoff.breakevens.map((value) => fmt.price(value)).join(" / ") : "—"}</strong><small>标的价格</small></div>
    </div>

    <div class="grid-2" style="gap:12px;margin-top:12px;align-items:stretch">
      <div class="payoff-wrap"><${PayoffChart} data=${payoff.points} spot=${spot || chain?.spot} entry=${entry} /></div>
      <div class="stack" style="gap:8px">
        <div class="modal-note">${def.stock
          ? `正股腿不在订单里：本次只${def.legs[0].side === "sell" ? "卖出" : "买入"}期权，${shareTarget} 股 ${symbol} 需要你已持有。`
          : "多腿期权会以一条 mleg 组合单发送；只有全部腿一起成交，避免裸腿风险。"}期权交易风险高，仅用于学习。</div>
        ${error ? html`<div class="error-banner">${error}</div>` : null}
        <button class="btn btn-primary" disabled=${busy || !legs.length || stockBlocked} onClick=${submit}>${busy ? "提交中…" : `提交 ${def.label}`}</button>
        <button class="btn btn-sm" onClick=${() => { setPriceTouched(false); setStrikes({}); }}>恢复默认行权价</button>
      </div>
    </div>
  </div>`;
}

function PayoffChart({ data = [], spot, entry }) {
  if (!data.length) return html`<div class="chart-empty" style="height:170px">暂无收益图</div>`;
  const width = 600;
  const height = 180;
  const pad = 16;
  const minPrice = data[0].price;
  const maxPrice = data[data.length - 1].price;
  const values = data.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const x = (price) => pad + ((price - minPrice) / (maxPrice - minPrice || 1)) * (width - pad * 2);
  const y = (value) => pad + (1 - (value - minValue) / (maxValue - minValue || 1)) * (height - pad * 2);
  const path = data.map((point, index) => `${index ? "L" : "M"}${x(point.price).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const zero = y(0);
  return html`<svg viewBox=${`0 0 ${width} ${height}`} role="img" aria-label="到期收益图">
    <line x1=${pad} y1=${zero} x2=${width - pad} y2=${zero} stroke="var(--line-strong)" stroke-dasharray="4 4" />
    <line x1=${x(spot || minPrice)} y1=${pad} x2=${x(spot || minPrice)} y2=${height - pad} stroke="var(--line)" stroke-dasharray="3 3" />
    <path d=${path} fill="none" stroke="var(--brand)" stroke-width="2.2" />
    <circle cx=${x(spot || minPrice)} cy=${y(0)} r="3" fill="var(--brand)" />
    <text x=${pad} y=${height - 2} fill="var(--muted-2)" font-size="9">${fmt.price(minPrice)}</text>
    <text x=${width - pad} y=${height - 2} fill="var(--muted-2)" font-size="9" text-anchor="end">${fmt.price(maxPrice)}</text>
    <text x=${x(spot || minPrice)} y=${pad - 4} fill="var(--muted)" font-size="9" text-anchor="middle">现价</text>
    <text x=${width - pad} y=${pad + 8} fill="var(--muted-2)" font-size="9" text-anchor="end">限价 ${fmt.price(entry)}</text>
  </svg>`;
}

export function OptionPositions({ symbol }) {
  const store = useStore();
  const [busy, setBusy] = useState("");
  const positions = store.positions.filter((item) => (
    optionRoot(item.symbol) === symbol && (item.asset_class === "us_option" || optionRoot(item.symbol))
  ));
  if (!positions.length) return null;

  async function closePosition(item) {
    if (!confirm(`确定平掉 ${item.symbol} 的全部期权持仓吗？`)) return;
    setBusy(item.symbol);
    try {
      await api(`/api/stocks/${encodeURIComponent(symbol)}/options/positions/${encodeURIComponent(item.symbol)}`, { method: "DELETE" });
      notify(`已提交平仓 ${item.symbol}`, "success");
      await refreshTrading({ silent: true });
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy("");
    }
  }

  async function optionAction(item, action) {
    const label = action === "exercise" ? "行权" : "不执行";
    if (!confirm(`确定对 ${item.symbol} 提交${label}指令吗？`)) return;
    setBusy(item.symbol);
    try {
      await api(`/api/stocks/${encodeURIComponent(symbol)}/options/positions/${encodeURIComponent(item.symbol)}/${action}`, { method: "POST" });
      notify(`已提交${label}指令 ${item.symbol}`, "success");
      await refreshTrading({ silent: true });
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy("");
    }
  }

  return html`<div class="card card-pad">
    <div class="row-between"><div><div class="card-title">期权持仓</div><div class="card-sub">${symbol} 的期权合约</div></div><${Badge} tone="blue">${positions.length}<//></div>
    <div class="option-positions" style="margin-top:8px">
      ${positions.map((item) => html`<div class="option-position-row">
        <div><b>${optionRoot(item.symbol)}</b><div class="text-xs text-muted">${item.symbol}</div></div>
        <div><span class="text-xs text-muted">数量</span><b>${fmt.num(item.qty, 4)}</b></div>
        <div><span class="text-xs text-muted">成本</span><b>${fmt.price(item.avg_entry_price)}</b></div>
        <div><span class="text-xs text-muted">现价</span><b>${fmt.price(item.current_price)}</b></div>
        <div><span class="text-xs text-muted">市值</span><b>${fmt.money(item.market_value)}</b></div>
        <div><span class="text-xs text-muted">浮动盈亏</span><b class=${toneClass(item.unrealized_pl)}>${fmt.moneySigned(item.unrealized_pl)}</b></div>
        <div class="watch-actions">
          <button class="btn btn-sm" disabled=${busy === item.symbol} onClick=${() => optionAction(item, "exercise")}>行权</button>
          <button class="btn btn-sm" disabled=${busy === item.symbol} onClick=${() => optionAction(item, "do-not-exercise")}>不执行</button>
          <button class="btn btn-sm btn-danger" disabled=${busy === item.symbol} onClick=${() => closePosition(item)}>${busy === item.symbol ? "…" : "平仓"}</button>
        </div>
      </div>`)}
    </div>
  </div>`;
}