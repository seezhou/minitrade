import { useEffect, useId, useState } from "preact/hooks";
import { html, cls, fmt, toneClass, clamp } from "./utils.js";
import { Icon } from "./icons.js";

const LOGO_RETRIES = 2;
const LOGO_RETRY_DELAY = 600;

export function Logo({ symbol, size = "", name }) {
  const letter = (symbol || "?").slice(0, 1).toUpperCase();
  const [logoState, setLogoState] = useState("normal");
  const [attempt, setAttempt] = useState(0);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setLogoState("normal");
    setAttempt(0);
    setBroken(false);
  }, [symbol]);

  // A failed logo is retried a couple of times with backoff instead of hiding for good.
  useEffect(() => {
    if (!broken || attempt >= LOGO_RETRIES) return undefined;
    const timer = setTimeout(() => {
      setBroken(false);
      setAttempt((value) => value + 1);
    }, LOGO_RETRY_DELAY * (attempt + 1));
    return () => clearTimeout(timer);
  }, [broken, attempt]);

  const classify = (event) => {
    const img = event.currentTarget;
    try {
      const canvas = document.createElement("canvas");
      const edge = 48;
      canvas.width = edge;
      canvas.height = edge;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.clearRect(0, 0, edge, edge);
      context.drawImage(img, 0, 0, edge, edge);
      const { data } = context.getImageData(0, 0, edge, edge);
      let visible = 0;
      let transparent = 0;
      let light = 0;
      let contrast = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha < 32) { transparent += 1; continue; }
        visible += 1;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const saturation = Math.max(r, g, b) - Math.min(r, g, b);
        if (luma > 0.84 && saturation < 0.16) light += 1;
        if (luma < 0.72 || saturation > 0.2) contrast += 1;
      }
      const total = edge * edge;
      if (visible < 12) {
        // Nothing was drawn at all: fall back to the letter tile.
        setLogoState("hidden");
      } else if (light / visible > 0.9 && contrast / visible < 0.02) {
        // A blank, near-uniform white asset carries no mark either.
        setLogoState("hidden");
      } else if (transparent / total > 0.25 && light / visible > 0.78 && contrast / visible < 0.28) {
        // White-on-transparent brand marks disappear on a light logo tile.
        // Logos that ship their own light background stay untouched: the mark is
        // visible on the white tile even when it only covers a small area.
        setLogoState("inverted");
      }
    } catch {
      // Canvas can fail for exotic formats; the original image is still usable.
    }
  };

  const imgClass = logoState === "inverted"
    ? "logo-inverted"
    : logoState === "hidden" || (broken && attempt >= LOGO_RETRIES) ? "logo-hidden" : "";
  const src = `/api/stocks/${encodeURIComponent(symbol || "")}/logo${attempt ? `?v=${attempt}` : ""}`;

  return html`<span class=${cls("logo", size)} title=${name || symbol || ""}>
    <b>${letter}</b>
    <img
      key=${`${symbol}:${attempt}`}
      class=${imgClass}
      src=${src}
      alt=${symbol || ""}
      loading="lazy"
      referrerpolicy="no-referrer"
      onLoad=${classify}
      onError=${() => setBroken(true)}
    />
  </span>`;
}

export function Card({ children, className = "", ...rest }) {
  return html`<section class=${cls("card", className)} ...${rest}>${children}</section>`;
}

export function PageHead({ eyebrow, title, sub, actions }) {
  return html`<div class="page-head">
    <div>
      ${eyebrow && html`<div class="eyebrow">${eyebrow}</div>`}
      <h1>${title}</h1>
      ${sub && html`<p class="sub">${sub}</p>`}
    </div>
    ${actions && html`<div class="head-actions">${actions}</div>`}
  </div>`;
}

export function Tabs({ tabs, value, onChange, className = "" }) {
  return html`<div class=${cls("tabs", className)} role="tablist">
    ${tabs.map((tab) => html`<button
      role="tab"
      aria-selected=${value === tab.key}
      class=${cls("tab", value === tab.key && "active")}
      onClick=${() => onChange(tab.key)}
    >${tab.label}${tab.count != null ? html`<span class="badge" style="margin-left:6px">${tab.count}</span>` : ""}</button>`)}
  </div>`;
}

export function Seg({ options, value, onChange, className = "" }) {
  return html`<div class=${cls("seg", className)}>
    ${options.map((option) => html`<button
      class=${cls(value === option.key && "active")}
      onClick=${() => onChange(option.key)}
    >${option.label}</button>`)}
  </div>`;
}

export function Sparkline({ values = [], width = 82, height = 28, color, className = "", strokeWidth = 1.6 }) {
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const clean = (values || []).map(Number).filter(Number.isFinite);
  if (clean.length < 2) {
    return html`<svg class=${cls("sparkline", className)} width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`}>
      <line x1="2" y1=${height - 4} x2=${width - 2} y2=${height - 4} stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3 3" />
    </svg>`;
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const pad = 2;
  const step = (width - pad * 2) / (clean.length - 1);
  const points = clean.map((value, index) => [pad + index * step, pad + (height - pad * 2) * (1 - (value - min) / span)]);
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L${points[points.length - 1][0].toFixed(2)},${height} L${points[0][0].toFixed(2)},${height} Z`;
  const rising = clean[clean.length - 1] >= clean[0];
  const stroke = color || (rising ? "#059669" : "#e11d48");
  return html`<svg class=${cls("sparkline", className)} width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} aria-hidden="true">
    <defs>
      <linearGradient id=${gradientId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color=${stroke} stop-opacity="0.22" />
        <stop offset="100%" stop-color=${stroke} stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d=${area} fill=${`url(#${gradientId})`} />
    <path d=${line} fill="none" stroke=${stroke} stroke-width=${strokeWidth} stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

export function Change({ value, percent, className = "", showValue = true, digits = 2 }) {
  const numericPercent = Number(percent);
  const numericValue = Number(value);
  const hasPercent = Number.isFinite(numericPercent);
  const hasValue = showValue && Number.isFinite(numericValue);
  const tone = toneClass(hasPercent ? numericPercent : numericValue);
  if (!hasPercent && !hasValue) return html`<span class=${cls("num", "muted", className)}>—</span>`;
  return html`<span class=${cls("num", tone, className)}>
    ${hasValue ? fmt.moneySigned(numericValue, digits) : ""}${hasValue && hasPercent ? " " : ""}${hasPercent ? `(${fmt.pct(numericPercent, digits)})` : ""}
  </span>`;
}

export function Badge({ tone = "neutral", children, className = "" }) {
  const map = { green: "badge-green", red: "badge-red", amber: "badge-amber", blue: "badge-blue", dark: "badge-dark", neutral: "" };
  return html`<span class=${cls("badge", map[tone], className)}>${children}</span>`;
}

export function StatusDot({ status }) {
  const state = status?.state;
  const dotClass = state === "connected" ? "live" : state === "reconnecting" || state === "connecting" ? "warn" : state === "error" ? "bad" : "";
  return html`<span class=${cls("dot", dotClass)} />`;
}

export function RangeBar({ low, high, value, lowLabel, highLabel, left = "52 周低", right = "52 周高" }) {
  const has = [low, high, value].every((item) => item != null && Number.isFinite(Number(item)));
  const position = has && Number(high) !== Number(low) ? clamp((Number(value) - Number(low)) / (Number(high) - Number(low)), 0, 1) : 0.5;
  return html`<div class="range-block">
    <div class="range-head"><span>${left}</span><span>${right}</span></div>
    <div class="range-track"><span class="range-marker" style=${`left:${(position * 100).toFixed(1)}%`} /></div>
    <div class="range-labels">
      <span>${lowLabel ?? (Number.isFinite(Number(low)) ? fmt.price(low) : "—")}</span>
      <span>${highLabel ?? (Number.isFinite(Number(high)) ? fmt.price(high) : "—")}</span>
    </div>
  </div>`;
}

export function Empty({ icon = "info", title = "暂无数据", description, action }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${21} /></div>
    <b>${title}</b>
    ${description && html`<p>${description}</p>`}
    ${action}
  </div>`;
}

export function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return html`<div class="error-banner">
    <${Icon} name="alert" size=${15} />
    <span class="grow">${message}</span>
    ${onRetry && html`<button class="btn btn-sm btn-ghost" onClick=${onRetry}>重试</button>`}
  </div>`;
}

export function Skeleton({ lines = 1, block = false }) {
  if (block) return html`<div class="skeleton sk-block" />`;
  return html`<div class="stack-sm">
    ${Array.from({ length: lines }).map((_, index) => html`<div class="skeleton sk-line" style=${`width:${index === lines - 1 ? 62 : 100 - index * 8}%`} />`)}
  </div>`;
}

export function LoadingRow({ label = "加载中…" }) {
  return html`<div class="loading-row"><span class="spinner" />${label}</div>`;
}

export function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const handler = (event) => { if (event.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  return html`<div class="modal-backdrop" onMouseDown=${(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
    <div class=${cls("modal", wide && "wide")} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="modal-head">
        <div><h2>${title}</h2>${subtitle && html`<div class="card-sub" style="margin-top:5px">${subtitle}</div>`}</div>
        <button class="btn btn-ghost btn-icon btn-sm" onClick=${onClose} aria-label="关闭"><${Icon} name="x" size=${16} /></button>
      </div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-body" style="padding-top:0">${footer}</div>`}
    </div>
  </div>`;
}

export function Toast({ toast, onClose }) {
  if (!toast) return null;
  return html`<div class="toast-wrap">
    <div class=${cls("toast", toast.tone === "error" ? "error" : toast.tone === "success" ? "success" : "")} onClick=${onClose}>
      <${Icon} name=${toast.tone === "error" ? "alert" : toast.tone === "success" ? "check" : "info"} size=${15} />
      <span class="grow">${toast.message}</span>
    </div>
  </div>`;
}

export function SectionHead({ title, sub, action, className = "" }) {
  return html`<div class=${cls("section-head row-between", className)} style="margin:0 0 10px">
    <div><div class="card-title">${title}</div>${sub && html`<div class="card-sub">${sub}</div>`}</div>
    ${action}
  </div>`;
}

export function IconText({ icon, children }) {
  return html`<span class="row" style="gap:6px"><${Icon} name=${icon} size=${14} />${children}</span>`;
}

export function Retry({ onClick }) {
  return html`<button class="btn btn-sm" onClick=${onClick}><${Icon} name="refresh" size=${13} />刷新</button>`;
}
