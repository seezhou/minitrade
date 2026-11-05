const JSON_HEADERS = { "Content-Type": "application/json" };

export async function api(path, options = {}) {
  const { method = "GET", body, signal, headers } = options;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { ...JSON_HEADERS, ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("无法连接 MiniTrade 服务，请确认本地服务正在运行。");
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    const detail = payload && typeof payload === "object" ? payload.detail : payload;
    throw new Error(detail || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

export async function apiSafe(path, fallback = null, options) {
  try {
    return await api(path, options);
  } catch {
    return fallback;
  }
}

export function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
