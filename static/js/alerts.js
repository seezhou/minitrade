import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { notify } from "./store.js";
import { activeSymbols, describeTrigger, evaluate, normalizeRule } from "./alert-rules.js";

/**
 * Local price alerts.
 *
 * Alpaca has no alert API, so rules live in localStorage and are evaluated against
 * the delayed quotes endpoint. Nothing here can place an order: it only raises a
 * toast (and optionally a system notification) when a threshold is crossed.
 */

const STORAGE_KEY = "minitrade-price-alerts";
const NOTIFY_KEY = "minitrade-alerts-notify";
const POLL_MS = 60000;

let cache = null;
const listeners = new Set();

function readRules() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeRule).filter(Boolean);
  } catch {
    return [];
  }
}

function push(next) {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* quota or private mode: keep the in-memory list */
  }
  for (const listener of [...listeners]) listener(next);
  return next;
}

export function getRules() {
  if (!cache) cache = readRules();
  return cache;
}

export function addRule({ symbol, op, price }) {
  const rule = normalizeRule({
    id: `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    symbol,
    op,
    price,
    created_at: new Date().toISOString(),
  });
  if (!rule) throw new Error("请输入有效的提醒价格。");
  const current = getRules();
  const duplicate = current.some((item) => (
    !item.triggered_at && item.symbol === rule.symbol && item.op === rule.op && item.price === rule.price
  ));
  if (duplicate) return current;
  return push([...current, rule]);
}

export function removeRule(id) {
  return push(getRules().filter((item) => item.id !== id));
}

export function clearTriggeredRules() {
  return push(getRules().filter((item) => !item.triggered_at));
}

export function subscribeRules(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAlertRules() {
  const [rules, setRules] = useState(getRules);
  useEffect(() => subscribeRules(setRules), []);
  return rules;
}

// ---------------------------------------------------------------------------
// System notifications (optional; the toast always fires)
// ---------------------------------------------------------------------------

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationsEnabled() {
  try {
    return localStorage.getItem(NOTIFY_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(enabled) {
  try {
    localStorage.setItem(NOTIFY_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

function systemNotify(text) {
  if (!notificationsEnabled() || !notificationsSupported() || Notification.permission !== "granted") return;
  try {
    new Notification("MiniTrade 价格提醒", { body: text, tag: text });
  } catch {
    /* some browsers block constructor notifications */
  }
}

// ---------------------------------------------------------------------------
// Global evaluator
// ---------------------------------------------------------------------------

/**
 * Poll the delayed quote endpoint for every symbol that still has a waiting rule.
 *
 * Mounted once in App(), so alerts fire on any page. The poll is skipped while the
 * tab is hidden; the next visible tick catches up because rules are stateless.
 */
export function usePriceAlerts() {
  const rules = useAlertRules();
  const symbols = activeSymbols(rules);
  const key = symbols.join(",");
  const rulesRef = useRef(rules);
  rulesRef.current = rules;

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;

    async function check() {
      if (document.visibilityState !== "visible") return;
      let rows;
      try {
        rows = await api(`/api/quotes?symbols=${encodeURIComponent(key)}`);
      } catch {
        return;
      }
      if (!alive || !Array.isArray(rows)) return;
      const prices = {};
      for (const row of rows) {
        if (row?.symbol && row.price != null) prices[row.symbol] = Number(row.price);
      }
      const { rules: next, triggered } = evaluate(rulesRef.current, prices);
      if (!triggered.length) return;
      push(next);
      for (const hit of triggered) {
        const text = describeTrigger(hit);
        notify(text, "success");
        systemNotify(text);
      }
    }

    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [key]);
}
