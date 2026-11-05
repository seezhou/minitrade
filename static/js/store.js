import { useEffect, useState } from "preact/hooks";
import { api, apiSafe } from "./api.js";

export const state = {
  account: null,
  positions: [],
  orders: [],
  watchlists: [],
  overview: null,
  tradingLoading: true,
  tradingError: "",
  watchlistsLoading: false,
  watchlistsError: "",
  toast: null,
  tradeModal: null,
  searchOpen: false,
  streamStatus: { state: "idle", message: "实时行情尚未连接" },
  orderStatus: { state: "idle", message: "订单更新流尚未连接" },
  lastOrderEvent: null,
};

const listeners = new Set();
let version = 0;

export function setState(patch) {
  Object.assign(state, typeof patch === "function" ? patch(state) : patch);
  version += 1;
  for (const listener of listeners) listener(version);
}

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = (next) => force(next);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);
  return state;
}

let toastTimer = null;
export function notify(message, tone = "info") {
  clearTimeout(toastTimer);
  setState({ toast: { id: Date.now(), message, tone } });
  toastTimer = setTimeout(() => setState({ toast: null }), 4200);
}

export function clearToast() {
  clearTimeout(toastTimer);
  setState({ toast: null });
}

export function openTrade(symbol, side = "buy", extra = {}) {
  setState({ tradeModal: { symbol, side, ...extra }, searchOpen: false });
}

export function closeTrade() {
  setState({ tradeModal: null });
}

export function openSearch() {
  setState({ searchOpen: true });
}

export function closeSearch() {
  setState({ searchOpen: false });
}

export async function refreshTrading({ silent = false } = {}) {
  if (!silent) setState({ tradingLoading: true });
  const [account, positions, orders, config] = await Promise.allSettled([
    api("/api/account"),
    api("/api/positions"),
    api("/api/orders?status=all&limit=200"),
    api("/api/account/config"),
  ]);
  const error = [account, positions, orders].find((item) => item.status === "rejected");
  setState({
    account: account.status === "fulfilled" ? account.value : state.account,
    positions: positions.status === "fulfilled" ? positions.value : state.positions,
    orders: orders.status === "fulfilled" ? orders.value : state.orders,
    accountConfig: config.status === "fulfilled" ? config.value : state.accountConfig,
    tradingLoading: false,
    tradingError: error ? error.reason?.message || "账户数据加载失败" : "",
  });
}

let overviewLoadedAt = 0;
export async function loadOverview(force = false) {
  if (!force && state.overview && Date.now() - overviewLoadedAt < 45000) return state.overview;
  try {
    const data = await api("/api/overview");
    overviewLoadedAt = Date.now();
    setState({ overview: data, overviewError: "" });
    return data;
  } catch (error) {
    setState({ overviewError: error.message });
    return null;
  }
}

export async function loadWatchlists(force = false) {
  if (!force && state.watchlists.length && state.watchlistsLoadedAt && Date.now() - state.watchlistsLoadedAt < 20000) {
    return state.watchlists;
  }
  setState({ watchlistsLoading: true, watchlistsError: "" });
  try {
    const data = await api("/api/watchlists");
    setState({ watchlists: data, watchlistsLoading: false, watchlistsLoadedAt: Date.now() });
    return data;
  } catch (error) {
    setState({ watchlistsLoading: false, watchlistsError: error.message });
    return state.watchlists;
  }
}

export function mutateWatchlist(updated) {
  const list = state.watchlists.map((item) => (item.id === updated.id ? updated : item));
  setState({ watchlists: list, watchlistsLoadedAt: Date.now() });
}

export function removeWatchlistLocal(id) {
  setState({ watchlists: state.watchlists.filter((item) => item.id !== id), watchlistsLoadedAt: Date.now() });
}

export function addWatchlistLocal(watchlist) {
  setState({ watchlists: [...state.watchlists.filter((item) => item.id !== watchlist.id), watchlist], watchlistsLoadedAt: Date.now() });
}

export async function findDefaultWatchlist() {
  const lists = state.watchlists.length ? state.watchlists : await loadWatchlists(true);
  return lists[0] || null;
}

export async function addSymbolToDefaultWatchlist(symbol) {
  const list = await findDefaultWatchlist();
  if (!list) {
    const created = await api("/api/watchlists", { method: "POST", body: { name: "我的自选", symbols: [symbol] } });
    addWatchlistLocal(created);
    notify(`已创建自选列表并加入 ${symbol}`, "success");
    return created;
  }
  if (list.symbols.includes(symbol)) {
    notify(`${symbol} 已在自选列表中`);
    return list;
  }
  const updated = await api(`/api/watchlists/${list.id}/symbols`, { method: "POST", body: { symbol } });
  mutateWatchlist(updated);
  notify(`已把 ${symbol} 加入自选`, "success");
  return updated;
}

export async function removeSymbolFromWatchlist(watchlistId, symbol) {
  const updated = await api(`/api/watchlists/${watchlistId}/symbols/${symbol}`, { method: "DELETE" });
  mutateWatchlist(updated);
  notify(`已从自选移除 ${symbol}`);
  return updated;
}

export async function preload() {
  await Promise.allSettled([refreshTrading(), loadOverview(), loadWatchlists()]);
}

export const getAccountValue = () => state.account?.portfolio_value ?? state.account?.equity ?? null;

export const openTrades = () => state.orders.filter((order) => order.is_open);

export { apiSafe };
