export type ProxyInfo = {
  index: number;
  stableId: string;
  name: string;
  subName: string;
  server: string;
  port: number;
  protocol: string;
  proxyPort: number;
  online: boolean;
  latencyMs: number;
};

export type PublicProxyInfo = {
  stableId: string;
  name: string;
  online: boolean;
  latencyMs: number;
};

export type StatusResponse = {
  total: number;
  online: number;
  offline: number;
  avgLatencyMs: number;
};

export type ConfigResponse = {
  checkInterval: number;
  checkMethod: string;
  timeout: number;
  startPort: number;
  subscriptionUpdate: boolean;
  subscriptionUpdateInterval: number;
  simulateLatency: boolean;
  subscriptionNames: string[];
};

export type SystemInfoResponse = {
  version: string;
  uptime: string;
  uptimeSec: number;
  instance: string;
};

export type SystemIPResponse = {
  ip: string;
};

export type SubscriptionGroup = {
  name: string;
  nodeCount: number;
  lastUpdatedAt?: string;
  lastCheckedAt?: string;
};

export type ScheduleSettings = {
  autoFetchEnabled: boolean;
  autoFetchMinutes: number;
  autoCheckEnabled: boolean;
  autoCheckMinutes: number;
  updatedAt?: string;
};

export type ActionLog = {
  id: number;
  action: string;
  status: string;
  message: string;
  createdAt: string;
};

type APIResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type ActionResponse = {
  message: string;
  proxies?: string;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE || "";

function buildUrl(path: string) {
  if (!apiBase) return path;
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  return `${apiBase.replace(/\/$/, "")}/${trimmed}`;
}

async function fetchJSON<T>(path: string): Promise<T> {
  const response = await fetch(buildUrl(path));
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const payload = (await response.json()) as APIResponse<T>;
  if (!payload.success || payload.data === undefined) {
    throw new Error(payload.error ?? "Invalid API payload");
  }
  return payload.data;
}

async function requestJSON<T>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch(buildUrl(path), options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const payload = (await response.json()) as APIResponse<T>;
  if (!payload.success || payload.data === undefined) {
    throw new Error(payload.error ?? "Invalid API payload");
  }
  return payload.data;
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  return requestJSON<T>(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function getStatus() {
  return fetchJSON<StatusResponse>("/api/v1/status");
}

export async function getProxies(): Promise<{ proxies: ProxyInfo[] | PublicProxyInfo[]; publicMode: boolean }> {
  try {
    const proxies = await fetchJSON<ProxyInfo[]>("/api/v1/proxies");
    return { proxies, publicMode: false };
  } catch {
    const proxies = await fetchJSON<PublicProxyInfo[]>("/api/v1/public/proxies");
    return { proxies, publicMode: true };
  }
}

export async function getConfig() {
  try {
    return await fetchJSON<ConfigResponse>("/api/v1/config");
  } catch {
    return null;
  }
}

export async function getSystemInfo() {
  try {
    return await fetchJSON<SystemInfoResponse>("/api/v1/system/info");
  } catch {
    return null;
  }
}

export async function getSystemIP() {
  try {
    return await fetchJSON<SystemIPResponse>("/api/v1/system/ip");
  } catch {
    return null;
  }
}

export async function getDashboardSnapshot() {
  const [status, proxiesResult, config, systemInfo, systemIP] = await Promise.all([
    getStatus(),
    getProxies(),
    getConfig(),
    getSystemInfo(),
    getSystemIP(),
  ]);

  return {
    status,
    proxies: proxiesResult.proxies,
    publicMode: proxiesResult.publicMode,
    config,
    systemInfo,
    systemIP,
  };
}

export async function triggerCheck() {
  const result = await postJSON<ActionResponse>("/api/v1/check");
  return result.message;
}

export async function triggerReload() {
  const result = await postJSON<ActionResponse>("/api/v1/reload");
  return result.message;
}

export async function getSubscriptions() {
  try {
    return await fetchJSON<string[]>("/api/v1/subscriptions");
  } catch {
    return null;
  }
}

export async function getSubscriptionGroups() {
  try {
    return await fetchJSON<SubscriptionGroup[]>("/api/v1/subscriptions/groups");
  } catch {
    return null;
  }
}

export async function addSubscription(url: string) {
  const result = await postJSON<ActionResponse>("/api/v1/subscriptions", { url });
  return result.message;
}

export async function deleteSubscription(url: string) {
  const encoded = encodeURIComponent(url);
  const result = await requestJSON<ActionResponse>(`/api/v1/subscriptions?url=${encoded}`, {
    method: "DELETE",
  });
  return result.message;
}

export async function refreshSubscription(url: string) {
  const encoded = encodeURIComponent(url);
  const result = await postJSON<ActionResponse>(`/api/v1/subscriptions/refresh?url=${encoded}`);
  return result.message;
}

export async function getScheduleSettings() {
  try {
    return await fetchJSON<ScheduleSettings>("/api/v1/schedule");
  } catch {
    return null;
  }
}

export async function updateScheduleSettings(settings: ScheduleSettings) {
  const result = await requestJSON<ActionResponse>("/api/v1/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return result.message;
}

export async function getActionLogs(filters?: {
  action?: string;
  status?: string;
  query?: string;
  limit?: number;
}) {
  try {
    const params = new URLSearchParams();
    params.set("limit", String(filters?.limit ?? 50));
    if (filters?.action) params.set("action", filters.action);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.query) params.set("q", filters.query);
    const queryString = params.toString();
    return await fetchJSON<ActionLog[]>(`/api/v1/actions?${queryString}`);
  } catch {
    return null;
  }
}
