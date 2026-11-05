import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { html, cls, fmt, marketSession } from "./utils.js";
import { computeIndicators } from "./indicators.js";
import { useTheme } from "./theme.js";

function chartColors(theme) {
  const dark = theme === "dark";
  return {
    up: dark ? "#34d399" : "#059669",
    down: dark ? "#fb7185" : "#e11d48",
    accent: dark ? "#34d399" : "#0f9d76",
    ink: dark ? "#e7eef9" : "#0b1220",
    muted: dark ? "#8fa2b8" : "#94a3b8",
    grid: dark ? "#1b2a3d" : "#eef2f6",
    line: dark ? "#2a3b52" : "#cbd5e1",
    sliderBg: dark ? "#0b1320" : "#f8fafc",
    sliderBorder: dark ? "#1c2a3d" : "#eef2f6",
    sliderArea: dark ? "#172335" : "#f1f5f9",
    tooltipBg: dark ? "rgba(2, 6, 23, 0.96)" : "rgba(11, 18, 32, 0.94)",
    tooltipText: dark ? "#e2e8f0" : "#f8fafc",
    surface: dark ? "#0b1320" : "#ffffff",
    areaEnd: dark ? "rgba(2, 6, 23, 0)" : "rgba(255, 255, 255, 0)",
    blue: dark ? "#60a5fa" : "#3b82f6",
    purple: dark ? "#a78bfa" : "#8b5cf6",
    amber: dark ? "#fbbf24" : "#f59e0b",
  };
}

function useEChart(buildOption, deps, options = {}) {
  const { preserveZoomKey = null } = options;
  const chartRef = useRef(null);
  const zoomKeyRef = useRef(null);
  const [container, setContainer] = useState(null);
  const setContainerRef = useCallback((node) => setContainer(node), []);

  useEffect(() => {
    if (!container || !window.echarts) return undefined;
    zoomKeyRef.current = null;
    const chart = window.echarts.init(container, null, { renderer: "canvas" });
    chartRef.current = chart;
    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [container]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const previousZoom = preserveZoomKey !== null && zoomKeyRef.current === preserveZoomKey
      ? chart.getOption()?.dataZoom
      : null;
    const option = buildOption();
    if (!option) return;
    chart.setOption(option, true);
    if (previousZoom?.length) {
      const { start, end } = previousZoom[0];
      if (Number.isFinite(start) && Number.isFinite(end)) {
        chart.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, start, end });
      }
    }
    zoomKeyRef.current = preserveZoomKey;
  }, [...deps, container, preserveZoomKey]);

  return setContainerRef;
}

function axisLabelFor(range) {
  return (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (range === "1D") return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    if (range === "5D") return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(date);
    if (range === "5Y") return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", year: "2-digit", month: "numeric" }).format(date);
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(date);
  };
}

function tooltipHeader(range, bar) {
  const date = new Date(bar.time);
  if (range === "1D") {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

function extendedRanges(bars) {
  const ranges = [];
  let current = null;
  bars.forEach((bar, index) => {
    const session = marketSession(bar.time);
    const isExtended = session === "premarket" || session === "afterhours";
    if (isExtended && !current) current = { start: index, end: index, session };
    else if (isExtended && current) current.end = index;
    else if (!isExtended && current) {
      ranges.push(current);
      current = null;
    }
  });
  if (current) ranges.push(current);
  return ranges;
}

export function PriceChart({ bars, range, displayFrom, previousClose, indicators, chartType = "candle", livePrice, liveTs, className = "", showSessions = true }) {
  const hasData = Array.isArray(bars) && bars.length > 0;
  const [theme] = useTheme();
  const c = chartColors(theme);
  const containerRef = useEChart(() => {
    if (!hasData || !window.echarts) return null;
    const liveNumber = Number(livePrice);
    let data = bars;
    if (Number.isFinite(liveNumber) && liveTs && data.length) {
      const dayOf = (value) => {
        try {
          return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(value));
        } catch {
          return null;
        }
      };
      const lastBar = data[data.length - 1];
      // Only breathe life into the current session's last candle; never rewrite a previous day.
      if (dayOf(liveTs) && dayOf(liveTs) === dayOf(lastBar.time)) {
        const last = { ...lastBar };
        last.close = liveNumber;
        last.high = Math.max(Number(last.high ?? liveNumber), liveNumber);
        last.low = Math.min(Number(last.low ?? liveNumber), liveNumber);
        data = data.slice();
        data[data.length - 1] = last;
      }
    }
    const labels = data.map((bar) => bar.time);
    const closed = data.map((bar) => [bar.open, bar.close, bar.low, bar.high]);
    const derived = computeIndicators(data);
    const showRsi = Boolean(indicators.rsi);
    const showMacd = Boolean(indicators.macd);
    const subCount = Number(showRsi) + Number(showMacd);
    const showVolume = true;

    let startIndex = 0;
    if (displayFrom) {
      const found = data.findIndex((bar) => bar.time >= displayFrom);
      if (found > 0) startIndex = found;
    }
    const startPercent = data.length > 1 ? (startIndex / (data.length - 1)) * 100 : 0;

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    if (subCount === 0) {
      grids.push({ left: 18, right: 54, top: 18, height: "62%" });
      grids.push({ left: 18, right: 54, top: "81%", height: "11%" });
    } else if (subCount === 1) {
      grids.push({ left: 18, right: 54, top: 18, height: "44%" });
      grids.push({ left: 18, right: 54, top: "64%", height: "9%" });
      grids.push({ left: 18, right: 54, top: "76%", height: "14%" });
    } else {
      grids.push({ left: 18, right: 54, top: 18, height: "36%" });
      grids.push({ left: 18, right: 54, top: "56%", height: "8%" });
      grids.push({ left: 18, right: 54, top: "66%", height: "12%" });
      grids.push({ left: 18, right: 54, top: "80%", height: "12%" });
    }

    const formatAxis = axisLabelFor(range);
    grids.forEach((grid, index) => {
      const isLast = index === grids.length - 1;
      xAxes.push({
        type: "category",
        gridIndex: index,
        data: labels,
        boundaryGap: true,
        axisLine: { lineStyle: { color: c.grid } },
        axisTick: { show: false },
        axisLabel: { show: isLast, color: c.muted, fontSize: 9.5, hideOverlap: true, formatter: formatAxis },
        splitLine: { show: false },
        axisPointer: { label: { show: false } },
      });
    });

    yAxes.push({
      scale: true,
      gridIndex: 0,
      position: "right",
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.muted, fontSize: 9.5, formatter: (value) => `$${Number(value).toFixed(2)}` },
      splitLine: { lineStyle: { color: c.grid } },
    });
    yAxes.push({
      gridIndex: 1,
      position: "right",
      splitNumber: 2,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => fmt.compact(value, 0) },
      splitLine: { show: false },
    });
    if (subCount >= 1) {
      const subGrid = 2;
      yAxes.push({
        gridIndex: subGrid,
        position: "right",
        scale: true,
        splitNumber: 2,
        min: showRsi ? 0 : undefined,
        max: showRsi ? 100 : undefined,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 8.5 },
        splitLine: { show: false },
      });
    }
    if (subCount === 2) {
      yAxes.push({
        gridIndex: 3,
        position: "right",
        scale: true,
        splitNumber: 2,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 8.5, formatter: (value) => Number(value).toFixed(2) },
        splitLine: { show: false },
      });
    }

    const series = [];
    if (chartType === "area") {
      const rising = data[data.length - 1].close >= data[0].close;
      series.push({
        name: "价格",
        type: "line",
        data: data.map((bar) => bar.close),
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        lineStyle: { width: 2, color: rising ? c.accent : c.down },
        itemStyle: { color: rising ? c.accent : c.down },
        areaStyle: {
          color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: rising ? "rgba(15,157,118,0.28)" : "rgba(225,29,72,0.25)" },
            { offset: 1, color: c.areaEnd },
          ]),
        },
        z: 4,
      });
    } else {
      series.push({
        name: "K 线",
        type: "candlestick",
        data: closed,
        xAxisIndex: 0,
        yAxisIndex: 0,
        itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down, borderWidth: 1 },
        z: 4,
      });
    }

    if (indicators.ma) {
      const lines = [
        ["MA5", derived.ma5, c.amber],
        ["MA10", derived.ma10, c.blue],
        ["MA20", derived.ma20, c.purple],
        ["MA50", derived.ma50, "#14b8a6"],
        ["MA200", derived.ma200, c.muted],
      ];
      for (const [name, values, color] of lines) {
        if (!values.some((value) => value != null)) continue;
        series.push({
          name,
          type: "line",
          data: values,
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          smooth: false,
          connectNulls: false,
          lineStyle: { width: 1, color, opacity: 0.9 },
          itemStyle: { color },
          z: 3,
        });
      }
    }

    if (indicators.boll) {
      const bollSpecs = [
        ["BOLL 上轨", derived.boll.upper, c.muted, [4, 3]],
        ["BOLL 中轨", derived.boll.mid, c.line, null],
        ["BOLL 下轨", derived.boll.lower, c.muted, [4, 3]],
      ];
      for (const [name, values, color, dash] of bollSpecs) {
        series.push({
          name,
          type: "line",
          data: values,
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 1, color, type: dash ? "dashed" : "solid" },
          itemStyle: { color },
          z: 2,
        });
      }
    }

    series.push({
      name: "成交量",
      type: "bar",
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: data.map((bar) => ({
        value: bar.volume,
        itemStyle: { color: bar.close >= bar.open ? "rgba(5,150,105,0.55)" : "rgba(225,29,72,0.5)" },
      })),
      barMaxWidth: 8,
    });

    if (showRsi) {
      series.push({
        name: "RSI(14)",
        type: "line",
        data: derived.rsi,
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: false,
        lineStyle: { width: 1.2, color: c.purple },
        itemStyle: { color: c.purple },
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { color: c.line, type: "dashed", width: 1 },
          data: [{ yAxis: 70 }, { yAxis: 30 }],
        },
      });
    }

    if (showMacd) {
      const macdGrid = showRsi ? 3 : 2;
      series.push({
        name: "MACD",
        type: "bar",
        data: derived.macd.hist,
        xAxisIndex: macdGrid,
        yAxisIndex: macdGrid,
        barMaxWidth: 4,
        itemStyle: { color: (params) => (params.value >= 0 ? c.up : c.down), opacity: 0.65 },
      });
      series.push({
        name: "DIF",
        type: "line",
        data: derived.macd.dif,
        xAxisIndex: macdGrid,
        yAxisIndex: macdGrid,
        showSymbol: false,
        lineStyle: { width: 1.1, color: c.amber },
        itemStyle: { color: c.amber },
      });
      series.push({
        name: "DEA",
        type: "line",
        data: derived.macd.dea,
        xAxisIndex: macdGrid,
        yAxisIndex: macdGrid,
        showSymbol: false,
        lineStyle: { width: 1.1, color: c.blue },
        itemStyle: { color: c.blue },
      });
    }

    if (showSessions && range === "1D" && chartType !== "area") {
      const areas = extendedRanges(data).map((entry) => [
        {
          xAxis: labels[entry.start],
          itemStyle: { color: entry.session === "premarket" ? "rgba(148,163,184,0.10)" : "rgba(100,116,139,0.14)" },
          label: { show: true, color: c.muted, fontSize: 9, position: "insideTop", formatter: entry.session === "premarket" ? "盘前" : "盘后" },
        },
        { xAxis: labels[entry.end] },
      ]);
      if (areas.length) {
        series[0].markArea = { silent: true, data: areas };
      }
    }

    if (previousClose && Number.isFinite(Number(previousClose))) {
      series[0].markLine = {
        silent: true,
        symbol: "none",
        label: { show: true, position: "insideEndTop", formatter: `昨收 ${fmt.price(previousClose)}`, color: c.muted, fontSize: 9 },
        lineStyle: { color: c.muted, type: "dashed", width: 1 },
        data: [{ yAxis: Number(previousClose) }],
      };
    }

    const allAxisIndexes = grids.map((_, index) => index);
    const tooltipFormatter = (params) => {
      const index = params?.[0]?.dataIndex;
      const bar = data[index];
      if (!bar) return "";
      const rows = [
        `<div style="font-weight:700;margin-bottom:5px">${tooltipHeader(range, bar)}</div>`,
        `<div style="display:grid;grid-template-columns:auto auto;gap:2px 18px;font-size:11px">`,
        `<span style="color:#94a3b8">开盘</span><span style="text-align:right">${fmt.price(bar.open)}</span>`,
        `<span style="color:#94a3b8">最高</span><span style="text-align:right">${fmt.price(bar.high)}</span>`,
        `<span style="color:#94a3b8">最低</span><span style="text-align:right">${fmt.price(bar.low)}</span>`,
        `<span style="color:#94a3b8">收盘</span><span style="text-align:right">${fmt.price(bar.close)}</span>`,
        `<span style="color:#94a3b8">成交量</span><span style="text-align:right">${fmt.compact(bar.volume)}</span>`,
      ];
      if (derived.ma20[index] != null) rows.push(`<span style="color:#94a3b8">MA20</span><span style="text-align:right">${fmt.price(derived.ma20[index])}</span>`);
      if (derived.rsi[index] != null) rows.push(`<span style="color:#94a3b8">RSI</span><span style="text-align:right">${derived.rsi[index].toFixed(1)}</span>`);
      rows.push("</div>");
      return rows.join("");
    };

    return {
      animation: false,
      backgroundColor: "transparent",
      textStyle: { fontFamily: "inherit" },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: "inside", xAxisIndex: allAxisIndexes, start: startPercent, end: 100, zoomOnMouseWheel: true, moveOnMouseMove: true },
        {
          type: "slider", xAxisIndex: allAxisIndexes, bottom: 2, height: 14,
          borderColor: c.sliderBorder, backgroundColor: c.sliderBg, fillerColor: "rgba(15,157,118,0.10)",
          handleStyle: { color: c.accent }, dataBackground: { lineStyle: { color: c.line }, areaStyle: { color: c.sliderArea } },
          textStyle: { color: c.muted, fontSize: 8 }, start: startPercent, end: 100,
        },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: c.muted, type: "dashed" } },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", crossStyle: { color: c.muted } },
        backgroundColor: c.tooltipBg,
        borderWidth: 0,
        padding: [9, 11],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        extraCssText: "border-radius:9px;box-shadow:0 10px 30px rgba(11,18,32,.25)",
        formatter: tooltipFormatter,
      },
      series,
    };
  }, [bars, range, displayFrom, previousClose, indicators.ma, indicators.boll, indicators.rsi, indicators.macd, chartType, livePrice, liveTs, showSessions, theme], { preserveZoomKey: range });

  if (!window.echarts) return html`<div class="chart-empty">图表组件加载失败，请刷新页面。</div>`;
  if (!hasData) return html`<div class="chart-empty">暂无该时间范围的 K 线数据</div>`;
  return html`<div class=${cls("chart-wrap", className)} ref=${containerRef} />`;
}

export function EquityChart({ points = [], className = "" }) {
  const [theme] = useTheme();
  const c = chartColors(theme);
  const containerRef = useEChart(() => {
    if (!points.length || !window.echarts) return null;
    const values = points.map((point) => point.equity);
    const base = points[0].equity;
    const low = Math.min(...values);
    const high = Math.max(...values);
    const padding = Math.max((high - low) * 0.12, high * 0.0015, 1);
    const rising = values[values.length - 1] >= base;
    const color = rising ? c.accent : c.down;
    return {
      animation: false,
      grid: { left: 12, right: 58, top: 18, bottom: 26 },
      xAxis: {
        type: "category",
        data: points.map((point) => point.time),
        boundaryGap: false,
        axisLine: { lineStyle: { color: c.grid } },
        axisTick: { show: false },
        axisLabel: {
          color: c.muted, fontSize: 9, hideOverlap: true,
          formatter: (value) => new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(new Date(value)),
        },
      },
      yAxis: {
        scale: true,
        min: Math.max(0, low - padding),
        max: high + padding,
        position: "right",
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => `$${fmt.compact(value, 1)}` },
        splitLine: { lineStyle: { color: c.grid } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.tooltipBg, borderWidth: 0, padding: [9, 11],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        formatter: (params) => {
          const point = points[params[0].dataIndex];
          const delta = point.equity - base;
          return `<div style="font-weight:700;margin-bottom:4px">${fmt.localDateTime(point.time)}</div>
            <div>账户权益：${fmt.money(point.equity, "USD", 2)}</div>
            <div style="color:${delta >= 0 ? "#34d399" : "#fb7185"}">区间变化：${fmt.moneySigned(delta)}（${fmt.pct(point.equity / base - 1)}）</div>`;
        },
      },
      series: [{
        type: "line",
        data: values,
        showSymbol: false,
        smooth: 0.25,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        areaStyle: {
          color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: rising ? "rgba(15,157,118,0.26)" : "rgba(225,29,72,0.22)" },
            { offset: 1, color: c.areaEnd },
          ]),
        },
        markLine: {
          silent: true, symbol: "none",
          lineStyle: { color: c.line, type: "dashed" },
          label: { show: false },
          data: [{ yAxis: base }],
        },
      }],
    };
  }, [points, theme]);

  if (!points.length) return html`<div class="chart-empty">还没有足够的账户历史</div>`;
  return html`<div class=${cls("equity-wrap", className)} ref=${containerRef} />`;
}

export function AllocationChart({ items = [], total = 0, label = "持仓市值" }) {
  const [theme] = useTheme();
  const c = chartColors(theme);
  const containerRef = useEChart(() => {
    if (!items.length || !window.echarts) return null;
    return {
      animation: false,
      tooltip: {
        trigger: "item",
        backgroundColor: c.tooltipBg, borderWidth: 0, padding: [8, 10],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        formatter: (params) => `${params.name}<br/>${fmt.money(params.value)}（${fmt.pctPlain(params.percent / 100)}）`,
      },
      title: {
        text: fmt.money(total, "USD", 0),
        subtext: label,
        left: "center", top: "35%",
        textStyle: { fontSize: 17, fontWeight: 800, color: c.ink },
        subtextStyle: { fontSize: 9, color: c.muted },
      },
      series: [{
        type: "pie",
        radius: ["58%", "80%"],
        center: ["50%", "48%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 4 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 4 },
        data: items,
      }],
    };
  }, [items, total, label, theme]);
  if (!items.length) return html`<div class="chart-empty">暂无持仓</div>`;
  return html`<div class=${cls("allocation-wrap")} ref=${containerRef} />`;
}

export function CompareChart({ compare, sessions = 252, className = "" }) {
  const [theme] = useTheme();
  const c = chartColors(theme);
  const containerRef = useEChart(() => {
    if (!compare?.dates?.length || !window.echarts) return null;
    const start = Math.max(0, compare.dates.length - sessions);
    const dates = compare.dates.slice(start);
    const series = [
      ["本股", compare.stock.slice(start), c.accent],
      ["SPY", compare.spy.slice(start), c.blue],
      ["QQQ", compare.qqq.slice(start), c.purple],
    ];
    return {
      animation: false,
      grid: { left: 12, right: 52, top: 28, bottom: 24 },
      legend: { top: 0, right: 6, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 9, color: c.muted } },
      xAxis: {
        type: "category", data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false },
        axisLabel: {
          color: c.muted, fontSize: 9, hideOverlap: true,
          formatter: (value) => new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(new Date(value)),
        },
      },
      yAxis: {
        scale: true, position: "right", splitNumber: 4,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => Number(value).toFixed(0) },
        splitLine: { lineStyle: { color: c.grid } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.tooltipBg, borderWidth: 0, padding: [8, 10],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        formatter: (params) => {
          const index = params[0].dataIndex;
          return `<div style="font-weight:700;margin-bottom:4px">${params[0].axisValue.slice(0, 10)}</div>${params.map((item) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:${item.color}">${item.seriesName}</span><span>${fmt.pct(item.value / 100 - 1)}</span></div>`).join("")}`;
        },
      },
      series: series.map(([name, data, color]) => ({
        name, type: "line", data, showSymbol: false, smooth: 0.15,
        lineStyle: { width: name === "本股" ? 2 : 1.2, color, opacity: name === "本股" ? 1 : 0.75 },
        itemStyle: { color },
      })),
    };
  }, [compare, sessions, theme]);
  if (!compare?.dates?.length) return html`<div class="chart-empty">暂无对比数据</div>`;
  return html`<div class=${cls("chart-wrap short", className)} ref=${containerRef} />`;
}

export function IVSmileChart({ calls = [], puts = [], spot, className = "" }) {
  const [theme] = useTheme();
  const c = chartColors(theme);
  const containerRef = useEChart(() => {
    if (!window.echarts) return null;
    const callsData = calls.filter((item) => item.iv != null).map((item) => [item.strike, item.iv * 100]);
    const putsData = puts.filter((item) => item.iv != null).map((item) => [item.strike, item.iv * 100]);
    if (!callsData.length && !putsData.length) return null;
    return {
      animation: false,
      grid: { left: 12, right: 48, top: 28, bottom: 24 },
      legend: { top: 0, right: 6, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 9, color: c.muted } },
      xAxis: {
        type: "value", scale: true,
        axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => `$${value}` },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value", position: "right", splitNumber: 4,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => `${value.toFixed(0)}%` },
        splitLine: { lineStyle: { color: c.grid } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.tooltipBg, borderWidth: 0, padding: [8, 10],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        formatter: (params) => `<div style="font-weight:700;margin-bottom:4px">行权价 $${Number(params[0].axisValue).toFixed(2)}</div>${params.map((item) => `<div style="color:${item.color}">${item.seriesName} IV ${Number(item.value[1]).toFixed(1)}%</div>`).join("")}`,
      },
      series: [
        { name: "看涨", type: "line", data: callsData, showSymbol: true, symbolSize: 4, lineStyle: { color: c.up, width: 1.5 }, itemStyle: { color: c.up } },
        { name: "看跌", type: "line", data: putsData, showSymbol: true, symbolSize: 4, lineStyle: { color: c.down, width: 1.5 }, itemStyle: { color: c.down } },
      ],
      ...(spot ? {
        series: [
          { name: "看涨", type: "line", data: callsData, showSymbol: true, symbolSize: 4, lineStyle: { color: c.up, width: 1.5 }, itemStyle: { color: c.up }, markLine: { silent: true, symbol: "none", label: { formatter: `现价 $${spot.toFixed(2)}`, fontSize: 9, color: c.muted }, lineStyle: { color: c.muted, type: "dashed" }, data: [{ xAxis: spot }] } },
          { name: "看跌", type: "line", data: putsData, showSymbol: true, symbolSize: 4, lineStyle: { color: c.down, width: 1.5 }, itemStyle: { color: c.down } },
        ],
      } : {}),
    };
  }, [calls, puts, spot, theme]);
  return html`<div class=${cls("chart-wrap short", className)} ref=${containerRef} />`;
}

export function OptionTermChart({ points = [], className = "" }) {
  const [theme] = useTheme();
  const c = chartColors(theme);
  const clean = (points || []).filter((point) => point && point.expiration && Number.isFinite(Number(point.atm_iv)));
  const containerRef = useEChart(() => {
    if (!clean.length || !window.echarts) return null;
    return {
      animation: false,
      grid: { left: 12, right: 52, top: 24, bottom: 26 },
      xAxis: {
        type: "category",
        data: clean.map((point) => point.expiration),
        boundaryGap: false,
        axisLine: { lineStyle: { color: c.grid } },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, hideOverlap: true, formatter: (value) => String(value).slice(5) },
      },
      yAxis: {
        type: "value",
        scale: true,
        position: "right",
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => `${Number(value).toFixed(0)}%` },
        splitLine: { lineStyle: { color: c.grid } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.tooltipBg, borderWidth: 0, padding: [8, 10],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        formatter: (params) => {
          const point = clean[params?.[0]?.dataIndex];
          if (!point) return "";
          return `<div style="font-weight:700;margin-bottom:4px">${point.expiration}</div>
            <div>ATM IV：${(Number(point.atm_iv) * 100).toFixed(1)}%</div>
            <div style="color:#94a3b8">剩余 ${point.dte} 天</div>`;
        },
      },
      series: [{
        name: "ATM IV",
        type: "line",
        data: clean.map((point) => Number(point.atm_iv) * 100),
        smooth: 0.2,
        showSymbol: true,
        symbolSize: 5,
        lineStyle: { width: 2, color: c.purple },
        itemStyle: { color: c.purple },
        areaStyle: { color: theme === "dark" ? "rgba(167,139,250,0.16)" : "rgba(139,92,246,0.12)" },
      }],
    };
  }, [points, theme]);

  if (!clean.length) return html`<div class="chart-empty">暂无 IV Term 数据</div>`;
  return html`<div class=${cls("chart-wrap short", className)} ref=${containerRef} />`;
}

export function OptionHistoryChart({ contracts = [], className = "" }) {
  const [theme] = useTheme();
  const c = chartColors(theme);
  const usable = (contracts || []).filter((item) => (item?.bars || []).length);
  const dates = [];
  const seen = new Set();
  usable.forEach((item) => (item.bars || []).forEach((bar) => {
    const key = String(bar.time || "");
    if (key && !seen.has(key)) {
      seen.add(key);
      dates.push(key);
    }
  }));
  dates.sort();

  const containerRef = useEChart(() => {
    if (!usable.length || !dates.length || !window.echarts) return null;
    const palette = [c.blue, c.purple, c.amber, c.up];
    const series = usable.map((item, index) => {
      const closeByDate = new Map((item.bars || []).map((bar) => [String(bar.time), bar.close]));
      return {
        name: item.label || item.symbol,
        type: "line",
        showSymbol: false,
        smooth: 0.15,
        connectNulls: true,
        lineStyle: { width: 1.8, color: palette[index % palette.length] },
        itemStyle: { color: palette[index % palette.length] },
        data: dates.map((date) => (closeByDate.has(date) ? closeByDate.get(date) : null)),
      };
    });
    return {
      animation: false,
      grid: { left: 12, right: 48, top: 30, bottom: 24 },
      legend: { top: 0, right: 6, icon: "roundRect", itemWidth: 8, itemHeight: 8, textStyle: { fontSize: 9, color: c.muted } },
      xAxis: {
        type: "category", data: dates, boundaryGap: false,
        axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false },
        axisLabel: {
          color: c.muted, fontSize: 9, hideOverlap: true,
          formatter: (value) => new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).format(new Date(value)),
        },
      },
      yAxis: {
        type: "value", scale: true, position: "right", splitNumber: 4,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 9, formatter: (value) => `$${Number(value).toFixed(2)}` },
        splitLine: { lineStyle: { color: c.grid } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.tooltipBg, borderWidth: 0, padding: [8, 10],
        textStyle: { color: c.tooltipText, fontSize: 11 },
        formatter: (params) => {
          if (!params?.length) return "";
          const head = new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(params[0].axisValue));
          const rows = params
            .filter((item) => item.value != null)
            .map((item) => `<div style="color:${item.color}">${item.seriesName} $${Number(item.value).toFixed(2)}</div>`)
            .join("");
          return `<div style="font-weight:700;margin-bottom:4px">${head}</div>${rows}`;
        },
      },
      series,
    };
  }, [contracts, theme]);

  if (!usable.length) return html`<div class="chart-empty">暂无合约日线数据</div>`;
  return html`<div class=${cls("chart-wrap short", className)} ref=${containerRef} />`;
}
