import { useState } from "preact/hooks";
import { html, cls } from "../utils.js";
import { Icon } from "../icons.js";
import { addSymbolToDefaultWatchlist, notify, removeSymbolFromWatchlist, useStore } from "../store.js";

export function WatchStar({ symbol, size = 16, className = "" }) {
  const store = useStore();
  const list = store.watchlists[0];
  const active = Boolean(list?.symbols?.includes(symbol));
  const [busy, setBusy] = useState(false);

  async function toggle(event) {
    event.stopPropagation();
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (active && list) await removeSymbolFromWatchlist(list.id, symbol);
      else await addSymbolToDefaultWatchlist(symbol);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return html`<button
    type="button"
    class=${cls("btn btn-ghost btn-icon btn-sm watch-star", active && "active", className)}
    onClick=${toggle}
    title=${active ? "从自选移除" : "加入自选"}
    aria-label=${active ? "从自选移除" : "加入自选"}
    disabled=${busy}
  ><${Icon} name="star" size=${size} /></button>`;
}
