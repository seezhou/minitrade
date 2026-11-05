import { useState } from "preact/hooks";
import { html, fmt } from "../utils.js";
import { Icon } from "../icons.js";
import { Modal } from "../ui.js";
import { ALERT_OPS } from "../alert-rules.js";
import {
  addRule,
  clearTriggeredRules,
  notificationsEnabled,
  removeRule,
  requestNotificationPermission,
  setNotificationsEnabled,
  useAlertRules,
} from "../alerts.js";

/**
 * Price alert entry point for the stock page.
 *
 * Rules are local-only (Alpaca has no alert API) and evaluated against delayed
 * quotes, so the copy is explicit about the 15-minute lag.
 */
export function PriceAlertButton({ symbol, price }) {
  const [open, setOpen] = useState(false);
  const rules = useAlertRules();
  const waiting = rules.filter((rule) => rule.symbol === symbol && !rule.triggered_at).length;
  return html`<span>
    <button class="btn btn-sm" onClick=${() => setOpen(true)} title="本地价格提醒">
      <${Icon} name="alert" size=${13} />提醒${waiting ? ` ${waiting}` : ""}
    </button>
    ${open && html`<${PriceAlertDialog} symbol=${symbol} price=${price} onClose=${() => setOpen(false)} />`}
  </span>`;
}

export function PriceAlertDialog({ symbol, price, onClose }) {
  const rules = useAlertRules();
  const mine = rules.filter((rule) => rule.symbol === symbol);
  const waiting = mine.filter((rule) => !rule.triggered_at).length;
  const [op, setOp] = useState("above");
  const [value, setValue] = useState(() => (Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price).toFixed(2) : ""));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(notificationsEnabled());

  function submit() {
    const target = Number(value);
    if (!Number.isFinite(target) || target <= 0) {
      setError("请输入大于 0 的提醒价格。");
      return;
    }
    try {
      addRule({ symbol, op, price: target });
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function toggleNotice() {
    if (notice) {
      setNotificationsEnabled(false);
      setNotice(false);
      return;
    }
    const granted = await requestNotificationPermission();
    if (!granted) {
      setError("浏览器没有授予通知权限，触发时只会显示页面内提示。");
      return;
    }
    setNotificationsEnabled(true);
    setNotice(true);
    setError("");
  }

  return html`<${Modal}
    title=${`${symbol} 价格提醒`}
    subtitle="保存在本机浏览器；触发时弹出页面提示，可选系统通知"
    onClose=${onClose}
  >
    <div class="stack">
      <div class="text-sm text-muted">当前参考价 ${Number(price) > 0 ? fmt.price(price) : "—"}（延迟约 15 分钟）。提醒只在页面打开时检查，不会自动下单。</div>

      <div class="row wrap" style="gap:8px;align-items:end">
        <div class="field" style="flex:0 0 118px">
          <label>条件</label>
          <select class="select" value=${op} onChange=${(event) => setOp(event.currentTarget.value)}>
            <option value="above">高于 / 等于</option>
            <option value="below">低于 / 等于</option>
          </select>
        </div>
        <div class="field" style="flex:1 1 140px;min-width:120px">
          <label>价格</label>
          <div class="input-wrap">
            <input class="input" type="number" min="0.01" step="0.01" value=${value} onInput=${(event) => setValue(event.currentTarget.value)} />
            <span class="input-suffix">USD</span>
          </div>
        </div>
        <button class="btn btn-primary" style="flex:0 0 auto" onClick=${submit}>添加提醒</button>
      </div>

      ${error ? html`<div class="error-banner">${error}</div>` : null}

      <div>
        <div class="row-between" style="margin-bottom:6px">
          <div class="card-title">${symbol} 的提醒${waiting ? html` <span class="badge">${waiting} 条待触发</span>` : null}</div>
          ${mine.some((rule) => rule.triggered_at) ? html`<button class="card-link" onClick=${() => clearTriggeredRules()}>清除已触发</button>` : null}
        </div>
        ${mine.length ? html`<div class="stack-sm">
          ${mine.map((rule) => html`<div class="row-between" style="padding:7px 9px;border:1px solid var(--line);border-radius:9px">
            <span class="text-sm">
              ${ALERT_OPS[rule.op]} <b>${fmt.price(rule.price)}</b>
              ${rule.triggered_at
                ? html`<span class="badge badge-green" style="margin-left:6px">已于 ${fmt.time(rule.triggered_at)} ET 触发</span>`
                : html`<span class="text-muted" style="margin-left:6px">等待中</span>`}
            </span>
            <button class="card-link" onClick=${() => removeRule(rule.id)}>删除</button>
          </div>`)}
        </div>` : html`<div class="text-sm text-muted">还没有设置提醒。</div>`}
      </div>

      <div class="row-between" style="padding-top:4px">
        <div>
          <div class="text-sm">系统通知</div>
          <div class="text-xs text-muted">${notice ? "已开启（页面在后台时也能看到）" : "关闭时只显示页面内 Toast"}</div>
        </div>
        <button class="btn btn-sm" onClick=${toggleNotice}>${notice ? "关闭通知" : "开启通知"}</button>
      </div>

      <div class="modal-note">提醒规则只存在这台浏览器（localStorage），刷新或重开页面仍会保留；清除浏览器数据会一起删除。</div>
    </div>
  <//>`;
}
