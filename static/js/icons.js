import { h } from "preact";
import { html } from "./utils.js";

const ICONS = {
  home: [
    ["path", { d: "M3 10.5 12 3l9 7.5" }],
    ["path", { d: "M5 9.5V21h5v-6h4v6h5V9.5" }],
  ],
  market: [
    ["path", { d: "M3 3v18h18" }],
    ["path", { d: "m6 15 4-4 3 3 6-7" }],
    ["path", { d: "M15 7h4v4" }],
  ],
  star: [
    ["path", { d: "M12 3.5 14.7 9l6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.9 9.3 9Z" }],
  ],
  portfolio: [
    ["path", { d: "M21 12a9 9 0 1 1-9-9" }],
    ["path", { d: "M12 3a9 9 0 0 1 9 9h-9Z" }],
  ],
  orders: [
    ["path", { d: "M8 6h13M8 12h13M8 18h13" }],
    ["path", { d: "M3 6h.01M3 12h.01M3 18h.01" }],
  ],
  account: [
    ["path", { d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }],
    ["circle", { cx: 12, cy: 7, r: 4 }],
  ],
  search: [
    ["circle", { cx: 11, cy: 11, r: 7 }],
    ["path", { d: "m20 20-3.6-3.6" }],
  ],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  x: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
  check: [["path", { d: "m5 12 4.5 4.5L19 7" }]],
  refresh: [
    ["path", { d: "M21 12a9 9 0 1 1-2.6-6.4" }],
    ["path", { d: "M21 3v6h-6" }],
  ],
  arrowUp: [["path", { d: "M7 17 17 7M8 7h9v9" }]],
  arrowDown: [["path", { d: "M7 7l10 10M17 8v9H8" }]],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  chevronRight: [["path", { d: "m9 6 6 6-6 6" }]],
  clock: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["path", { d: "M12 7v5l3 2" }],
  ],
  news: [
    ["path", { d: "M4 5h13v14H6a2 2 0 0 1-2-2Z" }],
    ["path", { d: "M17 8h3v9a2 2 0 0 1-2 2h-1" }],
    ["path", { d: "M7 9h7M7 13h7M7 17h4" }],
  ],
  calendar: [
    ["rect", { x: 3, y: 5, width: 18, height: 16, rx: 2 }],
    ["path", { d: "M16 3v4M8 3v4M3 11h18" }],
  ],
  info: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["path", { d: "M12 11v5M12 8h.01" }],
  ],
  external: [
    ["path", { d: "M14 4h6v6" }],
    ["path", { d: "M20 4 11 13" }],
    ["path", { d: "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" }],
  ],
  settings: [
    ["circle", { cx: 12, cy: 12, r: 3 }],
    ["path", { d: "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" }],
  ],
  trash: [
    ["path", { d: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" }],
    ["path", { d: "M10 11v5M14 11v5" }],
  ],
  edit: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" }],
  ],
  alert: [
    ["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" }],
    ["path", { d: "M12 9v4M12 17h.01" }],
  ],
  trendUp: [
    ["path", { d: "m3 17 6-6 4 4 8-8" }],
    ["path", { d: "M15 7h6v6" }],
  ],
  trendDown: [
    ["path", { d: "m3 7 6 6 4-4 8 8" }],
    ["path", { d: "M15 17h6v-6" }],
  ],
  activity: [["path", { d: "M3 12h4l3 8 4-16 3 8h4" }]],
  layers: [
    ["path", { d: "m12 3 9 5-9 5-9-5Z" }],
    ["path", { d: "m3 13 9 5 9-5" }],
  ],
  briefcase: [
    ["rect", { x: 3, y: 7, width: 18, height: 13, rx: 2 }],
    ["path", { d: "M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" }],
  ],
  menu: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
  filter: [["path", { d: "M4 5h16l-6 7v6l-4 2v-8Z" }]],
  eye: [
    ["path", { d: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" }],
    ["circle", { cx: 12, cy: 12, r: 2.5 }],
  ],
  wallet: [
    ["path", { d: "M3 7a2 2 0 0 1 2-2h14v3" }],
    ["rect", { x: 3, y: 7, width: 18, height: 13, rx: 2 }],
    ["path", { d: "M16 13h3" }],
  ],
  dollar: [
    ["path", { d: "M12 2v20" }],
    ["path", { d: "M17 6.5C17 4.6 14.8 3 12 3S7 4.6 7 6.5 9.2 10 12 10s5 1.6 5 3.5S14.8 17 12 17s-5-1.6-5-3.5" }],
  ],
  crypto: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["path", { d: "M9.5 7.5h4a2.4 2.4 0 0 1 0 4.8h-4m0 0h4.4a2.4 2.4 0 0 1 0 4.8H9.5m2-11.3v13.4" }],
  ],
  play: [["path", { d: "m8 5 11 7-11 7Z" }]],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4 }],
    ["path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }],
  ],
  moon: [["path", { d: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" }]],
  download: [
    ["path", { d: "M12 3v12" }],
    ["path", { d: "m7 10 5 5 5-5M4 21h16" }],
  ],
};

export function Icon({ name, size = 18, className = "", strokeWidth = 1.8 }) {
  const paths = ICONS[name] || ICONS.info;
  return html`<svg
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width=${strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    class=${className}
    aria-hidden="true"
  >
    ${paths.map(([tag, attrs]) => h(tag, attrs))}
  </svg>`;
}
