import { h } from "preact";
import htm from "htm";

export const html = htm.bind(h);

export const fmt = {
  money(value, currency = "USD", digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(number);
  },

  price(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    if (number === 0) return "$0.00";
    const digits = Math.abs(number) < 1 ? 4 : 2;
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(number);
  },

  num(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(number);
  },

  compact(value, digits = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const abs = Math.abs(number);
    if (abs >= 1e12) return `${(number / 1e12).toFixed(digits)}T`;
    if (abs >= 1e9) return `${(number / 1e9).toFixed(digits)}B`;
    if (abs >= 1e6) return `${(number / 1e6).toFixed(digits)}M`;
    if (abs >= 1e3) return `${(number / 1e3).toFixed(digits)}K`;
    return Number(number).toFixed(abs < 1 ? 4 : 0);
  },

  pct(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
  },

  pctPlain(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${(number * 100).toFixed(digits)}%`;
  },

  signed(value, formatter = fmt.price) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return `${number >= 0 ? "+" : "−"}${formatter(Math.abs(number)).replace("$", "$")}`;
  },

  moneySigned(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const text = new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(Math.abs(number));
    return `${number >= 0 ? "+" : "−"}${text}`;
  },

  time(ts) {
    if (!ts) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ts));
  },

  date(ts) {
    if (!ts) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "America/New_York", month: "2-digit", day: "2-digit",
    }).format(new Date(ts));
  },

  dateTime(ts) {
    if (!ts) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "America/New_York", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ts));
  },

  dateLong(ts) {
    if (!ts) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric",
    }).format(new Date(ts));
  },

  localDateTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  },

  ago(ts) {
    if (!ts) return "—";
    const seconds = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
    return fmt.date(ts);
  },

  countdown(ts) {
    if (!ts) return "—";
    const diff = Math.max(0, new Date(ts).getTime() - Date.now());
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
    return `${seconds} 秒`;
  },
};

export function toneOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "flat";
  return number > 0 ? "up" : "down";
}

export function toneClass(value) {
  const tone = toneOf(value);
  return tone === "up" ? "positive" : tone === "down" ? "negative" : "muted";
}

export function cls(...values) {
  return values.filter(Boolean).join(" ");
}

export function etParts(ts) {
  const date = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(lookup.hour), minute: Number(lookup.minute), weekday: lookup.weekday };
}

export function marketSession(ts) {
  const { hour, minute, weekday } = etParts(ts);
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  const minutes = hour * 60 + minute;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "afterhours";
  return "closed";
}

export const SESSION_LABEL = {
  premarket: "盘前",
  regular: "盘中",
  afterhours: "盘后",
  closed: "休市",
};

export function dateShort(value) {
  if (!value) return "—";
  const date = typeof value === "string" && value.length === 10 ? new Date(`${value}T12:00:00-05:00`) : new Date(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York", month: "long", day: "numeric", weekday: "short",
  }).format(date);
}

export function timeRange(open, close) {
  if (!open || !close) return "—";
  const format = (value) => String(value).slice(0, 5);
  return `${format(open)} – ${format(close)} ET`;
}

export function isEarlyClose(close) {
  return Boolean(close) && String(close).slice(0, 5) !== "16:00";
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function pctChange(current, base) {
  if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(base)) || Number(base) === 0) return null;
  return Number(current) / Number(base) - 1;
}

export function groupBy(items, keyFn) {
  const result = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

export function parseSymbolList(value) {
  return [...new Set(String(value || "").toUpperCase().split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean))];
}
