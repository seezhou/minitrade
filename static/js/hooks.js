import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export function useAsync(loader, deps = [], options = {}) {
  const { pollMs = 0, initial = null, enabled = true } = options;
  const [data, setData] = useState(initial);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    Promise.resolve()
      .then(() => loaderRef.current())
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError("");
      })
      .catch((reason) => {
        if (!alive) return;
        setError(reason?.message || "加载失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [...deps, nonce, enabled]);

  useEffect(() => {
    if (!pollMs || !enabled) return undefined;
    const timer = setInterval(() => setNonce((value) => value + 1), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, enabled]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload, setData };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useInterval(callback, delay) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!delay) return undefined;
    const timer = setInterval(() => saved.current(), delay);
    return () => clearInterval(timer);
  }, [delay]);
}

export function useDebounced(value, delay = 220) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota errors */
    }
  }, [key, value]);
  return [value, setValue];
}

export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · MiniTrade` : "MiniTrade · 模拟交易终端";
  }, [title]);
}

export function useClickOutside(ref, handler, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const listener = (event) => {
      if (!ref.current || ref.current.contains(event.target)) return;
      handler(event);
    };
    document.addEventListener("mousedown", listener);
    return () => document.removeEventListener("mousedown", listener);
  }, [ref, handler, active]);
}
