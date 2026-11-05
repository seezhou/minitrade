# MiniTrade 项目交接

> P1 实施拆分与低成本模型执行说明见 [P1_HANDOFF.md](P1_HANDOFF.md)。

## 当前状态

MiniTrade 已从单一演示页升级为 **Alpaca 纸面交易终端**，桌面与移动布局均已跑通。核心页面：

- 市场总览（指数、成交量榜、涨跌榜、新闻、加密、日历、账户）
- 个股详情（K 线、指标、分析、新闻、公司行动、期权链、期权策略台、订单、快速交易）
- 加密（10 个交易对、K 线、纸面下单、持仓、订单）
- 自选（Alpaca 服务端多列表）
- 投资组合（权益曲线、配置环图、持仓、活动）
- 订单（高级订单、改单、撤单、成交明细、订单更新流）
- 账户（购买力结构、配置、交易日历）
- 数据与 API（独立的能力矩阵、权限状态、系统信息）

后端仍然只使用 **Alpaca Paper Trading**，没有实盘切换。行情为延迟 SIP（约 15 分钟）。

## 技术栈

- 后端：Python 3.10+、FastAPI、requests、websockets、python-dotenv
- 前端：Preact 10 + HTM + ECharts 5，本地 vendor，无构建步骤
- 数据/交易：Alpaca REST + WebSocket
- 缓存：进程内 TTL 缓存
- 实时：每个服务进程一条上游延迟 SIP 流 + 一条订单更新流，浏览器共享

## 文件结构

```text
app/
  main.py          FastAPI 入口；静态文件；logo 代理；安全头；异常处理
  config.py        .env、常量、Symbol 校验、流地址
  cache.py         线程安全 TTL 缓存（支持 stale fallback）
  alpaca_api.py    REST 客户端；资产/快照/搜索；字段归一化
  analysis.py      收益、SMA/RSI/ATR/MACD、波动率、Beta、回撤、信号
  market.py        概览、报价、K 线、IEX 逐笔/历史报价、新闻、公司行动、Screener、加密、日历、参考元数据
  options.py       期权合约元数据、链（含完整链）、日线历史、ATM IV 期限结构、Greeks/IV、期权订单、持仓
  crypto.py        加密行情、K 线、订单、持仓
  trading.py       账户、账户配置、组合历史、持仓、订单（含 OCO/OTO/client id）、已实现盈亏、活动、自选
  streams.py       行情聚合 hub + 订单更新 hub + 两个 WebSocket 路由

static/
  index.html       import map 指向 /static/vendor
  css/styles.css   设计系统 + 页面样式 + 响应式
  js/app.js        路由、Shell、侧栏、顶栏、跑马灯、错误边界
  js/api.js        fetch 封装
  js/store.js      全局状态与账户/自选刷新
  js/hooks.js      useAsync / useNow / useDebounced / localStorage
  js/stream.js     浏览器端行情流单例；useLive；useOrderUpdates
  js/charts.js     ECharts 价格图、权益图、环图、对比图、IV 微笑、IV 期限结构
  js/payoff.js     期权到期收益纯函数（正股腿 + 期权腿，浏览器与 node 测试共用）
  js/indicators.js SMA/EMA/BOLL/RSI/MACD/ATR
  js/ui.js         Card/Logo/Sparkline/Change/Modal/Toast 等
  js/icons.js      内联 SVG 图标
  js/router.js     hash 路由
  js/theme.js      主题切换与 localStorage 持久化
  js/options-strategy.js  期权策略台、收益图、期权持仓
  js/components/   search / trade-ticket / watch-star
  js/pages/        market / crypto / stock / watchlist / portfolio / orders / account / data

tests/
  js/payoff.test.mjs         期权收益曲线与每股正股需求（node --test）
  conftest.py      离线夹具：拦截真实网络、清理 TTL 缓存、假上游、TestClient
  test_orders_validation.py   订单校验规则（纯函数 + 卖出可卖量）
  test_realized_pnl.py        已实现盈亏平均成本推导 + 路由串联
  test_paging.py              加密 / 股票 bars 的 next_page_token 翻页合并
  test_normalize.py           bar / order / position / account / news 字段归一化
  test_routes_smoke.py        路由状态码、参数透传、非法请求不下发上游
```

## 关键实现说明

### 主题

- 默认浅色；`localStorage` 保存 `minitrade-theme`，刷新后保持。
- `index.html` 在 CSS 前内联设置 `data-theme`，避免深色模式白屏闪烁。
- 颜色全部走 CSS 变量；`[data-theme="dark"]` 覆盖背景、卡片、边框、输入框、表格、弹窗和强调色。
- ECharts 不能直接读 CSS 变量，`charts.js` 用 `useTheme()` + `chartColors(theme)` 提供坐标轴、网格、tooltip、蜡烛图和图例颜色；切换主题时图表重建且保留 dataZoom。
- 主题按钮在顶栏右侧；移动端只显示图标。

### 行情

- `data_get` 统一走 `https://data.alpaca.markets`，交易走 `https://paper-api.alpaca.markets`。
- 历史 K 线使用 `feed=sip`；请求 **不传 end**，因为当前订阅对“最近 SIP 数据”会返回 403，省略 end 让 Alpaca 自动截到允许的延迟边界。
- Alpaca bars 返回分页 token；`_paged_bars` 最多取 10 页，解决 30 分钟/小时线只返回第一页的问题。
- 日线以上使用 `adjustment=all`（拆股/分红复权）；分钟线使用 `raw`。
- 1D 从纽约时间当天 04:00 开始，包含盘前/盘后；图表用 markArea 标灰。
- 快照 `dailyBar` 盘中可能仍是上一交易日，因此个股页用 1D 分钟线推导 **今日开盘/最高/最低/成交量/VWAP**（`_today_session_stats`），并在界面标注“截至 … ET”。
- 当前行情流：所有符号只订阅 `trades`；聚焦符号额外订阅 `quotes` 和 `bars`，避免超过 Alpaca 订阅数量限制。
- 服务端按 ~400ms 合并 tick 后批量下发；浏览器端再按订阅过滤合并。
- 个股 K 线：最后一根当前交易日的 K 线会按约 1 秒节流，用实时成交价更新 close/high/low；K 线重绘时保留用户当前的 dataZoom 缩放/平移状态（`PriceChart` 的 `preserveZoomKey`）。
- 历史逐笔 / 历史报价：`/api/stocks/{symbol}/trades` 与 `/api/stocks/{symbol}/quotes?limit=` 走 `/v2/stocks/trades|quotes`，**强制 `feed=iex`、`sort=desc`、缓存 30 秒**。当前订阅没有实时 SIP，IEX 数据不是 consolidated SIP，页面必须保留“非 consolidated SIP”说明。

### 订单

- 原生 REST 提交，支持 `market/limit/stop/stop_limit/trailing_stop`。
- 支持 `qty` 或 `notional`（金额仅市价买入）、TIF、延长时段、订单类别（simple / bracket / oco / oto）、client_order_id、允许做空。
- 校验：碎股仅市价 + DAY + 非延长时段；延长时段仅限价 + DAY + 整数股；bracket 仅买入；OCO 必须同时有止盈 + 止损；OTO 至少一个出口；OCO/OTO 主单只允许市价/限价；client_order_id 1–48 字符；卖出默认不能超过可用持仓（可勾选做空）。
- `GET /api/orders/by-client-id/{id}` 用于按 client id 反查订单，上游 404 会原样返回 404。
- 改单使用 `PATCH /v2/orders/{id}`；Alpaca 会生成新订单 ID，界面刷新后使用新 ID。
- 订单更新流监听 `trade_updates`，收到事件后自动刷新账户/持仓/订单并 toast。

### 期权

- 期权合约元数据 `/v2/options/contracts` 当前账户 **200 可用**，对外是 `GET /api/stocks/{symbol}/options/contracts?expiration=&type=&strike_gte=&strike_lte=&limit=`；`status=active`，最多翻 2 页，缓存 5 分钟。
- 默认期权链仍走 `GET /v1beta1/options/snapshots/{symbol}` + `_parse_occ` 解析 OCC，取 `expiration_date` + 现价 ±20% 行权价范围，按 `width=12` 截到 ATM ±12；前端默认就是这个视图。
- `chain?full=true` 才用 contracts 拿该到期日**全部 active 合约**，再用 snapshots 补 bid/ask/Greeks；没有 snapshot 的深实值/深虚值合约会以空 bid/ask 列出。`close_price` 只作元数据，不能当实时价。
- 到期日页取 2 页、每页 1000 个合约；到期日缓存 15 分钟。
- 期权日线历史 `GET /api/stocks/{symbol}/options/history?contracts=&range=` 走 `/v1beta1/options/bars`（`timeframe=1Day`，最多 4 个合约，1M–1Y）；前端期权页「ATM 合约日线」卡片自动取离 ATM 最近的 call/put，支持 1M / 3M / 6M。
- 完整链的「持仓量」列来自 contracts 的 `open_interest`，只有 `chain?full=true` 才有；默认 ATM 视图不请求 contracts，因此不显示该列。切到 `full` 时表格会自动把 ATM 行滚到中间。
- ATM IV 期限结构 `GET /api/stocks/{symbol}/options/iv-term?expirations=`：最多 6 个到期日，复用 `chain(symbol, expiry, 8)` 取 ATM call/put IV 均值，缓存 10 分钟；某一侧缺 IV 用另一侧，两侧都没有就跳过该点（0DTE 常见，不填 0）。前端是期权页的 `IV Term Structure` 卡片。
- 当日到期合约可能没有 Greeks/IV，前端默认跳过当日到期并提示。
- 策略台支持买入看涨/看跌、牛市看涨价差、熊市看跌价差、买入跨式/宽跨式、备兑看涨、保护性看跌；显示收益图、最大盈亏、盈亏平衡。
- 备兑看涨 / 保护性看跌带**正股腿**：每张合约要求已持有 100 股（数量从 `/api/positions` 的正股持仓读，按 `avg_entry_price` 算成本），不足时禁用提交；正股腿只进收益图，**不进订单**，所以下单仍是单腿 `/v2/orders`（`position_intent=sell_to_open` / `buy_to_open`），不是 mleg。
- 备兑看涨是 credit 票：界面和单腿 `limit_price` 都用绝对权利金，credit 只影响 payoff 的现金流方向（`static/js/payoff.js` 的 `payoffCurve()`）。
- 单腿走标准 `/v2/orders`；多腿走 `order_class=mleg` + `legs[]` + 净限价；前端只对多腿开放限价单。
- 期权持仓从 `/v2/positions` 过滤，平仓走 `/api/stocks/{symbol}/options/positions/{contract}`。

### 加密

- 行情走 `/v1beta3/crypto/us/snapshots`、`/bars`；支持 10 个交易对。
- 订单走标准 `/v2/orders`，`symbol=BTC/USD`，支持 market/limit/stop_limit、GTC/IOC、qty/notional。
- Alpaca 对加密订单有最低金额约束（约 $10）；前后端都做校验。
- 加密页每 15 秒刷新快照、30 秒刷新 K 线；持仓/订单复用账户状态刷新。
- 24/7 页面不套用美股盘前/盘后阴影。

### 自选 / 账户

- 自选完全存储在 Alpaca `/v2/watchlists`。
- 列表接口不返回 assets，因此列表加载后逐条 GET 详情。
- 更新名称/股票使用 `PUT /v2/watchlists/{id}`（当前 API 不支持 PATCH）。
- 组合历史会过滤 equity <= 0 的账户创建前数据点，避免权益曲线从 0 开始。

## API 路由

```text
GET  /api/health
GET  /api/overview
GET  /api/clock
GET  /api/calendar?days=
GET  /api/quotes?symbols=&sparkline=
GET  /api/search?q=
GET  /api/stocks/{symbol}/summary
GET  /api/stocks/{symbol}/snapshot
GET  /api/stocks/{symbol}/bars?range=1D|5D|1M|3M|6M|1Y|5Y
GET  /api/stocks/{symbol}/trades?limit=      IEX 历史逐笔（非 consolidated SIP）
GET  /api/stocks/{symbol}/quotes?limit=     带 limit 返回 IEX 历史报价；不带 limit 返回最新报价
GET  /api/stocks/{symbol}/actions?years=
GET  /api/stocks/{symbol}/options/expirations
GET  /api/stocks/{symbol}/options/contracts?expiration=&type=&strike_gte=&strike_lte=&limit=
GET  /api/stocks/{symbol}/options/chain?expiration=&width=&full=
GET  /api/stocks/{symbol}/options/history?contracts=&range=1M|3M|6M|1Y
GET  /api/stocks/{symbol}/options/iv-term?expirations=
GET  /api/stocks/{symbol}/options/overview
POST /api/stocks/{symbol}/options/orders
GET  /api/stocks/{symbol}/options/positions
DELETE /api/stocks/{symbol}/options/positions/{contract}
GET  /api/crypto/markets
GET  /api/crypto/snapshot?symbol=
GET  /api/crypto/bars?symbol=&range=
POST /api/crypto/orders
GET  /api/crypto/positions
DELETE /api/crypto/positions?symbol=
GET  /api/news?symbols=&limit=&content=
GET  /api/market/movers
GET  /api/market/actives
GET  /api/market/crypto
GET  /api/market/meta/conditions?ticktype=trade|quote&tape=A|B|C
GET  /api/market/meta/exchanges
GET  /api/account
GET  /api/account/config
PATCH /api/account/config               白名单 6 字段：no_shorting / fractional_trading / max_margin_multiplier(1-4) / suspend_trade / disable_overnight_trading / ptp_no_exception_entry
GET  /api/account/realized-pnl?days=&after=&until=
GET  /api/account/history?period=1D|1W|1M|3M|1Y|ALL
GET  /api/positions
DELETE /api/positions/{symbol}
DELETE /api/positions
GET  /api/orders?status=&limit=&symbol=
GET  /api/orders/{id}
GET  /api/orders/by-client-id/{client_order_id}
POST /api/orders
PATCH /api/orders/{id}
DELETE /api/orders/{id}
DELETE /api/orders
GET  /api/activities?types=&limit=&after=&until=&page_token=
GET/POST/PUT/DELETE /api/watchlists...
POST /api/cache/clear
WS   /ws/market
WS   /ws/orders
```

## 环境与权限

- `.env` 需要 `ALPACA_API_KEY`、`ALPACA_SECRET_KEY`。
- 当前纸面账户：ACTIVE，保证金 4x，期权 Level 3，加密 ACTIVE。
- 可用：延迟 SIP 快照/流、SIP 历史 bars、新闻、Screener、公司行动、期权快照/期权订单（Level 3）、加密快照/K 线/订单、自选、组合历史、订单更新流。
- 受限：实时 SIP（403）、外汇（403）、公司 Logo（403，已用公开 CDN 回退）、OTC（403）。期权合约元数据实测 200 可用。
- 必须单 Uvicorn worker；多 worker 会重复建立上游连接。

## 运行与测试

```powershell
cd D:\minitrade
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pip install -r requirements-dev.txt   # 仅测试用：pytest + httpx
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m pytest                                 # 后端离线回归，约 1 秒
node --test "tests/js/*.test.mjs"                 # 前端纯逻辑（收益曲线），零依赖
python test_alpaca_connection.py                 # 手工连通性检查
```

`package.json` 只声明 `"type": "module"` 和一个 `npm run test:js` 脚本，**没有构建步骤、没有 npm 依赖**：它存在的唯一原因是让 node 能直接 import `static/js/*.js`。

`python -m pytest` 不需要 `.env`、不需要启动服务、不联网：

- `tests/conftest.py` 把 `requests.Session.request` 全部拦截，漏 mock 的上游调用会直接失败。
- 每个测试用假上游替换 `data_get` / `trading_get` / `trading_send`，只断言字段形状和业务规则。
- 覆盖：订单校验与可卖量、已实现盈亏推导、bars 翻页合并、字段归一化、路由状态码与参数透传。
- 不覆盖：实时价格、合约数量、真实下单、浏览器渲染（仍靠 Playwright / 截图）。

已做过的检查：

- 全部 REST 路由 200；健康检查、概览、账户、持仓、订单、自选、新闻、公司行动、期权、日历、加密。
- 浏览器控制台无异常；市场、个股、分析、新闻、分红、期权、组合、订单、账户页面渲染。
- 搜索 → 个股 → 买入弹窗 → 限价单提交 → 撤单闭环。
- 期权策略台 → 单腿/多腿 mleg 订单提交 → 撤单。
- 加密页 → 限价单提交 → 撤单；最低金额校验。
- 1D/1Y 图表、MA/BOLL/RSI/MACD、IV 微笑。
- 期权合约元数据 / 完整链（`full=true`，含持仓量列与 ATM 自动居中）/ 期权日线历史 / ATM 合约日线图 / ATM IV 期限结构。
- IEX 历史逐笔与历史报价；条件码与交易所元数据。
- 账户配置 PATCH（改一项 → GET 确认 → 恢复原值）；OCO/OTO 非法组合拒绝；client id 查单与撤单。
- Activities 类型/日期筛选；已实现盈亏卡片（无成交时为空态）。
- 1600px 桌面与 390px 移动端布局。
- 订单流与行情流保持连接；延迟 SIP 行情正常推送。

截图见 `docs/screenshot-*.png`。

## 已知问题 / 后续建议

1. **当日 0DTE 期权没有 Greeks**：Alpaca 对当日到期合约可能不返回 IV/Greeks；已默认跳过并提示。
2. **行情延迟 15 分钟**：所有“实时”文案都需保留延迟说明；若要秒级行情，需要升级 Alpaca 数据订阅。
3. **权益曲线数据稀疏**：新账户只有创建后的点；若权益长期不变，曲线接近水平线，属于正常。
4. **自选列表接口细节**：列表端点不返回 assets；新增/删除后已逐条刷新详情，仍可能有 1–2 秒 Alpaca 最终一致性延迟。
5. **移动端表格**：自选/持仓表格在 <=680px 会隐藏部分列；订单历史仍可横向滚动。若要进一步优化，可改成卡片式列表。
6. **没有基本面数据**：Alpaca 不提供市值/PE/财报；若需要，可接入 Polygon/FMP 等，但会增加外部依赖。
7. **期权/加密交易**：已接入纸面账户；期权多腿仅限价，加密单笔最低约 $10。期权流动性/滑点可能明显，学习用途不构成建议。
8. **缓存无上限**：长时间浏览大量代码后进程内缓存会增长；可加 LRU 上限，目前影响很小。
9. **行情流订阅上限**：代码限制 28 个符号，聚焦符号额外 2 个订阅；若 Alpaca 权限变化需复核。
10. **测试覆盖边界**：`tests/` 已覆盖订单校验、已实现盈亏推导、bars 翻页、字段归一化与路由串联（离线 pytest，秒级）；但仍**没有 CI 流水线**，也没有前端自动化测试，浏览器渲染靠 Playwright 手工跑，真实上游连通性靠 `test_alpaca_connection.py`。
11. **IEX 逐笔/报价不完整**：历史 trades/quotes 只有 IEX 交易所，不是 consolidated SIP；条数和价格可能与综合行情偏离，页面上必须保留说明，不能当全市场成交。
12. **条件码接口的 tape 参数**：Alpaca 的 `/v2/stocks/meta/conditions` 会 404，实际是 `/v2/stocks/meta/conditions/{trade|quote}` 且必须带 `tape=A|B|C`；本地接口已包一层，默认 `trade` + `C`。
13. **完整链行数多**：`chain?full=true` 一次可能返回 80–100 行/侧（AAPL 近月 158 个合约），靠 `.option-scroll` 的 440px 高度滚动（已做 ATM 自动居中）；不要去掉 `max-height`，否则会把页面撑爆。
14. **已实现盈亏是推导值**：Alpaca 的 activities 没有成本基准字段，`/api/account/realized-pnl` 用平均成本法从 FILL 推导，按月切窗（每窗 page_size=100），不含手续费与税费；卖单在窗口内找不到对应买入时返回 `null` + `reason`，不要改成猜测值。逐笔流水仍以 `/api/activities` 为准。
15. **期权页窗口缩小后横向溢出**：在宽屏打开期权页再缩到移动宽度，`main.content` 的 `scrollWidth` 会停在约 979px（`documentElement` 多出约 589px），再触发 `resize` 也不恢复；直接以 390px 打开则正常（0 溢出）。属既有行为，与策略台无关，尚未定位到具体元素。

## 安全边界

- 密钥只在服务端 `.env`，不进入前端、日志、截图或文档。
- 交易端点固定 paper；没有 live endpoint 参数。
- 新闻 HTML 在服务端去标签；前端只渲染纯文本。
- 静态资源本地化，不依赖 CDN（ECharts/Preact/HTM 均在 `static/vendor`）。
- 响应带 `X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`。

## 交接建议顺序

1. 先运行 `python test_alpaca_connection.py` 确认纸面账户与网络。
2. 启动服务，逐页检查 `docs/screenshot-*.png` 对应的 UI 与当前数据是否一致。
3. 若 Alpaca 权限或数据格式变化，优先检查 `app/alpaca_api.py` 与 `app/market.py` 的归一化层。
4. 修改订单字段时，先看 `app/trading.py` 的 `OrderInput` 校验和 `static/js/components/trade-ticket.js` 的联动。
5. 修改行情流时，注意 Alpaca 订阅数量限制、`focus` 语义、以及 400ms 合并逻辑。
