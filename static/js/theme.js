import { useEffect, useState } from "preact/hooks";

const STORAGE_KEY = "minitrade-theme";

export function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function applyTheme(theme, { persist = true } = {}) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#060b13" : "#f3f5f8");
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore private mode */
    }
  }
  window.dispatchEvent(new CustomEvent("mt:theme", { detail: next }));
}

export function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

export function useTheme() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const handler = (event) => setTheme(event.detail === "dark" ? "dark" : "light");
    window.addEventListener("mt:theme", handler);
    setTheme(currentTheme());
    return () => window.removeEventListener("mt:theme", handler);
  }, []);
  return [theme, toggleTheme];
}
