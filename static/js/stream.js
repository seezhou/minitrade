import { useEffect, useRef, useState } from "preact/hooks";
import { setState } from "./store.js";

const WS_PATH = "/ws/market";

class MarketStream {
  constructor() {
    this.ws = null;
    this.subs = new Map();
    this.focus = null;
    this.retry = 0;
    this.timer = null;
    this.syncTimer = null;
    this.status = { state: "idle", message: "实时行情尚未连接", feed_label: "SIP 综合行情（约延迟 15 分钟）" };
    this.listeners = { ticks: new Set(), trades: new Set(), status: new Set() };
    this.lastPayload = "";
    this.manualClose = false;
  }

  on(event, callback) {
    this.listeners[event].add(callback);
    return () => this.listeners[event].delete(callback);
  }

  emit(event, payload) {
    for (const callback of this.listeners[event]) callback(payload);
  }

  setStatus(status) {
    this.status = { ...this.status, ...status };
    setState({ streamStatus: this.status });
    this.emit("status", this.status);
  }

  ensure() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.ws) return;
    this.manualClose = false;
    this.connect();
  }

  connect() {
    clearTimeout(this.timer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.setStatus({ state: "connecting", message: "正在连接实时行情…" });
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${location.host}${WS_PATH}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.lastPayload = "";
      this.sync(true);
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "status") {
        this.setStatus(message);
      } else if (message.type === "snapshot") {
        if (message.ticks && Object.keys(message.ticks).length) this.emit("ticks", message);
      } else if (message.type === "ticks") {
        this.emit("ticks", message);
        if (message.trades?.length) this.emit("trades", message);
      }
    };
    socket.onerror = () => {
      this.setStatus({ state: "reconnecting", message: "行情连接异常，正在重连…" });
    };
    socket.onclose = () => {
      this.ws = null;
      if (this.manualClose) return;
      this.setStatus({ state: "reconnecting", message: "行情连接中断，正在重连…" });
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    const delay = Math.min(15000, 900 * Math.max(1, 2 ** this.retry));
    this.retry += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  subscribe(key, symbols) {
    this.subs.set(key, [...new Set(symbols.filter(Boolean))]);
    this.ensure();
    this.queueSync();
    return () => {
      this.subs.delete(key);
      this.queueSync();
    };
  }

  setFocus(symbol) {
    const next = symbol || null;
    if (this.focus === next) return;
    this.focus = next;
    this.queueSync();
  }

  queueSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), 60);
  }

  sync(force = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const symbols = [...new Set([...this.subs.values()].flat())].slice(0, 60);
    const payload = { action: "subscribe", symbols, focus: this.focus };
    const encoded = JSON.stringify(payload);
    if (!force && encoded === this.lastPayload) return;
    this.lastPayload = encoded;
    try {
      this.ws.send(encoded);
    } catch {
      /* socket will reconnect */
    }
  }
}

export const marketStream = new MarketStream();

export function useLive(symbols, options = {}) {
  const { focus = null } = options;
  const listKey = symbols.filter(Boolean).join(",");
  const keyRef = useRef(`sub-${Math.random().toString(36).slice(2, 10)}`);
  const symbolSetRef = useRef(new Set(symbols.filter(Boolean)));
  symbolSetRef.current = new Set(symbols.filter(Boolean));
  const [ticks, setTicks] = useState({});
  const [trades, setTrades] = useState([]);
  const [status, setStatus] = useState(marketStream.status);

  useEffect(() => {
    const key = keyRef.current;
    const unsubscribe = marketStream.subscribe(key, listKey ? listKey.split(",") : []);
    const focusSymbol = focus === true ? (listKey ? listKey.split(",")[0] : null) : focus;
    if (focusSymbol) marketStream.setFocus(focusSymbol);
    return () => {
      unsubscribe();
      if (focusSymbol) marketStream.setFocus(null);
    };
  }, [listKey, focus]);

  useEffect(() => {
    const offTicks = marketStream.on("ticks", (payload) => {
      if (!payload.ticks) return;
      setTicks((previous) => {
        const next = { ...previous };
        for (const [symbol, patch] of Object.entries(payload.ticks)) {
          if (!symbolSetRef.current.has(symbol)) continue;
          next[symbol] = { ...(next[symbol] || {}), ...patch };
        }
        return next;
      });
      if (payload.trades?.length && payload.focus) {
        setTrades((previous) => {
          const merged = [...previous, ...payload.trades];
          const seen = new Set();
          const unique = [];
          for (let index = merged.length - 1; index >= 0; index -= 1) {
            const trade = merged[index];
            const id = trade.seq ?? `${trade.ts}-${trade.price}-${trade.size}`;
            if (seen.has(id)) continue;
            seen.add(id);
            unique.push(trade);
            if (unique.length >= 40) break;
          }
          return unique.reverse();
        });
      }
    });
    const offStatus = marketStream.on("status", setStatus);
    setStatus(marketStream.status);
    return () => {
      offTicks();
      offStatus();
    };
  }, []);

  return { ticks, trades, status };
}

class OrderStream {
  constructor() {
    this.ws = null;
    this.retry = 0;
    this.timer = null;
    this.status = { state: "idle", message: "订单更新流尚未连接" };
    this.listeners = new Set();
    this.statusListeners = new Set();
  }

  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onStatus(callback) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  setStatus(status) {
    this.status = status;
    setState({ orderStatus: status });
    for (const callback of this.statusListeners) callback(status);
  }

  ensure() {
    if (this.ws) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${location.host}/ws/orders`);
    } catch {
      return;
    }
    this.ws = socket;
    socket.onopen = () => this.setStatus({ state: "connected", message: "订单更新流已连接" });
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "order_status") {
        this.setStatus(message);
      } else if (message.type === "order_update") {
        for (const callback of this.listeners) callback(message);
      }
    };
    socket.onclose = () => {
      this.ws = null;
      this.setStatus({ state: "reconnecting", message: "订单更新流中断，正在重连…" });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.ensure(), Math.min(15000, 1200 * 2 ** this.retry));
      this.retry += 1;
    };
  }
}

export const orderStream = new OrderStream();

export function useOrderUpdates(handler) {
  const [status, setStatus] = useState(orderStream.status);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    orderStream.ensure();
    const offEvent = orderStream.onEvent((event) => handlerRef.current?.(event));
    const offStatus = orderStream.onStatus(setStatus);
    setStatus(orderStream.status);
    return () => {
      offEvent();
      offStatus();
    };
  }, []);
  return status;
}

class CryptoStream {
  constructor() {
    this.ws = null;
    this.subs = new Map();
    this.retry = 0;
    this.timer = null;
    this.syncTimer = null;
    this.status = { state: "idle", message: "加密实时流尚未连接" };
    this.listeners = { ticks: new Set(), status: new Set() };
    this.lastPayload = "";
    this.manualClose = false;
  }

  on(event, callback) {
    this.listeners[event].add(callback);
    return () => this.listeners[event].delete(callback);
  }

  emit(event, payload) {
    for (const callback of this.listeners[event]) callback(payload);
  }

  setStatus(status) {
    this.status = { ...this.status, ...status };
    this.emit("status", this.status);
  }

  ensure() {
    if (this.ws) return;
    this.manualClose = false;
    this.connect();
  }

  connect() {
    clearTimeout(this.timer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket;
    try {
      socket = new WebSocket(`${protocol}//${location.host}/ws/crypto`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.lastPayload = "";
      this.sync(true);
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "crypto_status") this.setStatus(message);
      else if (message.type === "crypto" && message.ticks) this.emit("ticks", message);
    };
    socket.onerror = () => {
      this.setStatus({ state: "reconnecting", message: "加密行情连接异常，正在重连…" });
    };
    socket.onclose = () => {
      this.ws = null;
      if (this.manualClose) return;
      this.setStatus({ state: "reconnecting", message: "加密行情连接中断，正在重连…" });
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    clearTimeout(this.timer);
    const delay = Math.min(15000, 1000 * Math.max(1, 2 ** this.retry));
    this.retry += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  subscribe(key, symbols) {
    this.subs.set(key, [...new Set(symbols.filter(Boolean))]);
    this.ensure();
    this.queueSync();
    return () => {
      this.subs.delete(key);
      if (!this.subs.size && this.ws) {
        // Closing the last subscription releases the shared upstream stream.
        this.manualClose = true;
        clearTimeout(this.timer);
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
        this.ws = null;
        this.setStatus({ state: "idle", message: "加密实时流已释放" });
        return;
      }
      this.queueSync();
    };
  }

  queueSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), 60);
  }

  sync(force = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const symbols = [...new Set([...this.subs.values()].flat())];
    const payload = { action: "subscribe", symbols };
    const encoded = JSON.stringify(payload);
    if (!force && encoded === this.lastPayload) return;
    this.lastPayload = encoded;
    try {
      this.ws.send(encoded);
    } catch {
      /* socket will reconnect */
    }
  }
}

export const cryptoStream = new CryptoStream();

export function useCryptoLive(symbols) {
  const listKey = symbols.filter(Boolean).join(",");
  const keyRef = useRef(`crypto-${Math.random().toString(36).slice(2, 10)}`);
  const symbolSetRef = useRef(new Set(symbols.filter(Boolean)));
  symbolSetRef.current = new Set(symbols.filter(Boolean));
  const [ticks, setTicks] = useState({});
  const [status, setStatus] = useState(cryptoStream.status);

  useEffect(() => {
    const unsubscribe = cryptoStream.subscribe(keyRef.current, listKey ? listKey.split(",") : []);
    return () => unsubscribe();
  }, [listKey]);

  useEffect(() => {
    const offTicks = cryptoStream.on("ticks", (payload) => {
      if (!payload.ticks) return;
      setTicks((previous) => {
        const next = { ...previous };
        for (const [symbol, patch] of Object.entries(payload.ticks)) {
          if (!symbolSetRef.current.has(symbol)) continue;
          next[symbol] = { ...(next[symbol] || {}), ...patch };
        }
        return next;
      });
    });
    const offStatus = cryptoStream.on("status", setStatus);
    setStatus(cryptoStream.status);
    return () => {
      offTicks();
      offStatus();
    };
  }, []);

  return { ticks, status };
}
