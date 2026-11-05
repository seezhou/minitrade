export function parseRoute() {
  const raw = (location.hash || "#/market").replace(/^#/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return { page: "market" };
  if (parts[0] === "stock" && parts[1]) {
    return { page: "stock", symbol: parts[1].toUpperCase(), tab: parts[2] || "overview" };
  }
  if (parts[0] === "crypto") {
    return { page: "crypto", symbol: parts[1] ? decodeURIComponent(parts[1]).toUpperCase() : "BTC/USD" };
  }
  const known = ["market", "watchlist", "portfolio", "orders", "account", "data", "crypto"];
  if (known.includes(parts[0])) return { page: parts[0] };
  return { page: "market" };
}

export function navigate(path) {
  const target = path.startsWith("#") ? path : `#${path}`;
  if (location.hash === target) return;
  location.hash = target;
}

export function stockPath(symbol, tab = "overview") {
  return `/stock/${encodeURIComponent(symbol)}/${tab}`;
}
