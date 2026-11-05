import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass } from "../utils.js";
import { useAsync } from "../hooks.js";
import { useLive } from "../stream.js";
import { closeTrade, notify, refreshTrading, useStore } from "../store.js";
import { Icon } from "../icons.js";
import { Modal, Logo } from "../ui.js";

const ORDER_TYPES = [
  { value: "market", label: "市价单 · 立即按市场价成交" },
  { value: "limit", label: "限价单 · 指定成交价格" },
  { value: "stop", label: "止损市价单 · 触发后按市价卖出/买入" },
  { value: "stop_limit", label: "止损限价单 · 触发后按限价挂单" },
  { value: "trailing_stop", label: "追踪止损单 · 随价格移动的保护单" },
];

const TIF_OPTIONS = [
  ["day", "DAY · 当日有效"],
  ["gtc", "GTC · 撤销前有效"],
  ["opg", "OPG · 开盘成交"],
  ["cls", "CLS · 收盘成交"],
  ["ioc", "IOC · 立即成交否则取消"],
  ["fok", "FOK · 全部成交否则取消"],
];

export function TradeTicketOverlay() {
  const store = useStore();
  if (!store.tradeModal) return null;
  const { symbol, side } = store.tradeModal;
  return html`<${TradeTicket} key=${`${symbol}-${side}`} symbol=${symbol} initialSide=${side} />`;
}

function TradeTicket({ symbol, initialSide }) {
  const store = useStore();
  const [side, setSide] = useState(initialSide || "buy");
  const [orderType, setOrderType] = useState("market");
  const [qtyMode, setQtyMode] = useState("shares");
  const [qty, setQty] = useState("");
  const [notional, setNotional] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [trailMode, setTrailMode] = useState("percent");
  const [trailValue, setTrailValue] = useState("5");
  const [tif, setTif] = useState("day");
  const [extendedHours, setExtendedHours] = useState(false);
  const [orderClass, setOrderClass] = useState("simple");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [clientOrderId, setClientOrderId] = useState("");
  const [allowShort, setAllowShort] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const { data: snapshot } = useAsync(() => api(`/api/stocks/${encodeURIComponent(symbol)}/snapshot`), [symbol]);
  const { ticks } = useLive([symbol]);
  const tick = ticks[symbol] || {};
  const marketPrice = tick.price ?? snapshot?.price ?? null;
  const previousClose = snapshot?.previous_close ?? null;
  const change = marketPrice != null && previousClose ? marketPrice - previousClose : snapshot?.change;
  const changePct = change != null && previousClose ? change / previousClose : snapshot?.change_pct;
  const position = store.positions.find((item) => item.symbol === symbol);
  const held = Number(position?.qty_available ?? position?.qty ?? 0);
  const buyingPower = Number(store.account?.buying_power ?? 0);
  const accountType = store.account?.multiplier ? `保证金 ${store.account.multiplier}x` : "现金账户";

  useEffect(() => {
    if (!marketPrice) return;
    setLimitPrice((current) => (current === "" ? Number(marketPrice).toFixed(2) : current));
    setStopPrice((current) => (current === "" ? (Number(marketPrice) * 0.95).toFixed(2) : current));
    setTakeProfit((current) => (current === "" ? (Number(marketPrice) * 1.1).toFixed(2) : current));
    setStopLoss((current) => (current === "" ? (Number(marketPrice) * 0.95).toFixed(2) : current));
  }, [marketPrice]);

  useEffect(() => {
    if (position && initialSide === "sell") setQty((current) => (current === "" ? String(Math.min(Number(position.qty_available ?? position.qty), 1000000)) : current));
  }, [position, initialSide]);

  useEffect(() => {
    if (side === "sell") {
      setOrderClass((value) => (value === "bracket" ? "simple" : value));
      setQtyMode("shares");
    }
    if (orderType !== "market" && qtyMode === "notional") setQtyMode("shares");
  }, [side, orderType, qtyMode]);

  const needsLimit = orderType === "limit" || orderType === "stop_limit";
  const needsStop = orderType === "stop" || orderType === "stop_limit";
  const isTrailing = orderType === "trailing_stop";
  const isFractional = qtyMode === "shares" && qty !== "" && !Number.isInteger(Number(qty));
  const estimatedQty = qtyMode === "notional"
    ? (marketPrice ? Number(notional || 0) / Number(marketPrice) : 0)
    : Number(qty || 0);
  const estimatedValue = qtyMode === "notional" ? Number(notional || 0) : estimatedQty * Number(marketPrice || limitPrice || 0);

  const disabledReason = useMemo(() => {
    if (!symbol) return "请选择股票。";
    if (side === "sell" && qtyMode === "notional") return "卖出请使用股数。";
    if (orderClass !== "simple" && (orderType === "stop" || orderType === "stop_limit" || isTrailing)) return "括号单 / OCO / OTO 只支持市价或限价主单。";
    if (orderClass === "bracket" && side === "sell") return "括号单目前只支持买入方向。";
    return "";
  }, [symbol, side, qtyMode, orderClass, orderType, isTrailing]);

  function buildPayload() {
    const payload = {
      symbol,
      side,
      order_type: orderType,
      time_in_force: tif,
      extended_hours: extendedHours,
      allow_short: allowShort,
    };
    if (qtyMode === "notional") payload.notional = Number(notional);
    else payload.qty = Number(qty);
    if (needsLimit) payload.limit_price = Number(limitPrice);
    if (needsStop) payload.stop_price = Number(stopPrice);
    if (isTrailing) {
      if (trailMode === "percent") payload.trail_percent = Number(trailValue);
      else payload.trail_price = Number(trailValue);
    }
    if (orderClass !== "simple") {
      payload.order_class = orderClass;
      if (takeProfit) payload.take_profit = Number(takeProfit);
      if (stopLoss) payload.stop_loss = Number(stopLoss);
    }
    if (clientOrderId.trim()) payload.client_order_id = clientOrderId.trim();
    return payload;
  }

  function validate() {
    if (!qtyMode || (qtyMode === "shares" && (!qty || Number(qty) <= 0))) return "请输入有效股数。";
    if (qtyMode === "notional" && (!notional || Number(notional) <= 0)) return "请输入有效的金额。";
    if (needsLimit && (!limitPrice || Number(limitPrice) <= 0)) return "请输入有效限价。";
    if (needsStop && (!stopPrice || Number(stopPrice) <= 0)) return "请输入有效触发价。";
    if (isTrailing && (!trailValue || Number(trailValue) <= 0)) return "请输入有效的追踪值。";
    if (side === "sell" && qtyMode === "shares" && Number(qty) > held && !allowShort) {
      return `可卖 ${held} 股。如需做空，请在高级选项中勾选「允许做空」。`;
    }
    if (orderClass === "bracket" && (!takeProfit || !stopLoss)) return "括号订单需要填写止盈价与止损价。";
    if (orderClass === "oco" && (!takeProfit || !stopLoss)) return "OCO 需要同时填写止盈价与止损价。";
    if (orderClass === "oto" && !takeProfit && !stopLoss) return "OTO 至少需要一个止盈或止损出口。";
    if (clientOrderId.trim().length > 48) return "client order id 最多 48 个字符。";
    if (extendedHours && (orderType !== "limit" || tif !== "day")) return "延长时段只支持限价单 + DAY。";
    if (extendedHours && isFractional) return "延长时段需要整数股。";
    if (isFractional && (orderType !== "market" || tif !== "day" || extendedHours)) return "碎股只支持市价 + DAY + 非延长时段。";
    return "";
  }

  async function submit(event) {
    event.preventDefault();
    const message = validate() || disabledReason;
    if (message) {
      setError(message);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orders", { method: "POST", body: buildPayload() });
      closeTrade();
      notify(`${side === "buy" ? "买入" : "卖出"} ${symbol} 的模拟订单已提交`, "success");
      await refreshTrading({ silent: true });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSubmitting(false);
    }
  }

  return html`<div class="modal-backdrop" onMouseDown=${(event) => { if (event.target === event.currentTarget) closeTrade(); }}>
    <form class="modal" onSubmit=${submit}>
      <div class="modal-head">
        <div class="row" style="gap:11px">
          <${Logo} symbol=${symbol} />
          <div>
            <h2 style="font-size:16px">${symbol} 模拟交易</h2>
            <div class="card-sub">Alpaca 纸面账户 · ${accountType}</div>
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" onClick=${closeTrade} aria-label="关闭"><${Icon} name="x" size=${16} /></button>
      </div>

      <div class="modal-body">
        <div class="ticket-side">
          <button type="button" class=${cls("buy", side === "buy" && "active")} onClick=${() => setSide("buy")}>买入</button>
          <button type="button" class=${cls("sell", side === "sell" && "active")} onClick=${() => setSide("sell")}>卖出</button>
        </div>

        <div class="row-between" style="background:var(--surface-2);border-radius:9px;padding:9px 11px">
          <div>
            <div class="text-xs text-muted">最新价格</div>
            <div style="font-size:17px;font-weight:800" class="tabular">${marketPrice != null ? fmt.price(marketPrice) : "—"}</div>
          </div>
          <div class="text-right">
            <div class=${cls("text-sm", toneClass(changePct))} style="font-weight:700">${change != null ? fmt.moneySigned(change) : "—"} ${changePct != null ? fmt.pct(changePct) : ""}</div>
            <div class="text-xs text-muted">${position ? `持有 ${fmt.num(position.qty, 4)} 股 · 可卖 ${fmt.num(held, 4)}` : "当前无持仓"}</div>
          </div>
        </div>

        <div class="field">
          <label>订单类型</label>
          <select class="select" value=${orderType} onChange=${(event) => setOrderType(event.currentTarget.value)}>
            ${ORDER_TYPES.map((item) => html`<option value=${item.value}>${item.label}</option>`)}
          </select>
        </div>

        ${orderType === "market" && side === "buy" && html`<div class="seg">
          <button type="button" class=${cls(qtyMode === "shares" && "active")} onClick=${() => setQtyMode("shares")}>按股数</button>
          <button type="button" class=${cls(qtyMode === "notional" && "active")} onClick=${() => setQtyMode("notional")}>按金额</button>
        </div>`}

        <div class="grid-2" style="gap:9px">
          ${qtyMode === "notional" ? html`<div class="field">
            <label>金额（美元）</label>
            <div class="input-wrap"><input class="input" type="number" min="1" step="1" value=${notional} onInput=${(event) => setNotional(event.currentTarget.value)} placeholder="例如 500" /><span class="input-suffix">USD</span></div>
          </div>` : html`<div class="field">
            <label>数量（股）</label>
            <div class="input-wrap"><input class="input" type="number" min="0.0001" step="0.0001" value=${qty} onInput=${(event) => setQty(event.currentTarget.value)} placeholder="例如 10" /><span class="input-suffix">股</span></div>
          </div>`}
          ${needsLimit ? html`<div class="field">
            <label>限价</label>
            <div class="input-wrap"><input class="input" type="number" min="0.01" step="0.01" value=${limitPrice} onInput=${(event) => setLimitPrice(event.currentTarget.value)} /><span class="input-suffix">USD</span></div>
          </div>` : needsStop ? html`<div class="field">
            <label>触发价</label>
            <div class="input-wrap"><input class="input" type="number" min="0.01" step="0.01" value=${stopPrice} onInput=${(event) => setStopPrice(event.currentTarget.value)} /><span class="input-suffix">USD</span></div>
          </div>` : isTrailing ? html`<div class="field">
            <label>追踪方式</label>
            <select class="select" value=${trailMode} onChange=${(event) => setTrailMode(event.currentTarget.value)}>
              <option value="percent">按百分比</option>
              <option value="price">按固定金额</option>
            </select>
          </div>` : html`<div class="field">
            <label>预估价格</label>
            <div class="input-wrap"><input class="input" value=${marketPrice != null ? marketPrice.toFixed(2) : ""} disabled /><span class="input-suffix">市价</span></div>
          </div>`}
        </div>

        ${orderType === "stop_limit" && html`<div class="field">
          <label>限价</label>
          <div class="input-wrap"><input class="input" type="number" min="0.01" step="0.01" value=${limitPrice} onInput=${(event) => setLimitPrice(event.currentTarget.value)} /><span class="input-suffix">USD</span></div>
        </div>`}

        ${isTrailing && html`<div class="field">
          <label>${trailMode === "percent" ? "追踪百分比" : "追踪金额"}</label>
          <div class="input-wrap"><input class="input" type="number" min="0.01" step="0.01" value=${trailValue} onInput=${(event) => setTrailValue(event.currentTarget.value)} /><span class="input-suffix">${trailMode === "percent" ? "%" : "USD"}</span></div>
        </div>`}

        <div class="ticket-summary">
          <div class="row"><span>预估${qtyMode === "notional" ? "股数" : "金额"}</span><b>${qtyMode === "notional" ? `${fmt.num(estimatedQty, 4)} 股` : fmt.money(estimatedValue)}</b></div>
          <div class="row"><span>可用购买力</span><b>${fmt.money(buyingPower)}</b></div>
          ${side === "sell" && html`<div class="row"><span>可卖股数</span><b>${fmt.num(held, 4)} 股</b></div>`}
        </div>

        <button type="button" class="btn btn-ghost btn-sm" style="justify-self:start;padding:0" onClick=${() => setAdvanced((value) => !value)}>
          <${Icon} name=${advanced ? "chevronDown" : "chevronRight"} size=${13} />高级选项（有效期、订单类别、client id）
        </button>

        ${advanced && html`<div class="ticket-advanced">
          <div class="field">
            <label>订单有效期</label>
            <select class="select" value=${tif} onChange=${(event) => setTif(event.currentTarget.value)}>
              ${TIF_OPTIONS.map(([value, label]) => html`<option value=${value}>${label}</option>`)}
            </select>
          </div>
          <label class="ticket-toggle">
            <span>允许在延长时段成交 ${extendedHours ? html`<span class="badge badge-amber">盘前/盘后</span>` : null}</span>
            <input type="checkbox" checked=${extendedHours} onChange=${(event) => setExtendedHours(event.currentTarget.checked)} />
          </label>
          <div class="field">
            <label>订单类别</label>
            <select class="select" value=${orderClass} onChange=${(event) => setOrderClass(event.currentTarget.value)}>
              <option value="simple">普通订单 simple</option>
              <option value="bracket" disabled=${side === "sell"}>括号单 bracket（仅买入）</option>
              <option value="oco">OCO · 止盈止损互斥</option>
              <option value="oto">OTO · 主单触发附加单</option>
            </select>
          </div>
          ${orderClass !== "simple" && html`<div class="grid-2" style="gap:9px">
            <div class="field"><label>止盈价${orderClass === "oto" ? "（可选）" : ""}</label><input class="input input-sm" type="number" min="0.01" step="0.01" value=${takeProfit} onInput=${(event) => setTakeProfit(event.currentTarget.value)} /></div>
            <div class="field"><label>止损价${orderClass === "oto" ? "（可选）" : ""}</label><input class="input input-sm" type="number" min="0.01" step="0.01" value=${stopLoss} onInput=${(event) => setStopLoss(event.currentTarget.value)} /></div>
          </div>`}
          <div class="field">
            <label>Client order ID（可选，最多 48 字符）</label>
            <div class="row" style="gap:6px">
              <input class="input input-sm grow" maxlength="48" value=${clientOrderId} onInput=${(event) => setClientOrderId(event.currentTarget.value)} placeholder="留空由 Alpaca 自动生成" />
              <button type="button" class="btn btn-sm" onClick=${() => setClientOrderId(`mt-${symbol.toLowerCase()}-${Date.now().toString(36)}`)}>生成</button>
            </div>
          </div>
          <label class="ticket-toggle">
            <span>允许做空（卖出超过持仓）</span>
            <input type="checkbox" checked=${allowShort} onChange=${(event) => setAllowShort(event.currentTarget.checked)} />
          </label>
          <p class="text-xs text-muted">延长时段仅支持限价单 + DAY 有效期、整数股；碎股仅支持市价单 + DAY。括号单仅买入；OCO 需要止盈 + 止损；OTO 至少需要一个出口。</p>
        </div>`}

        ${error && html`<div class="error-banner">${error}</div>`}
        ${disabledReason && !error && html`<div class="error-banner">${disabledReason}</div>`}

        <div class="modal-note">此订单只会发送到 Alpaca 纸面账户，不涉及真实资金。提交前请确认方向、数量和价格。</div>

        <div class="modal-actions">
          <button type="button" class="btn" onClick=${closeTrade}>取消</button>
          <button type="submit" class=${cls("btn", side === "buy" ? "btn-buy" : "btn-sell")} disabled=${submitting}>
            ${submitting ? html`<span class="spinner" />提交中…` : `确认${side === "buy" ? "买入" : "卖出"}`}
          </button>
        </div>
      </div>
    </form>
  </div>`;
}

export function ModifyOrderOverlay({ order, onClose, onDone }) {
  const [qty, setQty] = useState(order.qty != null ? String(order.qty) : "");
  const [limitPrice, setLimitPrice] = useState(order.limit_price != null ? String(order.limit_price) : "");
  const [stopPrice, setStopPrice] = useState(order.stop_price != null ? String(order.stop_price) : "");
  const [trail, setTrail] = useState(order.trail_price != null ? String(order.trail_price) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const body = {};
      if (qty) body.qty = Number(qty);
      if (limitPrice) body.limit_price = Number(limitPrice);
      if (stopPrice) body.stop_price = Number(stopPrice);
      if (trail) body.trail = Number(trail);
      const updated = await api(`/api/orders/${order.id}`, { method: "PATCH", body });
      notify(`订单已修改，新订单号 ${String(updated.id).slice(0, 8)}…`, "success");
      onClose?.();
      await onDone?.(updated);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSubmitting(false);
    }
  }

  return html`<${Modal} title=${`修改订单 · ${order.symbol}`} subtitle="Alpaca 会用新订单替换旧订单，订单号会变化。" onClose=${onClose}>
    <form class="stack" onSubmit=${submit}>
      <div class="field"><label>数量（股）</label><input class="input" type="number" min="0.0001" step="0.0001" value=${qty} onInput=${(event) => setQty(event.currentTarget.value)} /></div>
      ${order.type === "limit" && html`<div class="field"><label>限价</label><input class="input" type="number" min="0.01" step="0.01" value=${limitPrice} onInput=${(event) => setLimitPrice(event.currentTarget.value)} /></div>`}
      ${["stop", "stop_limit"].includes(order.type) && html`<div class="field"><label>触发价</label><input class="input" type="number" min="0.01" step="0.01" value=${stopPrice} onInput=${(event) => setStopPrice(event.currentTarget.value)} /></div>`}
      ${order.type === "trailing_stop" && html`<div class="field"><label>追踪金额</label><input class="input" type="number" min="0.01" step="0.01" value=${trail} onInput=${(event) => setTrail(event.currentTarget.value)} /></div>`}
      ${error && html`<div class="error-banner">${error}</div>`}
      <div class="modal-note">修改后旧订单会被替换。请刷新订单列表确认新订单状态。</div>
      <div class="modal-actions">
        <button type="button" class="btn" onClick=${onClose}>取消</button>
        <button class="btn btn-primary" disabled=${submitting}>${submitting ? "提交中…" : "保存修改"}</button>
      </div>
    </form>
  <//>`;
}
