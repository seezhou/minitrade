import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.js";

/**
 * News watcher.
 *
 * Alpaca's `wss://stream.data.alpaca.markets/v1beta1/news` accepts auth and the
 * subscription but sends nothing on this account (verified 2026-11-05: REST returns
 * fresh headlines, the socket stays silent for 120s). So "live" news is an
 * incremental poll of `/api/news` instead: every page that cares registers its
 * symbols, one shared request runs per minute, and unseen ids are counted.
 *
 * The point is a "有 N 条新新闻" prompt, never an auto-refreshing list.
 */

const POLL_MS = 60000;

class NewsWatch {
  constructor() {
    this.subs = new Map();
    this.timer = null;
    this.inflight = false;
    this.seen = new Set();
    this.pending = [];
    this.status = { state: "idle", message: "新闻监控未启动" };
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(callback);
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  emit(event, payload) {
    for (const callback of [...(this.listeners.get(event) || [])]) callback(payload);
  }

  setStatus(state, message) {
    this.status = { state, message };
    this.emit("status", this.status);
  }

  symbols() {
    const merged = new Set();
    for (const list of this.subs.values()) for (const symbol of list) merged.add(symbol);
    return [...merged].sort();
  }

  subscribe(key, symbols) {
    const cleaned = [...new Set((symbols || []).filter(Boolean).map((item) => String(item).toUpperCase()))];
    this.subs.set(key, cleaned);
    this.restart();
    return () => {
      this.subs.delete(key);
      this.restart();
    };
  }

  restart() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.subs.size) {
      this.setStatus("idle", "没有页面在监控新闻");
      return;
    }
    this.setStatus("watching", "正在监控新闻…");
    this.poll({ silent: true });
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  async poll({ silent = false } = {}) {
    if (this.inflight) return;
    const symbols = this.symbols();
    if (!symbols.length) return;
    this.inflight = true;
    try {
      const rows = await api(`/api/news?symbols=${encodeURIComponent(symbols.join(","))}&limit=20`);
      const list = Array.isArray(rows) ? rows : [];
      const unseen = list.filter((item) => item?.id && !this.seen.has(item.id));
      for (const item of list) if (item?.id) this.seen.add(item.id);
      if (!silent && unseen.length) {
        this.pending.push(...unseen);
        this.emit("pending", this.pending.slice());
      }
      this.setStatus("watching", `监控 ${symbols.length} 只股票的新闻`);
    } catch (error) {
      this.setStatus("error", error?.message || "新闻监控失败");
    } finally {
      this.inflight = false;
    }
  }

  /** Remove and return the pending headlines, optionally only for one symbol. */
  take(symbol) {
    const target = symbol ? String(symbol).toUpperCase() : "";
    const matches = (item) => !target || (item.symbols || []).includes(target);
    const hit = this.pending.filter(matches);
    this.pending = this.pending.filter((item) => !matches(item));
    this.emit("pending", this.pending.slice());
    return hit;
  }
}

export const newsWatch = new NewsWatch();

/**
 * Watch `symbols` for new headlines.
 *
 * Returns the pending headlines for `filter` (usually the current stock), the
 * watcher status, and `take()` to acknowledge them after refreshing the list.
 */
export function useNewsWatch(symbols, { filter = "" } = {}) {
  const list = [...new Set((symbols || []).filter(Boolean).map((item) => String(item).toUpperCase()))];
  const key = list.join(",");
  const keyRef = useRef(`news-${Math.random().toString(36).slice(2, 10)}`);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [pending, setPending] = useState([]);
  const [status, setStatus] = useState(newsWatch.status);
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    const offPending = newsWatch.on("pending", (items) => {
      const target = filterRef.current ? String(filterRef.current).toUpperCase() : "";
      setPending(target ? items.filter((item) => (item.symbols || []).includes(target)) : items);
    });
    const offStatus = newsWatch.on("status", setStatus);
    const unsubscribe = newsWatch.subscribe(keyRef.current, listRef.current);
    return () => {
      offPending();
      offStatus();
      unsubscribe();
    };
  }, [key]);

  return {
    pending,
    count: pending.length,
    status,
    take: () => {
      const taken = newsWatch.take(filterRef.current);
      setPending([]);
      return taken;
    },
  };
}
