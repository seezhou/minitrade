import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, toneClass } from "../utils.js";
import { useAsync, useDocumentTitle } from "../hooks.js";
import { notify, openSearch, refreshTrading, useStore } from "../store.js";
import { navigate, stockPath } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, Empty, ErrorBanner, LoadingRow, Logo } from "../ui.js";
import { ModifyOrderOverlay } from "../components/trade-ticket.js";

const STATUS_LABEL = {
  new: "新订单",
  accepted: "已接受",
  pending_new: "待确认",
  partially_filled: "部分成交",
  filled: "已成交",
  canceled: "已取消",
  rejected: "已拒绝",
  expired: "已过期",
  replaced: "已替换",
  pending_cancel: "撤销中",
  pending_replace: "修改中",
  accepted_for_bidding: "竞价接受",
  held: "挂起",
};

const TYPE_LABEL = {
  market: "市价",
  limit: "限价",
  stop: "止损",
  stop_limit: "止损限价",
  trailing_stop: "追踪止损",
};

const TIF_LABEL = { day: "DAY", gtc: "GTC", opg: "OPG", cls: "CLS", ioc: "IOC", fok: "FOK" };

function statusTone(status) {
  if (["new", "accepted", "pending_new", "partially_filled", "accepted_for_bidding"].includes(status)) return status === "partially_filled" ? "amber" : "blue";
  if (status === "filled") return "green";
  if (status === "rejected") return "red";
  return "neutral";
}

function statusLabel(status) {
  return STATUS_LABEL[status] || status || "—";
}

function optionRoot(symbol) {
  const match = /^([A-Z]+)\d{6}[CP]\d{8}$/.exec(symbol || "");
  return match ? match[1] : null;
}

function orderSymbol(order) {
  return order.symbol || order.legs?.[0]?.symbol || "";
}

function orderRoot(order) {
  const symbol = orderSymbol(order);
  return optionRoot(symbol) || symbol;
}

function orderRoute(order) {
  const symbol = orderSymbol(order);
  if (symbol.includes("/")) return `/crypto/${encodeURIComponent(symbol)}`;
  if (optionRoot(symbol)) return stockPath(optionRoot(symbol), "options");
  return stockPath(symbol);
}

export function OrdersPage() {
  const store = useStore();
  const [tab, setTab] = useState("open");
  const [filter, setFilter] = useState("");
  const [modify, setModify] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [activityType, setActivityType] = useState("FILL");
  const [activityAfter, setActivityAfter] = useState("");
  const [activityUntil, setActivityUntil] = useState("");
  useDocumentTitle("订单");

  const activityTypes = activityType === "all" ? "FILL,DIV,INT" : activityType;
  const activitiesQuery = useAsync(
    () => api(`/api/activities?types=${encodeURIComponent(activityTypes)}&limit=100${activityAfter ? `&after=${encodeURIComponent(activityAfter)}` : ""}${activityUntil ? `&until=${encodeURIComponent(activityUntil)}` : ""}`),
    [activityTypes, activityAfter, activityUntil],
  );

  useEffect(() => {
    refreshTrading({ silent: true });
  }, []);

  const orders = store.orders;
  const openOrders = orders.filter((order) => order.is_open);
  const closedOrders = orders.filter((order) => !order.is_open);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const filledToday = orders.filter((order) => {
    const stamp = order.filled_at || order.submitted_at;
    if (!stamp) return false;
    const date = new Date(stamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return date === today && order.status === "filled";
  });
  const tradedNotional = filledToday.reduce((sum, order) => sum + Number(order.filled_qty || 0) * Number(order.filled_avg_price || 0), 0);

  const filteredHistory = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    return closedOrders.filter((order) => !needle || orderSymbol(order).includes(needle));
  }, [closedOrders, filter]);

  async function cancelOrder(order) {
    setBusyId(order.id);
    try {
      await api(`/api/orders/${order.id}`, { method: "DELETE" });
      notify(`${orderSymbol(order)} 订单已取消`, "success");
      await refreshTrading({ silent: true });
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  const openContent = openOrders.length
    ? html`<div class="order-grid">${openOrders.map((order) => html`<${OrderCard} order=${order} busy=${busyId === order.id} onCancel=${() => cancelOrder(order)} onModify=${() => setModify(order)} />`)}</div>`
    : html`<${Card}><${Empty} icon="orders" title="没有未完成订单" description="订单成交或取消后会进入历史订单。你可以先搜索股票，做一笔模拟交易。" action=${html`<button class="btn btn-primary btn-sm" onClick=${openSearch}>搜索股票</button>`} /><//>`;

  return html`<div>
    <${PageHead}
      eyebrow="模拟交易 · 纸面账户"
      title="订单"
      sub="支持市价、限价、止损、止损限价、追踪止损、括号订单与延长时段。所有订单都发送到 Alpaca Paper Trading。"
      actions=${html`<button class="btn btn-sm" onClick=${() => refreshTrading()}><${Icon} name="refresh" size=${14} />刷新</button><button class="btn btn-primary btn-sm" onClick=${openSearch}><${Icon} name="search" size=${14} />搜索股票下单</button>`}
    />
    ${store.tradingError && html`<${ErrorBanner} message=${store.tradingError} onRetry=${() => refreshTrading()} />`}

    <div class="grid grid-4 mb-12">
      <div class="card card-pad"><div class="eyebrow">未完成订单</div><div style="font-size:22px;font-weight:800">${openOrders.length}</div><div class="text-xs text-muted">等待成交或取消</div></div>
      <div class="card card-pad"><div class="eyebrow">今日成交</div><div style="font-size:22px;font-weight:800">${filledToday.length}</div><div class="text-xs text-muted">美东时间今天</div></div>
      <div class="card card-pad"><div class="eyebrow">今日成交金额</div><div style="font-size:22px;font-weight:800">${fmt.money(tradedNotional)}</div><div class="text-xs text-muted">按成交均价估算</div></div>
      <div class="card card-pad"><div class="eyebrow">历史订单</div><div style="font-size:22px;font-weight:800">${closedOrders.length}</div><div class="text-xs text-muted">已成交 / 已取消</div></div>
    </div>

    <div class="seg mb-12">
      <button class=${cls(tab === "open" && "active")} onClick=${() => setTab("open")}>未完成 ${openOrders.length}</button>
      <button class=${cls(tab === "history" && "active")} onClick=${() => setTab("history")}>历史订单 ${closedOrders.length}</button>
      <button class=${cls(tab === "fills" && "active")} onClick=${() => setTab("fills")}>成交明细</button>
    </div>

    ${tab === "open" && openContent}
    ${tab === "history" && html`<${Card}>
      <div class="watch-toolbar">
        <div class="input-wrap" style="max-width:240px"><input class="input input-sm" value=${filter} onInput=${(event) => setFilter(event.currentTarget.value)} placeholder="按代码筛选" /><span class="input-suffix">FILTER</span></div>
        <div class="grow" />
        <span class="text-xs text-muted">共 ${filteredHistory.length} 条</span>
      </div>
      ${filteredHistory.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>提交时间</th><th>资产</th><th>方向</th><th>类型</th><th class="r">数量</th><th class="r">成交</th><th class="r">均价</th><th class="r">限价/触发</th><th>状态</th><th class="r">操作</th></tr></thead>
        <tbody>${filteredHistory.slice(0, 100).map((order) => html`<tr>
          <td class="text-muted">${fmt.dateTime(order.submitted_at || order.created_at)}</td>
          <td><b style="cursor:pointer" onClick=${() => navigate(orderRoute(order))}>${orderSymbol(order) || "多腿组合"}</b>${order.extended_hours ? html`<span class="badge" style="margin-left:5px">延长</span>` : null}</td>
          <td><${Badge} tone=${order.side === "buy" ? "green" : "red"}>${order.side === "buy" ? "买入" : "卖出"}<//></td>
          <td>${TYPE_LABEL[order.type] || order.type}${order.order_class !== "simple" ? html`<span class="badge" style="margin-left:5px">${order.order_class}</span>` : null}</td>
          <td class="r">${fmt.num(order.qty, 4)}${order.notional ? html`<div class="text-xs text-muted">${fmt.money(order.notional)}</div>` : null}</td>
          <td class="r">${fmt.num(order.filled_qty, 4)}</td>
          <td class="r">${fmt.price(order.filled_avg_price)}</td>
          <td class="r text-muted">${order.limit_price != null ? fmt.price(order.limit_price) : order.stop_price != null ? fmt.price(order.stop_price) : "—"}</td>
          <td><${Badge} tone=${statusTone(order.status)}>${statusLabel(order.status)}<//></td>
          <td class="r">${order.is_open ? html`<button class="btn btn-sm" onClick=${() => cancelOrder(order)}>取消</button>` : "—"}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<${Empty} icon="orders" title="没有历史订单" description="完成或取消的订单会出现在这里。" />`}
    <//>`}
    ${tab === "fills" && html`<${Card}>
      <div class="card-head"><div><div class="card-title">成交明细</div><div class="card-sub">Alpaca 活动记录：成交 FILL / 分红 DIV / 利息 INT</div></div><button class="card-link" onClick=${activitiesQuery.reload}>刷新</button></div>
      <div class="card-body">
        <div class="watch-toolbar" style="flex-wrap:wrap">
          <div class="seg">
            <button class=${cls(activityType === "FILL" && "active")} onClick=${() => setActivityType("FILL")}>成交</button>
            <button class=${cls(activityType === "DIV" && "active")} onClick=${() => setActivityType("DIV")}>分红</button>
            <button class=${cls(activityType === "INT" && "active")} onClick=${() => setActivityType("INT")}>利息</button>
            <button class=${cls(activityType === "all" && "active")} onClick=${() => setActivityType("all")}>全部</button>
          </div>
          <label class="row text-xs text-muted" style="gap:6px;white-space:nowrap;flex-shrink:0">开始<input class="input input-sm" style="width:136px" type="date" value=${activityAfter} onInput=${(event) => setActivityAfter(event.currentTarget.value)} /></label>
          <label class="row text-xs text-muted" style="gap:6px;white-space:nowrap;flex-shrink:0">结束<input class="input input-sm" style="width:136px" type="date" value=${activityUntil} onInput=${(event) => setActivityUntil(event.currentTarget.value)} /></label>
          ${activityAfter || activityUntil ? html`<button class="btn btn-sm" onClick=${() => { setActivityAfter(""); setActivityUntil(""); }}>清空日期</button>` : null}
          <div class="grow" />
          <span class="text-xs text-muted">${activitiesQuery.data?.length || 0} 条</span>
        </div>
        ${activitiesQuery.error && html`<${ErrorBanner} message=${activitiesQuery.error} onRetry=${activitiesQuery.reload} />`}
        ${activitiesQuery.data?.length ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>时间</th><th>类型</th><th>资产</th><th>方向</th><th class="r">数量</th><th class="r">价格</th><th class="r">金额</th><th>订单号</th></tr></thead>
          <tbody>${activitiesQuery.data.map((item) => {
            const kind = (item.activity_type || "").toUpperCase();
            const kindLabel = { FILL: "成交", DIV: "分红", INT: "利息" }[kind] || kind || "—";
            const kindTone = kind === "FILL" ? "blue" : kind === "DIV" ? "green" : "neutral";
            return html`<tr>
              <td class="text-muted">${fmt.dateTime(item.transaction_time)}</td>
              <td><${Badge} tone=${kindTone}>${kindLabel}<//></td>
              <td><b>${item.symbol || "—"}</b></td>
              <td>${item.side === "buy" ? "买入" : item.side === "sell" ? "卖出" : item.side || "—"}</td>
              <td class="r">${item.quantity != null ? fmt.num(item.quantity, 4) : "—"}</td>
              <td class="r">${item.price != null ? fmt.price(item.price) : "—"}</td>
              <td class="r">${fmt.moneySigned(item.amount)}</td>
              <td class="text-xs text-muted">${item.order_id ? `${String(item.order_id).slice(0, 8)}…` : "—"}</td>
            </tr>`;
          })}</tbody>
        </table></div>` : html`<${Empty} icon="activity" title="没有符合条件的记录" description="订单成交、分红入账或利息结算后会出现在这里；也可以清空日期范围再看全部。" />`}
      </div>
    <//>`}

    ${modify && html`<${ModifyOrderOverlay} order=${modify} onClose=${() => setModify(null)} onDone=${async () => { await refreshTrading({ silent: true }); activitiesQuery.reload(); }} />`}
  </div>`;
}

function OrderCard({ order, busy, onCancel, onModify }) {
  const filled = Number(order.filled_qty || 0);
  const total = Number(order.qty || 0);
  const progress = total ? Math.min(100, (filled / total) * 100) : 0;
  const priceText = order.limit_price != null ? fmt.price(order.limit_price) : order.stop_price != null ? fmt.price(order.stop_price) : order.trail_percent != null ? `${order.trail_percent}%` : "市价";
  const symbol = orderSymbol(order);
  const option = optionRoot(symbol);
  const crypto = symbol.includes("/");
  const canModify = order.order_class === "simple" && !option && !crypto;
  return html`<div class="order-card">
    <div class="order-top">
      <div class="order-sym">
        ${crypto ? html`<span class="crypto-mark small">${symbol.slice(0, 1)}</span>` : html`<${Logo} symbol=${option || symbol} />`}
        <div><b>${symbol || "多腿组合"}</b><span>${order.side === "buy" ? "买入" : "卖出"} · ${TYPE_LABEL[order.type] || order.type}${order.order_class !== "simple" ? ` · ${order.order_class}` : ""}</span></div>
      </div>
      <div class="row"><${Badge} tone=${order.side === "buy" ? "green" : "red"}>${order.side === "buy" ? "买入" : "卖出"}<//><${Badge} tone=${statusTone(order.status)}>${statusLabel(order.status)}<//></div>
    </div>
    <div class="order-meta">
      <span>数量 <b>${fmt.num(filled, 4)} / ${fmt.num(total, 4)}</b></span>
      <span>价格 <b>${priceText}</b></span>
      <span>有效期 <b>${TIF_LABEL[order.time_in_force] || order.time_in_force}</b></span>
      <span>提交 <b>${fmt.time(order.submitted_at || order.created_at)}</b></span>
      ${order.extended_hours ? html`<span class="badge badge-amber">延长时段</span>` : null}
    </div>
    <div class="order-progress"><i style=${`width:${progress}%`} /></div>
    <div class="order-actions">
      ${canModify ? html`<button class="btn btn-sm" onClick=${onModify}><${Icon} name="edit" size=${12} />改单</button>` : null}
      <button class="btn btn-sm btn-danger" onClick=${onCancel} disabled=${busy}>${busy ? "取消中…" : "取消订单"}</button>
    </div>
  </div>`;
}
