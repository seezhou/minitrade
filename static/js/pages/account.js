import { useEffect, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, dateShort, timeRange, isEarlyClose, toneClass } from "../utils.js";
import { useAsync, useDocumentTitle } from "../hooks.js";
import { notify, refreshTrading, useStore } from "../store.js";
import { navigate } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, ErrorBanner, LoadingRow, Empty } from "../ui.js";

export function AccountPage() {
  const store = useStore();
  const configQuery = useAsync(() => api("/api/account/config"), []);
  const config = configQuery.data;
  const calendarQuery = useAsync(() => api("/api/calendar?days=10"), []);
  useDocumentTitle("账户");

  useEffect(() => {
    refreshTrading({ silent: true });
  }, []);

  const account = store.account;
  const equity = account?.portfolio_value ?? account?.equity;
  const cash = Number(account?.cash || 0);
  const longValue = Number(account?.long_market_value || 0);
  const totalAssets = cash + Math.abs(longValue);
  const cashPct = totalAssets ? cash / totalAssets : 0;
  const longPct = totalAssets ? Math.abs(longValue) / totalAssets : 0;
  const optionsLevel = account?.options_trading_level ?? account?.options_approved_level;
  const accountNumber = account?.account_number
    ? `${account.account_number.slice(0, 4)}••••${account.account_number.slice(-2)}`
    : "—";

  return html`<div>
    <${PageHead}
      eyebrow="账户与数据 · Paper Trading"
      title="账户"
      sub="查看纸面账户状态、购买力结构、交易配置与交易日历。"
      actions=${html`<a class="btn btn-sm" href="/api/docs" target="_blank" rel="noreferrer"><${Icon} name="external" size=${13} />API 文档</a><button class="btn btn-primary btn-sm" onClick=${() => refreshTrading()}><${Icon} name="refresh" size=${14} />刷新账户</button>`}
    />
    ${store.tradingError && html`<${ErrorBanner} message=${store.tradingError} onRetry=${() => refreshTrading()} />`}

    ${!account ? html`<${Card}><${LoadingRow} label="正在读取 Alpaca 账户…" /><//>` : html`<div class="stack">
      <div class="hero-account">
        <div class="hero-label"><span class="dot live" />账户状态 · ${account.status}</div>
        <div class="hero-value">${fmt.money(equity)}</div>
        <div class="hero-delta ${toneClass(account.day_pl)}">${account.day_pl != null ? `${fmt.moneySigned(account.day_pl)} (${fmt.pct(account.day_pl_pct)})` : "—"} <span class="muted">今日盈亏</span></div>
        <div class="hero-metrics">
          <div class="hero-metric"><span>账户号码</span><strong>${accountNumber}</strong></div>
          <div class="hero-metric"><span>账户类型</span><strong>纸面 · ${account.multiplier ? `保证金 ${account.multiplier}x` : "现金"}</strong></div>
          <div class="hero-metric"><span>购买力</span><strong>${fmt.money(account.buying_power)}</strong></div>
          <div class="hero-metric"><span>创建时间</span><strong>${fmt.dateLong(account.created_at)}</strong></div>
        </div>
        <div class="hero-actions"><${Badge} tone="green">PAPER ONLY<//></div>
      </div>

      <div class="grid grid-2">
        <${Card}>
          <div class="card-head"><div><div class="card-title">资金结构</div><div class="card-sub">按账户资产拆分，用于理解购买力来源</div></div><${Badge} tone="neutral">USD<//></div>
          <div class="card-body">
            <div class="balance-bar">
              <div class="balance-row"><span>现金</span><div class="balance-track"><i style=${`width:${(cashPct * 100).toFixed(1)}%;background:#0f9d76`} /></div><b>${fmt.money(cash)}</b></div>
              <div class="balance-row"><span>多头市值</span><div class="balance-track"><i style=${`width:${(longPct * 100).toFixed(1)}%;background:#3b82f6`} /></div><b>${fmt.money(longValue)}</b></div>
              <div class="balance-row"><span>初始保证金</span><div class="balance-track"><i style=${`width:${equity ? Math.min(100, (Number(account.initial_margin || 0) / Number(equity)) * 100) : 0}%;background:#f59e0b`} /></div><b>${fmt.money(account.initial_margin)}</b></div>
              <div class="balance-row"><span>维持保证金</span><div class="balance-track"><i style=${`width:${equity ? Math.min(100, (Number(account.maintenance_margin || 0) / Number(equity)) * 100) : 0}%;background:#e11d48`} /></div><b>${fmt.money(account.maintenance_margin)}</b></div>
            </div>
            <div class="divider" />
            <div class="key-stats">
              <div><span>现金</span><strong>${fmt.money(account.cash)}</strong></div>
              <div><span>账户总资产</span><strong>${fmt.money(account.portfolio_value)}</strong></div>
              <div><span>Reg T 购买力</span><strong>${fmt.money(account.regt_buying_power)}</strong></div>
              <div><span>有效购买力</span><strong>${fmt.money(account.effective_buying_power)}</strong></div>
              <div><span>期权购买力</span><strong>${fmt.money(account.options_buying_power)}</strong></div>
              <div><span>SMA</span><strong>${fmt.money(account.sma)}</strong></div>
            </div>
          </div>
        <//>

        <${Card}>
          <div class="card-head"><div><div class="card-title">交易配置</div><div class="card-sub">Alpaca 账户配置与权限</div></div><${Badge} tone="blue">ACCOUNT<//></div>
          <div class="card-body">
            <div class="key-stats">
              <div><span>账户状态</span><strong>${account.status}</strong></div>
              <div><span>日内交易次数</span><strong>${account.daytrade_count ?? "—"}</strong></div>
              <div><span>PDT 标记</span><strong>${account.pattern_day_trader ? "是" : "否"}</strong></div>
              <div><span>允许做空</span><strong>${account.shorting_enabled ? "是" : "否"}</strong></div>
              <div><span>期权等级</span><strong>Level ${optionsLevel ?? "—"}</strong></div>
              <div><span>加密状态</span><strong>${account.crypto_status || "—"}</strong></div>
              <div><span>碎股交易</span><strong>${config?.fractional_trading ? "开启" : "关闭"}</strong></div>
              <div><span>最大杠杆</span><strong>${config?.max_margin_multiplier ?? account.multiplier ?? "—"}x</strong></div>
              <div><span>禁止做空</span><strong>${config?.no_shorting ? "是" : "否"}</strong></div>
              <div><span>交易暂停</span><strong>${config?.suspend_trade ? "是" : "否"}</strong></div>
              <div><span>账户冻结</span><strong>${account.account_blocked ? "是" : "否"}</strong></div>
              <div><span>转账冻结</span><strong>${account.transfers_blocked ? "是" : "否"}</strong></div>
            </div>
            <p class="text-xs text-muted" style="margin-top:10px;line-height:1.55">配置数据来自 Alpaca 账户配置接口。可修改的字段在下方「账户配置」卡片里，每次只改一项。</p>
          </div>
        <//>
      </div>

      <${AccountConfigCard} config=${config} reload=${configQuery.reload} />

      <${RealizedPnlCard} />

      <div class="grid grid-2">
        <${Card}>
          <div class="card-head"><div><div class="card-title">交易日历</div><div class="card-sub">Alpaca 市场日历 · 美东时间</div></div><${Badge} tone="neutral">CALENDAR<//></div>
          <div class="card-body">
            ${calendarQuery.loading ? html`<${LoadingRow} />` : (calendarQuery.data?.upcoming || []).map((item) => html`<div class="calendar-row">
              <div class="date"><b>${dateShort(item.date)}</b>${item.date === calendarQuery.data.today ? html`<${Badge} tone="green">今天<//>` : null}</div>
              <span>${timeRange(item.open, item.close)}${isEarlyClose(item.close) ? " · 提前收盘" : ""}</span>
            </div>`)}
            <p class="text-xs text-muted" style="margin-top:10px">时区：America/New_York。提前收盘日会在日历中标注。</p>
          </div>
        <//>

        <${Card}>
          <div class="card-head"><div><div class="card-title">数据与 API</div><div class="card-sub">能力矩阵、权限限制与系统信息</div></div><${Icon} name="layers" size=${17} className="muted" /></div>
          <div class="card-body">
            <div class="key-stats">
              <div><span>行情源</span><strong>Delayed SIP</strong></div>
              <div><span>延迟</span><strong>约 15 分钟</strong></div>
              <div><span>交易模式</span><strong>Paper</strong></div>
              <div><span>期权等级</span><strong>Level ${optionsLevel ?? "—"}</strong></div>
            </div>
            <div class="divider" />
            <p class="text-sm text-muted" style="line-height:1.65">完整的 Alpaca 能力矩阵、数据延迟说明、账户权限和 API 文档入口，已移到独立的数据页面。</p>
            <button class="btn btn-primary btn-sm btn-block" style="margin-top:10px" onClick=${() => navigate("/data")}>打开数据与 API 页面 <${Icon} name="chevronRight" size=${12} /></button>
          </div>
        <//>
      </div>
    </div>`}
  </div>`;
}

const CONFIG_TOGGLES = [
  ["no_shorting", "禁止做空", "开启后不能建立新的空头仓位。"],
  ["fractional_trading", "碎股交易", "允许按金额或小数股下单。"],
  ["disable_overnight_trading", "关闭隔夜交易", "关闭隔夜时段的交易能力。"],
  ["ptp_no_exception_entry", "禁止 PTP 例外入场", "限制触发 PDT 后的例外建仓。"],
  ["suspend_trade", "暂停交易", "开启后所有新订单都会被拒绝，验证完请立即恢复。"],
];

function AccountConfigCard({ config, reload }) {
  const [busy, setBusy] = useState("");
  const [margin, setMargin] = useState("");

  useEffect(() => {
    setMargin(config?.max_margin_multiplier != null ? String(config.max_margin_multiplier) : "");
  }, [config?.max_margin_multiplier]);

  async function patch(field, value, label, display) {
    if (!confirm(`确定把「${label}」修改为 ${display} 吗？\n\n这会直接写入 Alpaca 纸面账户配置。`)) return;
    setBusy(field);
    try {
      await api("/api/account/config", { method: "PATCH", body: { [field]: value } });
      notify(`已更新「${label}」`, "success");
      await reload?.();
      await refreshTrading({ silent: true });
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy("");
    }
  }

  return html`<${Card}>
    <div class="card-head">
      <div><div class="card-title">账户配置</div><div class="card-sub">与 Alpaca /v2/account/configurations 同步，每次只改一个字段</div></div>
      <${Badge} tone="amber">谨慎操作<//>
    </div>
    <div class="card-body">
      ${!config ? html`<${LoadingRow} label="正在读取账户配置…" />` : html`<div class="table-wrap"><table class="table">
        <thead><tr><th>配置项</th><th>当前值</th><th class="r">操作</th></tr></thead>
        <tbody>
          ${CONFIG_TOGGLES.map(([key, label, note]) => {
            const current = Boolean(config[key]);
            return html`<tr>
              <td><b>${label}</b><div class="text-xs text-muted">${note}</div></td>
              <td>${current ? html`<${Badge} tone="green">开启<//>` : html`<${Badge} tone="neutral">关闭<//>`}</td>
              <td class="r"><button class=${cls("btn btn-sm", key === "suspend_trade" && !current && "btn-danger")} disabled=${busy === key} onClick=${() => patch(key, !current, label, current ? "关闭" : "开启")}>${busy === key ? "保存中…" : current ? "改为关闭" : "开启"}</button></td>
            </tr>`;
          })}
          <tr>
            <td><b>最大杠杆</b><div class="text-xs text-muted">保证金倍数，范围 1–4。</div></td>
            <td>${config.max_margin_multiplier != null ? `${config.max_margin_multiplier}x` : "—"}</td>
            <td class="r">
              <div class="row" style="gap:6px;justify-content:flex-end">
                <input class="input input-sm" style="width:76px" type="number" min="1" max="4" step="1" value=${margin} onInput=${(event) => setMargin(event.currentTarget.value)} />
                <button class="btn btn-sm" disabled=${busy === "max_margin_multiplier" || !margin} onClick=${() => {
                  const value = Number(margin);
                  if (!Number.isInteger(value) || value < 1 || value > 4) {
                    notify("最大杠杆应为 1–4 的整数", "error");
                    return;
                  }
                  patch("max_margin_multiplier", value, "最大杠杆", `${value}x`);
                }}>${busy === "max_margin_multiplier" ? "保存中…" : "保存"}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table></div>`}
      <p class="text-xs text-muted" style="margin-top:10px;line-height:1.55">开关会立即生效；每次修改前都会弹窗确认，保存后重新读取配置。不要长期保持「暂停交易」为开启状态。</p>
    </div>
  <//>`;
}

const PNL_PERIODS = [[30, "30 天"], [90, "90 天"], [365, "1 年"], [730, "2 年"]];

function RealizedPnlCard() {
  const [days, setDays] = useState(365);
  const query = useAsync(() => api(`/api/account/realized-pnl?days=${days}`), [days]);
  const data = query.data;
  const rows = data?.symbols || [];
  const total = data?.total_realized_pl;
  const totalColor = total == null ? "" : total > 0 ? "var(--green)" : total < 0 ? "var(--red)" : "";
  const periodLabel = (PNL_PERIODS.find(([value]) => value === days) || [days, `${days} 天`])[1];

  return html`<${Card}>
    <div class="card-head" style="flex-wrap:wrap">
      <div><div class="card-title">已实现盈亏</div><div class="card-sub">按 Alpaca 活动记录（FILL / DIV / INT）以平均成本法估算，当前窗口最近 ${periodLabel}</div></div>
      <div class="row" style="gap:8px">
        <div class="seg">
          ${PNL_PERIODS.map(([value, label]) => html`<button class=${cls(days === value && "active")} onClick=${() => setDays(value)}>${label}</button>`)}
        </div>
        <${Badge} tone=${data?.partial ? "amber" : "neutral"}>${data?.partial ? "部分数据" : "估算值"}<//>
      </div>
    </div>
    <div class="card-body">
      ${query.error
        ? html`<${ErrorBanner} message=${query.error} onRetry=${query.reload} />`
        : !data
          ? html`<${LoadingRow} label="正在计算已实现盈亏…" />`
          : html`
            <div class="metric-grid mb-12">
              <div class="metric"><span>已实现盈亏</span><strong style=${totalColor ? `color:${totalColor}` : ""}>${total == null ? "—" : total === 0 ? fmt.money(0) : fmt.moneySigned(total)}</strong></div>
              <div class="metric"><span>分红收入</span><strong>${fmt.money(data.dividend_income)}</strong></div>
              <div class="metric"><span>利息收入</span><strong>${fmt.money(data.interest_income)}</strong></div>
              <div class="metric"><span>成交笔数</span><strong>${fmt.num(data.window?.fills, 0)}</strong></div>
            </div>
            ${rows.length ? html`<div class="table-wrap"><table class="table">
              <thead><tr><th>代码</th><th class="r">已实现</th><th class="r">买入量</th><th class="r">卖出量</th><th class="r">剩余</th><th class="r">成交笔数</th></tr></thead>
              <tbody>${rows.map((row) => html`<tr>
                <td><b>${row.symbol}</b>${row.reason ? html`<div class="text-xs text-muted">${row.reason}</div>` : null}</td>
                <td class="r">${row.realized_pl == null ? html`<span class="text-muted">—</span>` : fmt.moneySigned(row.realized_pl)}</td>
                <td class="r">${fmt.num(row.buy_qty, 4)}</td>
                <td class="r">${fmt.num(row.sell_qty, 4)}</td>
                <td class="r">${fmt.num(row.open_qty, 4)}</td>
                <td class="r">${row.fills}</td>
              </tr>`)}</tbody>
            </table></div>` : html`<${Empty} icon="activity" title="窗口内没有成交" description="有成交、分红或利息入账后，这里会按代码汇总已实现盈亏。" />`}
            <p class="text-xs text-muted" style="margin-top:10px;line-height:1.55">${data.note}</p>
            ${data.warnings?.length ? html`<p class="text-xs text-muted" style="margin-top:6px;line-height:1.55">${data.warnings.join(" ")}</p>` : null}
          `}
    </div>
  <//>`;
}
