import { useMemo, useState } from "preact/hooks";
import { api } from "../api.js";
import { html, cls, fmt, SESSION_LABEL } from "../utils.js";
import { useAsync, useDocumentTitle } from "../hooks.js";
import { useStore } from "../store.js";
import { navigate } from "../router.js";
import { Icon } from "../icons.js";
import { PageHead, Card, Badge, ErrorBanner, StatusDot } from "../ui.js";

const DATA_GROUPS = [
  {
    title: "市场行情",
    icon: "market",
    subtitle: "价格、K 线、新闻与市场筛选",
    items: [
      { name: "股票快照", status: "可用", tone: "green", note: "最新成交、买卖报价、日内 OHLC、成交量、VWAP。" },
      { name: "历史 K 线", status: "可用", tone: "green", note: "1 分钟到周线；日线以上按拆股/分红复权，最多 5 年。" },
      { name: "实时行情流", status: "延迟", tone: "amber", note: "共享延迟 SIP WebSocket，约 15 分钟；一次连接供所有页面使用。" },
      { name: "实时 SIP", status: "受限", tone: "amber", note: "当前订阅不允许查询最近 SIP 数据；需要 Alpaca 更高数据计划。" },
      { name: "新闻", status: "可用", tone: "green", note: "Alpaca News API，含摘要、全文、图片和关联代码。" },
      { name: "筛选器", status: "可用", tone: "green", note: "成交量榜、涨幅榜、跌幅榜，来自 Alpaca Screener。" },
      { name: "公司行动", status: "可用", tone: "green", note: "现金分红、拆股、并购等，覆盖最近 1–10 年。" },
      { name: "加密货币", status: "可用", tone: "green", note: "10 个交易对的快照、历史 K 线与模拟下单。" },
      { name: "外汇", status: "不可用", tone: "neutral", note: "当前账户权限不足（403），界面不展示假数据。" },
    ],
  },
  {
    title: "期权分析",
    icon: "layers",
    subtitle: "OPRA 快照、Greeks 与隐含波动率",
    items: [
      { name: "期权到期日", status: "可用", tone: "green", note: "从期权快照解析最近到期日，缓存 15 分钟。" },
      { name: "期权链", status: "可用", tone: "green", note: "按到期日和现价附近行权价拉取，避免整链过重。" },
      { name: "Greeks / IV", status: "可用", tone: "green", note: "Delta、Gamma、Theta、Vega、Rho 与隐含波动率。" },
      { name: "0DTE 希腊字母", status: "部分", tone: "amber", note: "当日到期合约经常没有 Greeks/IV；页面会自动提示并跳过。" },
      { name: "期权下单", status: "可用", tone: "green", note: "Level 3 单腿/多腿 mleg；限价/市价，纸面账户。" },
    ],
  },
  {
    title: "交易与账户",
    icon: "briefcase",
    subtitle: "纸面账户的交易、订单与历史",
    items: [
      { name: "账户与余额", status: "可用", tone: "green", note: "现金、权益、购买力、保证金、PDT、期权等级。" },
      { name: "持仓 / 平仓", status: "可用", tone: "green", note: "读取持仓，支持按股票平仓和全部平仓。" },
      { name: "订单全流程", status: "可用", tone: "green", note: "股票、期权、加密订单；改单、撤单、批量撤单。" },
      { name: "订单更新流", status: "可用", tone: "green", note: "Alpaca trade_updates WebSocket，推送成交/取消/拒绝。" },
      { name: "组合历史", status: "可用", tone: "green", note: "1D 到 ALL 的权益曲线，含延长时段估值。" },
      { name: "账户活动", status: "可用", tone: "green", note: "成交、分红、利息等 Activities 记录。" },
    ],
  },
  {
    title: "工具与搜索",
    icon: "search",
    subtitle: "自选、资产目录、日历与基础设施",
    items: [
      { name: "自选列表", status: "可用", tone: "green", note: "保存在 Alpaca 账户，多列表增删改查。" },
      { name: "资产搜索", status: "可用", tone: "green", note: "约 1.4 万个活跃美股，按代码/名称排序并带快照。" },
      { name: "市场时钟", status: "可用", tone: "green", note: "开闭市状态、下一次开盘/收盘。" },
      { name: "交易日历", status: "可用", tone: "green", note: "交易日、开收盘时间、提前收盘标记。" },
      { name: "Logo 代理", status: "可用", tone: "green", note: "优先 Alpaca Logo；当前订阅不允许时使用公开 CDN 回退，失败则显示主题字母卡片。" },
    ],
  },
];

function MarketMetaCard() {
  const [tape, setTape] = useState("C");
  const tradeQuery = useAsync(() => api(`/api/market/meta/conditions?ticktype=trade&tape=${tape}`), [tape]);
  const quoteQuery = useAsync(() => api(`/api/market/meta/conditions?ticktype=quote&tape=${tape}`), [tape]);
  const exchangesQuery = useAsync(() => api("/api/market/meta/exchanges"), []);
  const tradeItems = tradeQuery.data?.items || [];
  const quoteItems = quoteQuery.data?.items || [];
  const exchanges = exchangesQuery.data?.items || [];
  const error = tradeQuery.error || quoteQuery.error || exchangesQuery.error;

  const conditionsTable = (items) => html`<div class="table-wrap" style="max-height:200px;overflow:auto"><table class="table">
    <thead><tr><th>代码</th><th>含义</th></tr></thead>
    <tbody>${items.map((item) => html`<tr>
      <td><b>${item.code === " " ? "空" : item.code}</b></td>
      <td class="text-muted">${item.name}</td>
    </tr>`)}</tbody>
  </table></div>`;

  return html`<${Card}>
    <div class="card-head" style="flex-wrap:wrap">
      <div class="row" style="gap:9px">
        <span class="empty-icon" style="width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--surface-2);color:var(--muted-2)"><${Icon} name="filter" size=${16} /></span>
        <div><div class="card-title">条件码 / 交易所元数据</div><div class="card-sub">逐笔与报价里的条件码、交易所代码含义，来自 Alpaca 参考数据 · Tape A=NYSE / B=Nasdaq / C=CTA</div></div>
      </div>
      <div class="row" style="gap:6px">
        <span class="text-xs text-muted">Tape</span>
        <div class="seg">
          ${["A", "B", "C"].map((item) => html`<button class=${cls(tape === item && "active")} onClick=${() => setTape(item)} title=${`Tape ${item}`}>${item}</button>`)}
        </div>
      </div>
    </div>
    <div class="card-body">
      ${error && html`<${ErrorBanner} message=${error} onRetry=${() => { tradeQuery.reload(); quoteQuery.reload(); exchangesQuery.reload(); }} />`}
      <div class="grid grid-2" style="gap:14px">
        <div>
          <div class="card-title" style="margin-bottom:6px">逐笔条件码 <${Badge}>${tradeItems.length}<//></div>
          ${tradeItems.length ? conditionsTable(tradeItems) : html`<div class="text-sm text-muted">没有返回条件码。</div>`}
        </div>
        <div>
          <div class="card-title" style="margin-bottom:6px">报价条件码 <${Badge}>${quoteItems.length}<//></div>
          ${quoteItems.length ? conditionsTable(quoteItems) : html`<div class="text-sm text-muted">没有返回条件码。</div>`}
        </div>
      </div>
      <div class="divider" />
      <div class="row-between">
        <div><div class="card-title">交易所代码</div><div class="card-sub">用于解读逐笔 x、报价 bx / ax 字段</div></div>
        <${Badge} tone="neutral">${exchanges.length} 个<//>
      </div>
      ${exchanges.length ? html`<div class="table-wrap" style="max-height:220px;overflow:auto;margin-top:8px"><table class="table">
        <thead><tr><th>代码</th><th>交易所</th></tr></thead>
        <tbody>${exchanges.map((item) => html`<tr><td><b>${item.code}</b></td><td class="text-muted">${item.name}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="text-sm text-muted" style="margin-top:8px">没有返回交易所列表。</div>`}
      <div class="text-xs text-muted" style="margin-top:8px;line-height:1.6">条件码按 tape 分组：A 为 NYSE 系列，B 为 Nasdaq 系列，C 为 CTA 综合 tape。本项目逐笔与报价使用 IEX，不是 consolidated SIP。</div>
    </div>
  <//>`;
}

export function DataPage() {
  const store = useStore();
  const healthQuery = useAsync(() => api("/api/health"), []);
  useDocumentTitle("数据与 API");

  const status = store.streamStatus || {};
  const orderStatus = store.orderStatus || {};
  const clock = store.overview?.clock;
  const session = clock?.is_open ? "交易中" : SESSION_LABEL[clock?.session] || "休市";
  const optionsLevel = store.account?.options_trading_level ?? store.account?.options_approved_level;
  const counts = useMemo(() => {
    const all = DATA_GROUPS.flatMap((group) => group.items);
    return {
      total: all.length,
      available: all.filter((item) => item.status === "可用").length,
      limited: all.filter((item) => ["延迟", "受限", "部分", "未接入", "不可用"].includes(item.status)).length,
    };
  }, []);

  return html`<div>
    <${PageHead}
      eyebrow="数据源 · Alpaca API"
      title="数据与 API 能力"
      sub="这个终端实际调用的 Alpaca 能力、当前账户权限，以及每条数据的延迟和限制。"
      actions=${html`<a class="btn btn-sm" href="/api/docs" target="_blank" rel="noreferrer"><${Icon} name="external" size=${13} />API 文档</a><button class="btn btn-primary btn-sm" onClick=${() => healthQuery.reload()}><${Icon} name="refresh" size=${14} />刷新状态</button>`}
    />

    ${healthQuery.error && html`<${ErrorBanner} message=${healthQuery.error} onRetry=${healthQuery.reload} />`}

    <div class="grid grid-4 mb-12">
      <div class="card card-pad">
        <div class="eyebrow">行情流</div>
        <div class="row" style="margin-top:6px;gap:8px"><${StatusDot} status=${status} /><b style="font-size:15px">${status.state === "connected" ? "已连接" : status.state === "error" ? "受限" : status.state === "reconnecting" ? "重连中" : "连接中"}</b></div>
        <div class="text-xs text-muted" style="margin-top:5px">${status.message || "等待行情流状态"}</div>
      </div>
      <div class="card card-pad">
        <div class="eyebrow">订单流</div>
        <div class="row" style="margin-top:6px;gap:8px"><${StatusDot} status=${orderStatus} /><b style="font-size:15px">${orderStatus.state === "connected" ? "已连接" : "连接中"}</b></div>
        <div class="text-xs text-muted" style="margin-top:5px">${orderStatus.message || "等待订单流状态"}</div>
      </div>
      <div class="card card-pad">
        <div class="eyebrow">当前市场</div>
        <div style="font-size:15px;font-weight:800;margin-top:6px">${session}</div>
        <div class="text-xs text-muted" style="margin-top:5px">${clock?.is_open ? `下次收盘 ${fmt.time(clock?.next_close)} ET` : `下次开盘 ${fmt.time(clock?.next_open)} ET`}</div>
      </div>
      <div class="card card-pad">
        <div class="eyebrow">账户权限</div>
        <div style="font-size:15px;font-weight:800;margin-top:6px">期权 Level ${optionsLevel ?? "—"}</div>
        <div class="text-xs text-muted" style="margin-top:5px">${store.account?.crypto_status ? `加密 ${store.account.crypto_status}` : "等待账户数据"} · ${store.account?.status || "—"}</div>
      </div>
    </div>

    <div class="data-layout">
      <div class="stack">
        ${DATA_GROUPS.map((group) => html`<${Card}>
          <div class="card-head">
            <div class="row" style="gap:9px">
              <span class="empty-icon" style="width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--surface-2);color:var(--muted-2)"><${Icon} name=${group.icon} size=${16} /></span>
              <div><div class="card-title">${group.title}</div><div class="card-sub">${group.subtitle}</div></div>
            </div>
            <${Badge} tone="neutral">${group.items.length} 项<//>
          </div>
          <div class="card-body">
            <div class="api-matrix">
              ${group.items.map((item) => html`<div class="api-row">
                <b>${item.name}</b>
                <span><${Badge} tone=${item.tone}>${item.status}<//></span>
                <p>${item.note}</p>
              </div>`)}
            </div>
          </div>
        <//>`)}
        <${MarketMetaCard} />
      </div>

      <div class="stack">
        <${Card} className="card-pad">
          <div class="row-between"><div><div class="card-title">数据源</div><div class="card-sub">Alpaca 官方接口</div></div><${Icon} name="activity" size=${17} className="muted" /></div>
          <div class="key-stats" style="margin-top:12px">
            <div><span>行情</span><strong>Market Data API</strong></div>
            <div><span>交易</span><strong>Paper Trading API</strong></div>
            <div><span>实时</span><strong>Delayed SIP</strong></div>
            <div><span>延迟</span><strong>约 15 分钟</strong></div>
            <div><span>期权</span><strong>OPRA Snapshots</strong></div>
            <div><span>新闻</span><strong>Alpaca News</strong></div>
          </div>
          <div class="divider" />
          <div class="text-sm text-muted" style="line-height:1.65">
            浏览器不会直接连接 Alpaca，也不会接触 API 密钥。所有请求由本地 FastAPI 代理；行情流和订单流也是后端共享连接后再分发给浏览器。
          </div>
        <//>

        <${Card} className="card-pad">
          <div class="row-between"><div><div class="card-title">能力统计</div><div class="card-sub">当前 UI 覆盖</div></div><${Badge} tone="green">${counts.available} 可用<//></div>
          <div class="metric-grid" style="grid-template-columns:1fr 1fr;margin-top:12px">
            <div class="metric"><span>已接入</span><strong>${counts.total}</strong><small>数据/交易能力条目</small></div>
            <div class="metric"><span>可用</span><strong class="positive">${counts.available}</strong><small>当前权限下可直接使用</small></div>
            <div class="metric"><span>受限/部分</span><strong class="negative">${counts.limited}</strong><small>延迟、权限或仅分析</small></div>
            <div class="metric"><span>数据延迟</span><strong>~15m</strong><small>延迟 SIP 综合行情</small></div>
          </div>
        <//>

        <${Card} className="card-pad">
          <div class="card-title">权限说明</div>
          <div class="stack-sm" style="margin-top:10px">
            <div class="modal-note">实时 SIP 需要更高数据订阅；当前使用延迟 SIP，所有“实时”更新约滞后 15 分钟。</div>
            <div class="modal-note">当日到期期权可能没有 Greeks/IV；深实值/深虚值合约也可能缺失。</div>
            <div class="modal-note">Alpaca 不提供市值、PE、财报、公司简介；本终端不虚构基本面数据。</div>
            <div class="modal-note">外汇接口当前 403；界面保留状态说明，不展示假数据。</div>
          </div>
        <//>

        <${Card} className="card-pad">
          <div class="card-title">系统与环境</div>
          <div class="key-stats" style="margin-top:10px">
            <div><span>交易模式</span><strong>Paper</strong></div>
            <div><span>服务版本</span><strong>${healthQuery.data?.version || "—"}</strong></div>
            <div><span>行情源</span><strong>Delayed SIP</strong></div>
            <div><span>价格调整</span><strong>拆股/分红复权</strong></div>
            <div><span>运行方式</span><strong>单 Uvicorn worker</strong></div>
            <div><span>API 文档</span><strong><a href="/api/docs" target="_blank" rel="noreferrer">打开</a></strong></div>
          </div>
          <div class="divider" />
          <div class="text-xs text-muted" style="line-height:1.6">行情、新闻、期权与公司行动可能因账户权限或时间而缺失；界面会显式提示，而不是用假数据填充。</div>
        <//>

        <${Card} className="card-pad">
          <div class="card-title">学习提示</div>
          <p class="text-sm text-muted" style="line-height:1.7;margin-top:8px">这些能力用于理解市场数据如何组织、订单如何流转，不构成投资建议。延迟行情适合学习盘面结构，不适合做秒级交易决策。</p>
          <button class="btn btn-sm btn-block" style="margin-top:10px" onClick=${() => navigate("/account")}>返回账户 <${Icon} name="chevronRight" size=${12} /></button>
        <//>
      </div>
    </div>
  </div>`;
}
