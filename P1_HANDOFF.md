# MiniTrade P1 实施交接文档

> 面向低成本执行模型。目标不是“自由发挥”，而是按 ticket 做**最小改动**，每完成一个 ticket 都能独立验收、回滚。
>
> 一次只做一个 ticket。不要一口气把多个 ticket 混在一起改。

---

## 0. 先读什么

按顺序读：

1. `HANDOFF.md`：项目架构、当前实现、已知限制。
2. `README.md`：功能清单、API 使用情况、运行方式。
3. 本文件：P1 任务拆分、约束、验收。

不要先读全部源码。按 ticket 需要再打开对应文件。

---

## 1. 项目快照

- 工作目录：`D:\minitrade`
- 后端：Python 3.15 + FastAPI + Uvicorn + requests/websockets
- 前端：Preact 10 + HTM + ECharts 5.6，本地 vendor，**无构建步骤**
- 数据/交易：Alpaca **Paper Trading only**
- 服务：`http://127.0.0.1:8000`
- 当前服务 PID（2026-11-04 交接时）：`14188`
- 必须 **单 Uvicorn worker**：`app/streams.py` 的 hub 是进程内单例
- 没有 git commit；所有文件基本是未跟踪状态，不要依赖历史 diff

当前账户权限（实测）：

| 能力 | 状态 |
|---|---|
| 股票 paper 交易 | 可用 |
| 期权 Level 3 | 可用 |
| 期权单腿 / `mleg` 多腿 | 可用 |
| 加密交易 | 可用 |
| 延迟 SIP | 可用 |
| 实时 SIP | 403 |
| IEX 实时 | 200，可作备选 |
| 外汇 | 403 |
| OTC | 403 |
| 股票拍卖 | 需要 SIP，当前不可用 |
| 公司 Logo | 403，已用公开 CDN 回退 |
| 期权合约元数据 `/v2/options/contracts` | 200，可用 |

---

## 2. 绝对约束

违反任意一条都算失败：

1. **不要接实盘**。所有交易固定 `paper-api.alpaca.markets`，不要加 live 开关。
2. **不要把 API key 发到前端、日志、截图、文档**。
3. **不要用假数据填充** 403/404 的 Alpaca 能力（外汇、实时 SIP、OTC、拍卖等）。
4. **不要为了测试下市价单**。测试订单用远离市场的限价单，提交后立刻撤单。
5. **不要留下测试订单/持仓**。每个测试结束必须确认没有 open order / 新 position。
6. **不要大规模重构**。一个 ticket 只改必要文件，不重命名全局变量，不换框架。
7. **不要用 PowerShell 的 `Get-Content`/`Set-Content` 批量改 JS/CSS**。项目是 UTF-8，之前这样做造成过中文乱码。用编辑器/`edit` 工具逐处改。
8. **不要改主题/布局/路由行为**，除非 ticket 明确要求。
9. **不要新增顶层导航项**。移动端已经有 7 个 nav，再加会挤爆；新功能优先放在个股 Tab、卡片或二级入口。
10. **不要改 `.env`**，不要打印 `.env`。

---

## 3. 代码地图

```text
app/
  main.py          FastAPI 入口、静态文件、logo 代理、异常处理
  config.py        .env、常量、symbol 校验、feed
  cache.py         线程安全 TTL 缓存
  alpaca_api.py    Alpaca REST 客户端、字段归一化
  analysis.py      技术指标/风险指标
  market.py        股票行情、K 线、新闻、公司行动、Screener、日历
  options.py       期权链、Greeks/IV、期权订单、期权持仓
  crypto.py        加密行情、K 线、订单、持仓
  trading.py       账户、组合历史、持仓、股票订单、活动、自选
  streams.py       股票行情 hub + 订单更新 hub + WS 路由

static/
  index.html
  css/styles.css
  js/app.js        路由 shell、侧栏、顶栏、tape、错误边界
  js/router.js     hash 路由
  js/theme.js      浅色/深色
  js/store.js      全局状态、账户/持仓/订单刷新
  js/charts.js     ECharts 图 + 主题色
  js/options-strategy.js  期权策略台、收益图、期权持仓
  js/components/   search / trade-ticket / watch-star
  js/pages/        market / crypto / stock / watchlist / portfolio / orders / account / data
```

### 后端约定

- `data_get(path, params, timeout=20)` 访问 `https://data.alpaca.markets`
- `trading_get(path, params)` / `trading_send(method, path, payload)` 访问 `https://paper-api.alpaca.markets`
- 失败抛 `UpstreamError(status, message, code)`；路由用 `HTTPException` 转换
- 缓存统一用：`cache.get_or_set(key, ttl, loader, stale_ttl=...)`
- 归一化统一用 `normalize_bar` / `normalize_order` / `normalize_position` / `normalize_snapshot`
- 不要自己再造一套字段命名；先看 `app/alpaca_api.py`

### 前端约定

- 用 `html\`...\`` 模板，不是 JSX
- 关闭标签用 `<//>`，不是 `</Component>`
- 异步数据用 `useAsync(loader, deps, { pollMs, enabled })`
- 全局状态用 `useStore()`，刷新用 `refreshTrading()`
- 请求用 `api(path, { method, body })`
- UI 基础组件从 `../ui.js`：`PageHead`、`Card`、`Badge`、`Empty`、`ErrorBanner`、`LoadingRow`、`Modal`
- 颜色只用 CSS 变量（`var(--surface)` 等），不要硬编码浅色/深色
- 新增 ECharts 图必须使用 `charts.js` 的 `chartColors(theme)`，并把 `theme` 放进依赖
- 新路由：`router.js` 的 known/parse + `app.js` 的 Page/TITLES

---

## 4. 通用执行流程

每个 ticket 按这个顺序：

1. 读 ticket 涉及的文件，确认现状。
2. 先写后端接口并用 `Invoke-WebRequest` 验证返回 200/正确字段。
3. 再接前端；先用 `--dump-dom` 确认无“页面渲染出错”。
4. 跑语法检查。
5. 重启服务。
6. 浏览器截图检查桌面 1600px + 移动 390px。
7. 写 3–5 行交接说明：改了什么、验证了什么、还有什么限制。
8. 如果失败，停止，不要继续叠加改动。

### 基础检查命令

```powershell
cd D:\minitrade

# Python 导入
.\.venv\Scripts\python.exe -c "import app.main; print('py ok')"

# JS 语法
Get-ChildItem -Recurse static\js -Filter *.js | ForEach-Object {
  $out = & node --check $_.FullName 2>&1
  if ($LASTEXITCODE -ne 0) { "FAIL $($_.FullName)"; $out }
}

# 健康检查
Invoke-WebRequest http://127.0.0.1:8000/api/health -UseBasicParsing
```

### 重启服务

```powershell
$pid = (Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess
Stop-Process -Id $pid -Force
Start-Sleep -Seconds 1

$out = Join-Path $env:TEMP 'minitrade-server.out.log'
$err = Join-Path $env:TEMP 'minitrade-server.err.log'
$proc = Start-Process -FilePath 'D:\minitrade\.venv\Scripts\python.exe' `
  -ArgumentList '-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000' `
  -WorkingDirectory 'D:\minitrade' -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err
"started PID=$($proc.Id)"
```

### 页面检查

```powershell
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$profile = Join-Path $env:TEMP 'mt-handoff-check'
& $chrome --headless=new --disable-gpu --no-first-run --no-default-browser-check `
  --user-data-dir="$profile" --virtual-time-budget=9000 `
  --window-size=1600,1200 --screenshot='D:\minitrade\check.png' `
  'http://127.0.0.1:8000/#/stock/AAPL/options'
```

检查完删除 `check.png`。

本机也可以用 Playwright 做前端验证（能同时抓控制台错误，比纯截图可靠）：

```js
const { chromium } = require('D:/nodejs/node_modules/playwright');
// page.on('console' / 'pageerror') 收集报错
// page.screenshot({ path }) 截图；page.locator(...).count() 断言元素
```

Chromium 已装在 `%LOCALAPPDATA%\ms-playwright`。至少检查：桌面 1600×1200、移动 390×844 各一张，且 `document.documentElement.scrollWidth - clientWidth === 0`（无横向溢出）。

---

## 5. P1 Ticket 列表

按推荐顺序执行。每个 ticket 修改文件尽量不超过 3–5 个。

| Ticket | 内容 | 难度 | 建议 | 状态 |
|---|---|---|---|---|
| T1-1 | 期权合约元数据 + 完整链 | 中 | 先做 | ✅ 已完成 2026-11-04 |
| T1-2 | 期权历史 + IV Term Structure | 中 | 先做 | ✅ 已完成 2026-11-04 |
| T1-3 | 股票历史逐笔 / 历史报价 | 低–中 | 可并行 | ✅ 已完成 2026-11-04 |
| T1-4 | 条件码 / 交易所元数据 | 低 | 可选 | ✅ 已完成 2026-11-04 |
| T2-1 | 加密 WebSocket 实时流 | 高 | 不建议最便宜模型 | 待做 |
| T3-1 | OCO/OTO + client_order_id | 中 | 下一批优先 | ✅ 已完成 2026-11-04 |
| T3-2 | 账户配置 PATCH | 中低 | 下一批优先 | ✅ 已完成 2026-11-04 |
| T3-3 | Activities 筛选 + 已实现盈亏 | 中 | 后做 | ✅ 已完成 2026-11-04 |
| T4-1 | 新闻流 / 提醒 | 中高 | 最后做 | 待做 |

### 5.1 已完成记录（2026-11-04）

T1-1 ~ T1-4 已实现并验收，后续接手不要重做，只需在现有实现上扩展。

**T1-1 期权合约元数据 + 完整链**

- 文件：`app/options.py`、`static/js/pages/stock.js`
- `GET /api/stocks/{symbol}/options/contracts?expiration=&type=&strike_gte=&strike_lte=&limit=`
  - 调 `trading_get("/v2/options/contracts")`，`status=active`，最多翻 2 页，缓存 300s
  - 归一化字段：`id / symbol / name / status / tradable / expiration_date / strike_price / type / style / multiplier / size / open_interest / open_interest_date / close_price / close_price_date`
- `chain()` 新增 `full: bool = False`：`full=true` 时用 contracts 取该到期日全部 active 合约，再用 snapshots 补 bid/ask/Greeks；默认 `width=12` 行为不变，`_parse_occ` 仍是 fallback
- 前端期权链顶部新增 `ATM ±12` / `完整链` 分段切换，只改请求参数，表格仍用 `.option-scroll`
- 实测：AAPL 2026-11-20 → contracts 188 个；`chain?width=12` strikes=38，`chain?width=12&full=true` strikes=94
- 注意：`close_price` 只作元数据展示，不能当实时价；没有 snapshot 的深实值/深虚值合约会以空 bid/ask 列出
- `open_interest` 只从 contracts 来，所以 `chain?full=true` 的行带 OI、表格才出现「持仓量」列；默认 ATM 视图不额外请求 contracts，也就没有这一列（不要为此把 contracts 加进默认链请求）

**T1-2 期权历史 + IV Term Structure**

- 文件：`app/options.py`、`static/js/charts.js`、`static/js/pages/stock.js`
- `GET /api/stocks/{symbol}/options/history?contracts=OCC1,OCC2&range=1M|3M|6M|1Y`
  - `/v1beta1/options/bars`，`timeframe=1Day`，`limit=1000`，最多 4 个合约，缓存 300s
  - 前端已接「ATM 合约日线」小图：自动取离 ATM 最近的 call/put，1M / 3M / 6M 切换
- `GET /api/stocks/{symbol}/options/iv-term?expirations=YYYY-MM-DD,...`
  - 最多 6 个到期日，复用 `chain(symbol, expiry, 8)`，取 ATM call/put IV 均值，缓存 600s
  - 某一侧缺 IV 时用另一侧；两侧都没有则跳过该点（0DTE 常见），不填 0
- 前端：`charts.js` 新增 `OptionTermChart({ points })`（`useTheme()` + `chartColors(theme)` + `theme` 进依赖），期权页新增 `IV Term Structure` 卡片，无数据走 `Empty`
- 实测：AAPL 最近 3 个到期日返回 2 个点（0DTE 跳过）；AAPL → MSFT 切换重新请求且不残留

**T1-3 股票历史逐笔 / 历史报价**

- 文件：`app/market.py`、`static/js/pages/stock.js`
- `GET /api/stocks/{symbol}/trades?limit=100`：`/v2/stocks/trades`，强制 `feed=iex`、`sort=desc`，limit ≤ 1000，缓存 30s
- `GET /api/stocks/{symbol}/quotes?limit=100`：**带 limit 返回历史报价**，不带 limit 仍返回原来的最新报价（同一路由，向后兼容）
- 归一化：trade = `time/price/size/exchange/conditions/id`；quote = `time/bid/ask/bid_size/ask_size/exchange`（另有 `ask_exchange`、`tape`）
- 前端：个股「订单」Tab 底部新增 `最近逐笔 / 报价`（IEX 徽标 + “非 consolidated SIP”说明），两个表切换，`.table-wrap` 横向滚动
- 限制：只有 IEX 数据，不是全市场 consolidated SIP；不要把它接进现有实时 trade 流

**T1-4 条件码 / 交易所元数据**

- 文件：`app/market.py`、`static/js/pages/data.js`
- `GET /api/market/meta/conditions?ticktype=trade|quote&tape=A|B|C`
- `GET /api/market/meta/exchanges`
- **与 ticket 原文的偏差**：Alpaca 上游没有 `/v2/stocks/meta/conditions`（404），实际是 `/v2/stocks/meta/conditions/{ticktype}` 且强制 `tape` 参数，所以本地接口多暴露了 `ticktype` + `tape`（默认 `trade` + `C`）
- 页面：数据与 API 页新增卡片（Tape A/B/C 切换、逐笔/报价条件码、交易所代码），未新增 nav
- 实测：trade/tape=C 33 条，quote/tape=A 13 条，exchanges 24 条（V=IEX）

### 5.2 已完成记录（2026-11-04，批次 A/B）

**T3-2 账户配置 PATCH**

- 文件：`app/trading.py`、`static/js/pages/account.js`
- `PATCH /api/account/config`：白名单 6 个字段（`no_shorting` / `fractional_trading` / `max_margin_multiplier` / `suspend_trade` / `disable_overnight_trading` / `ptp_no_exception_entry`）；空 body 返回 422；`max_margin_multiplier` 限 1–4 并转成字符串发给上游
- GET `/api/account/config` 与 PATCH 复用同一个 `_config_payload()`，返回结构与原来完全一致
- 前端账户页新增「账户配置」卡片：一次只改一个字段，confirm 后 PATCH → 重新 GET → `refreshTrading`；「暂停交易」的开启按钮用 danger 样式
- 验收：`no_shorting` true → GET 确认 → 恢复原值；`{}` 与 `max_margin_multiplier=9` 均 422

**T3-1 OCO/OTO + client_order_id**

- 文件：`app/trading.py`、`static/js/components/trade-ticket.js`
- `OrderInput.client_order_id`（1–48 字符）透传到 `POST /v2/orders`
- `GET /api/orders/by-client-id/{client_order_id}`：上游 404 原样映射 404，不再变成 502
- 校验：OCO 必须同时有止盈 + 止损；OTO 至少一个出口；OCO/OTO 主单只允许 `market` / `limit`；bracket 仍然只允许买入
- 前端高级选项：订单类别 select（simple / bracket / oco / oto）+ 止盈止损 + client id 生成按钮；切到卖出时 bracket 自动回落成 simple
- 验收：4 组非法组合全部 422；真实 OTO（AAPL 限价 1.00 + 止盈 1000）创建 → 按 client id 查回 → 撤单 → `open=0`、`positions=0`

**T3-3 Activities 筛选 + 已实现盈亏**

- 文件：`app/trading.py`、`static/js/pages/orders.js`、`static/js/pages/account.js`
- `/api/activities` 新增 `after` / `until` / `page_token`，仍返回数组（保持现有前端兼容）
- `GET /api/account/realized-pnl?days=&after=&until=`：按月切窗拉 `FILL,DIV,INT`，平均成本法推导；卖单没有已知成本时 `realized_pl: null` 并给 `reason`，不猜成本；缓存 120s
- 前端：「成交明细」加 成交/分红/利息/全部 与日期范围；账户页新增「已实现盈亏」卡片（总盈亏、分红、利息、按代码明细），支持 30 天 / 90 天 / 1 年 / 2 年 切换
- 单测：7 组合成 FILL 用例（含卖出无成本、卖空翻转）全部通过；纸面账户目前无活动记录，接口返回空数组 + 0，不报错

---

### T1-1 期权合约元数据 + 更完整的期权链

**优先级**：P1 最高
**难度**：中
**依赖**：无
**目标**：不再只靠 snapshot 解析 OCC；用 Alpaca 合约接口拿到 active/tradable/乘数/合约状态，并支持更宽的行权价范围。

**后端**

文件：`app/options.py`

新增：

```text
GET /api/stocks/{symbol}/options/contracts
  ?expiration=YYYY-MM-DD
  &type=call|put
  &strike_gte=
  &strike_lte=
  &limit=1000
```

- 调 `trading_get("/v2/options/contracts", params)`
- 参数：
  - `underlying_symbols=<symbol>`
  - `expiration_date=<expiration>`
  - `type=<call/put>`（可选）
  - `strike_price_gte` / `strike_price_lte`（可选）
  - `status=active`
  - `limit`
  - `page_token`
- 返回归一化字段：
  - `id`, `symbol`, `name`, `status`, `tradable`
  - `expiration_date`, `strike_price`, `type`, `style`
  - `multiplier`, `size`, `open_interest_date`, `close_price`, `close_price_date`
- 最多翻 2 页；缓存 5 分钟。

修改 `chain()`：
- 保留现有 `width` 行为，不破坏前端。
- 新增可选 `full: bool = False`；`full=true` 时从 contracts 接口取该到期日全部 active 行权价，再用 snapshots 补 bid/ask/Greeks。
- 默认 `width` 仍是 12，避免一次拉太多。

**前端**

文件：`static/js/pages/stock.js`

- 期权链顶部加一个轻量 toggle：
  - `ATM ±12`
  - `完整链`
- 只切换请求参数，不改现有布局。
- 行数很多时保持 `.option-scroll` 的 `max-height`，不要撑爆页面。

**验收**

```powershell
Invoke-WebRequest 'http://127.0.0.1:8000/api/stocks/AAPL/options/contracts?expiration=2026-11-20&limit=5' -UseBasicParsing
```

- 返回 200，至少有 1 个合约
- `tradable` 字段存在
- `chain?full=true` 返回的 strikes 数量大于默认 `width=12`
- 页面切换不报错，表格仍可滚动
- 深色/浅色都正常

**不要做**

- 不要删除现有 `_parse_occ` fallback
- 不要一次拉全市场所有期权
- 不要把 contracts 接口返回的 `close_price` 当实时价

---

### T1-2 期权历史数据 + IV Term Structure

**优先级**：P1
**难度**：中
**依赖**：T1-1（建议）

**后端**

文件：`app/options.py`

新增：

```text
GET /api/stocks/{symbol}/options/history
  ?contracts=OCC1,OCC2
  &range=1M|3M|6M|1Y
```

- 用 `/v1beta1/options/bars`，`timeframe=1Day`，`limit=1000`
- 返回每个 contract 的 `bars`（用 `normalize_bar`）
- 最多 4 个 contract，避免 URL 过长
- 缓存 5 分钟

新增：

```text
GET /api/stocks/{symbol}/options/iv-term?expirations=YYYY-MM-DD,...
```

- 最多 6 个到期日
- 对每个到期日复用 `chain(symbol, expiration, 8)`
- 取 ATM call/put 的 IV 平均值
- 返回：

```json
{
  "symbol": "AAPL",
  "points": [
    {"expiration": "2026-11-20", "dte": 14, "atm_iv": 0.31}
  ]
}
```

- 缓存 10 分钟

**前端**

文件：`static/js/charts.js`、`static/js/pages/stock.js`

- `charts.js` 新增 `OptionTermChart({ points })`
  - 用 `useTheme()` + `chartColors(theme)`
  - 横轴 expiration，纵轴 IV%
  - 把 `theme` 放进 `useEChart` 依赖
- 期权页加一张卡：
  - 标题：`IV Term Structure`
  - 说明：不同到期日的 ATM IV
  - 无数据时显示 `Empty`，不要报错

**验收**

- `history` 对 2 个 AAPL 合约返回 200，bars 非空
- `iv-term` 对 3 个到期日返回 2–3 个 points
- IV 图在浅色/深色都可见
- 切换股票/到期日不残留旧数据

**不要做**

- 不要用股票 bars 伪造期权 bars
- 不要在 0DTE 没有 IV 时填 0；跳过该点

---

### T1-3 股票历史逐笔成交 / 历史报价

**优先级**：P1
**难度**：低–中
**依赖**：无

**后端**

文件：`app/market.py`

新增：

```text
GET /api/stocks/{symbol}/trades?limit=100
GET /api/stocks/{symbol}/quotes?limit=100
```

- 用 `data_get("/v2/stocks/trades", {...})`
- 必须传 `feed=iex`（当前订阅 SIP 403）
- `limit` 最大 1000
- 归一化：
  - trade: `time`, `price`, `size`, `exchange`, `conditions`, `id`
  - quote: `time`, `bid`, `ask`, `bid_size`, `ask_size`, `exchange`
- 缓存 30 秒

**前端**

文件：`static/js/pages/stock.js`

- 在「分析」Tab 或「订单」Tab 下加一个折叠表：
  - `最近逐笔`
  - `最近报价`
- 不要新增顶层 Tab；期权页已经很长
- 表格使用 `.table`，横向滚动
- 显示 `IEX` 标识和“非 consolidated SIP”说明

**验收**

- AAPL trades 返回 200，至少 1 条
- quotes 返回 bid/ask 非空
- 页面无控制台错误
- 不要请求 `feed=sip` 作为默认值

**不要做**

- 不要实现股票拍卖；当前需要 SIP，会失败
- 不要把逐笔数据接到现有实时 trade 流里

---

### T1-4 条件码 / 交易所元数据（可选，低优先）

**优先级**：P2
**难度**：低

- 新增 `GET /api/market/meta/conditions`、`/api/market/meta/exchanges`
- 调 `/v2/stocks/meta/conditions`、`/v2/stocks/meta/exchanges`
- 页面放在「数据与 API」页，不要新增 nav
- 验收：200 + 列表非空

---

### T2-1 加密 WebSocket 实时流

**优先级**：P1
**难度**：高（不建议最便宜的模型独立做）
**依赖**：先读 `app/streams.py` 的 `MarketHub` / `_MarketUpstream`

**目标**：加密页从 15 秒轮询升级为实时 tick，但保留轮询作为 fallback。

**后端**

新建：`app/crypto_stream.py`（或扩展 `streams.py`）

- 上游：`wss://stream.data.alpaca.markets/v1beta3/crypto/us`
- 认证：`{"action":"auth","key":...,"secret":...}`
- 订阅：
  ```json
  {"action":"subscribe","trades":["BTC/USD"],"quotes":["BTC/USD"],"bars":["BTC/USD"]}
  ```
- 一个进程只建一条上游连接
- 浏览器 WS：`/ws/crypto`
- 消息格式：
  ```json
  {"type":"crypto","symbol":"BTC/USD","price":...,"bid":...,"ask":...,"ts":"..."}
  ```
- 断开重连，指数退避（1s/2s/4s，最大 30s）
- 不要阻塞 FastAPI 事件循环；用后台线程 + `asyncio.run_coroutine_threadsafe`
- 与 `MarketHub` 一样做订阅计数，避免多浏览器重复订阅

**前端**

- `static/js/stream.js` 加 `useCryptoLive(symbols)` 或复用现有 WS 单例
- `static/js/pages/crypto.js`：
  - 用 tick 更新当前价、买价/卖价
  - K 线最后一根跟随更新，保留缩放
  - WS 断开时保留 15 秒轮询 fallback

**验收**

- 两个标签页同时打开，上游只建一条连接
- 断网/重启上游后能重连
- 页面不重复创建 WebSocket
- 关闭页面后订阅释放
- 服务端日志无异常堆栈

**不要做**

- 不要把加密流塞进股票 `/ws/market`
- 不要为每个浏览器单独建上游连接
- 不要在 WS 回调里同步写文件/数据库

---

### T3-1 订单补齐：OCO/OTO + client_order_id

**优先级**：P1
**难度**：中
**依赖**：先读 `app/trading.py` 的 `OrderInput` / `_validate_order` / `create_order`

**后端**

文件：`app/trading.py`

- `OrderInput` 增加：
  - `client_order_id: str | None`（1–48 字符）
- 创建订单时传入 `client_order_id`
- 新增：
  ```text
  GET /api/orders/by-client-id/{client_order_id}
  ```
  - 调 `GET /v2/orders:by_client_order_id?client_order_id=...`
- 校验：
  - `oco` 必须有 `take_profit` + `stop_loss`
  - `oto` 必须至少有一个 exit leg；不确定时**拒绝**而不是猜
  - `bracket` 仍只允许买入
  - `mleg` 不走这个入口（期权有单独接口）

**前端**

- 改单弹窗或下单弹窗增加 `order_class`：`simple / bracket / oco / oto`
- 选 `oco/oto` 时显示 TP/SL 字段
- 加一个可选 `client_order_id` 输入（默认自动生成也可以）
- 不要为期权/加密显示这个入口

**验收**

- 用远离市场的限价单 + `client_order_id` 创建，能按 client id 查回
- 测试后撤单
- `oco` 缺 TP/SL 返回 422
- `bracket` 卖出仍被拒绝

**不要做**

- 不要猜 OTO 的字段结构；必须查 Alpaca 文档
- 不要改期权 `mleg` 的现有逻辑

---

### T3-2 账户配置 PATCH

**优先级**：P1
**难度**：中低

**后端**

文件：`app/trading.py`

新增：

```text
PATCH /api/account/config
```

允许字段（白名单）：

- `no_shorting`
- `fractional_trading`
- `max_margin_multiplier`
- `suspend_trade`
- `disable_overnight_trading`
- `ptp_no_exception_entry`

- 调 `PATCH /v2/account/configurations`
- 只发白名单字段
- 返回更新后的配置

**前端**

文件：`static/js/pages/account.js`

- 账户页增加一张 `账户配置` 卡片
- 每个开关/输入只改一个字段
- 保存前 `confirm`
- 显示当前值，保存后重新 GET

**验收**

- 先 GET 保存原值
- PATCH 一个安全字段（例如 `no_shorting`）
- GET 确认变化
- 测试结束后恢复原值
- 不要改 `suspend_trade` 为 true 后忘记恢复

---

### T3-3 Activities 交易类型筛选 + 已实现盈亏

**优先级**：P2
**难度**：中

**后端**

文件：`app/trading.py`

- `activities` 增加 `after` / `until` / `page_token` 参数
- 保持现有 `types` 兼容
- 新增一个纯派生接口：

```text
GET /api/account/realized-pnl
```

- 从 `FILL`、`DIV`、`INT` 等活动推导
- 不要伪造数据；字段不足时返回 `null` 并说明
- 先做“按 symbol 汇总已实现 P&L”，不要做税务批次

**前端**

- 订单页成交明细加类型/日期筛选
- 账户页或组合页显示已实现盈亏卡片
- 没有数据时显示 `—`

**验收**

- 无成交时返回空数组/0，不报错
- 有成交时按 symbol 汇总
- 页面切筛选不跳回顶部（项目已修复滚动重置，不要重新加 `scrollTo(0)`）

---

### T4-1 新闻实时流 / 提醒（P2，最后做）

**优先级**：P2
**难度**：中高
**建议**：等 T1/T3 稳定后再做

- 新闻流：`wss://stream.data.alpaca.markets/v1beta1/news`
- 订阅 `{"action":"subscribe","news":["*"]}`
- 前端在自选/个股页显示“新新闻”提示，不要自动刷屏
- 价格提醒：前端本地规则 + `localStorage`，不要依赖 Alpaca 没有的 alert API
- 验收：刷新后规则保留；浏览器通知/Toast 可关闭

---

## 6. 可选：P0 尾巴（只建议强一点的模型）

以下不是 P1 必需项。不要和 T1 混做。

### T0-1 备兑看涨 / 保护性看跌

- 在 `static/js/options-strategy.js` 的 `STRATEGIES` 增加：
  - `covered_call`: 卖出 Call + 需要 100 股/合约的正股
  - `protective_put`: 买入 Put + 需要 100 股/合约的正股
- 校验 `store.positions` 中正股数量
- 收益图要把正股腿算进去
- 不要在没有正股时允许提交

### T0-2 铁鹰 / 信用价差

- 需要处理**净收入**的负号、保证金、max loss
- Alpaca `mleg` 的 `limit_price` 对 credit 的符号必须先看文档/实测
- 没有把握就**不要做**；错误方向会把 debit 做成 credit

---

## 7. 每个 ticket 的交付格式

完成后在回复/提交说明里写：

```text
Ticket:
修改文件:
新增接口:
验证命令/结果:
截图/页面:
已知限制:
```

不要写“已完成”但没有验证命令。

---

## 8. 常见坑

1. **编码**：不要用 PowerShell 批量改 JS/CSS，中文会乱码。用 `edit` 工具。
2. **Preact 模板**：闭合用 `<//>`；不要写 `</${Card}>`。
3. **ECharts 主题**：新图不加 `theme` 依赖，切换深浅色不会更新。
4. **路由滚动**：`useHashRoute` 只在 page/symbol 变化时回顶；不要恢复成每次 hashchange 都 `scrollTo(0)`，否则 Tab 切换会跳顶。
5. **Tape**：item 固定 38px、字体 11px、`align-items:center`；不要改回 baseline + 多档字号。
6. **期权多腿**：`order_class=mleg`，`limit_price` 是组合净价，`qty` 是策略组数，leg 里用 `ratio_qty`。
7. **期权单腿**：普通 `/v2/orders`，`qty` 是合约数。
8. **加密最低金额**：单笔约 **>$10**；前后端都要校验。测试用远离市场的限价单，提交后撤单。
9. **SIP 403**：股票历史逐笔/报价默认 `feed=iex`；不要默认 `sip`。
10. **拍卖/外汇/OTC**：当前权限不可用；不要用假数据。
11. **订单测试**：不要用市价单；不要留下 open order / position。
12. **服务**：必须单 worker；多 worker 会重复建上游 WS。
13. **缓存**：外部数据用 `cache.get_or_set`；不要每次请求都打 Alpaca。
14. **移动端**：新 UI 必须在 390px 宽下检查；表格用 `.table-wrap` / 横向滚动。

---

## 9. 推荐执行顺序

T1-1 ~ T1-4、T3-1 ~ T3-3 已完成，剩余只有两条，都需要更强的模型或先只做后端：

1. **T2-1 加密 WebSocket 实时流**：先读 `app/streams.py` 的 `MarketHub` / `_MarketUpstream`，新建 `app/crypto_stream.py`；一条上游连接 + 订阅计数 + 指数退避重连（1/2/4→30s），前端保留 15 秒轮询兜底；`/ws/crypto` 只推数据，不要顺手改订单逻辑。
2. **T4-1 新闻流 / 提醒**：最后做。价格提醒用前端 localStorage，不依赖 Alpaca 不存在的 alert API；新闻流先做后端聚合 + 15 分钟缓存。

**可选的小尾巴**

2026-11-04 已全部完成：ATM 合约日线图（1M/3M/6M）、完整链自动滚到 ATM、`open_interest` 归一化 + 完整链「持仓量」列、已实现盈亏 30 天 / 90 天 / 1 年 / 2 年切换。暂时没有剩余尾巴，下一步直接做 T2-1。

---

## 10. 当前已验证的 P0 基线（不要重做）

- 期权单腿/多腿纸面订单：提交 → 撤单成功
- 期权策略台：6 个策略、收益图、最大盈亏、盈亏平衡
- 期权持仓 / 平仓 / 行权 / DNE 接口
- 加密页 + 10 个交易对 + K 线 + 纸面下单 + 持仓/订单
- 股票/期权/加密统一订单页与组合页
- 浅色/深色主题、Logo 回退、Tape 统一、Tab 滚动保持

### P1 已验证（2026-11-04）

- 期权合约元数据接口 200（含 `tradable` / `multiplier` / `close_price_date`）
- 期权链 `full=true` 返回该到期日全部 active 行权价（AAPL 2026-11-20：94 > 默认 38），表格可滚动
- 期权日线历史 200（2 个合约，bars 非空）；ATM IV 期限结构返回 2–3 个点，0DTE 自动跳过
- IEX 历史逐笔 / 历史报价 200；`/api/stocks/{symbol}/quotes` 不带 limit 仍是原最新报价
- 条件码（trade 33 / quote 14）与交易所元数据（24）200
- 账户配置 PATCH：`no_shorting` 修改后 GET 立刻反映，已恢复原值；空 body / 越界杠杆均 422
- OCO/OTO 校验：缺止损、OTO 无出口、OTO 用止损主单、bracket 卖出全部 422
- client_order_id：OTO 订单按 client id 查回（200），撤单后 `open=0`、`positions=0`，不存在的 id 返回 404
- Activities 筛选（类型 + 日期）200；`realized-pnl` 无活动时返回空数组 + 0，坏日期区间 422
- Playwright：桌面 1600px 与移动 390px 无横向溢出，控制台 0 报错

这些已经存在。新 ticket 不要重写它们。
