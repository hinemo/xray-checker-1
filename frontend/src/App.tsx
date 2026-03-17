import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Gauge, Globe2, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { scaleLinear } from "d3-scale";
import { curveMonotoneX, line as d3Line } from "d3-shape";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ProxyItem = {
  index?: number;
  stableId: string;
  name: string;
  subName?: string;
  server?: string;
  port?: number;
  protocol?: string;
  proxyPort?: number;
  online: boolean;
  latencyMs: number;
};

type StatusSummary = {
  total: number;
  online: number;
  offline: number;
  avgLatencyMs: number;
};

type ConfigResponse = {
  checkInterval: number;
  checkMethod: string;
  timeout: number;
  startPort: number;
  subscriptionUpdate: boolean;
  subscriptionUpdateInterval: number;
  simulateLatency: boolean;
  subscriptionNames: string[];
};

type SystemInfo = {
  version: string;
  uptime: string;
  uptimeSec: number;
  instance: string;
};

type SystemIP = {
  ip: string;
};

type APIResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

const apiBase = import.meta.env.VITE_API_BASE ?? "";

async function fetchJSON<T>(path: string): Promise<T> {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = apiBase ? `${apiBase}/${normalizedPath}` : normalizedPath;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  const payload = (await response.json()) as APIResponse<T>;
  if (!payload.success || payload.data === undefined) {
    throw new Error(payload.error ?? "Invalid API payload");
  }
  return payload.data;
}

export function App(): JSX.Element {
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemIP, setSystemIP] = useState<string>("-");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline">("all");
  const [subFilter, setSubFilter] = useState("all");
  const [publicMode, setPublicMode] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const statusData = await fetchJSON<StatusSummary>("api/v1/status");

      const fullProxyPromise = fetchJSON<ProxyItem[]>("api/v1/proxies");
      const publicProxyPromise = fetchJSON<ProxyItem[]>("api/v1/public/proxies");
      const configPromise = fetchJSON<ConfigResponse>("api/v1/config").catch(() => null);
      const sysInfoPromise = fetchJSON<SystemInfo>("api/v1/system/info").catch(() => null);
      const sysIpPromise = fetchJSON<SystemIP>("api/v1/system/ip").catch(() => null);

      const [fullProxyResult, publicProxies, cfg, info, ip] = await Promise.all([
        fullProxyPromise.catch(() => null),
        publicProxyPromise,
        configPromise,
        sysInfoPromise,
        sysIpPromise,
      ]);

      const proxyData = fullProxyResult ?? publicProxies;
      setPublicMode(fullProxyResult === null);

      setStatus(statusData);
      setProxies(proxyData);
      setConfig(cfg);
      setSystemInfo(info);
      setSystemIP(ip?.ip ?? "-");
      setHistory((prev) => [...prev.slice(-19), statusData.online]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshMs = (config?.checkInterval ?? 15) * 1000;

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);

  const onlineRate = status && status.total > 0 ? Math.round((status.online / status.total) * 100) : 0;

  const subNames = useMemo(() => {
    const names = new Set<string>();
    for (const proxy of proxies) {
      if (proxy.subName) {
        names.add(proxy.subName);
      }
    }
    return Array.from(names);
  }, [proxies]);

  const filteredProxies = useMemo(() => {
    return proxies.filter((proxy) => {
      const searchHit = proxy.name.toLowerCase().includes(search.toLowerCase()) || proxy.stableId.includes(search);
      const statusHit = statusFilter === "all" || (statusFilter === "online" ? proxy.online : !proxy.online);
      const subHit = subFilter === "all" || proxy.subName === subFilter;
      return searchHit && statusHit && subHit;
    });
  }, [proxies, search, statusFilter, subFilter]);

  const latencyScale = useMemo(() => {
    const maxLatency = Math.max(120, ...filteredProxies.map((p) => p.latencyMs));
    return scaleLinear<string>().domain([0, maxLatency]).range(["#15803d", "#ea580c"]);
  }, [filteredProxies]);

  const sparkPath = useMemo(() => {
    if (history.length < 2) {
      return "";
    }
    const maxOnline = Math.max(5, ...history);
    const lineBuilder = d3Line<number>()
      .x((_, i) => i * (260 / Math.max(1, history.length - 1)))
      .y((d) => 64 - (d / maxOnline) * 58)
      .curve(curveMonotoneX);
    return lineBuilder(history) ?? "";
  }, [history]);

  return (
    <main className="min-h-screen bg-grid px-4 py-8 text-foreground md:px-8">
      <section className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.25em] text-muted-foreground">Xray Checker Local</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight md:text-5xl">Proxy Health Command Deck</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href="api/v1/docs" className="rounded-md border border-border bg-white/70 px-3 py-2 text-sm">
              API Docs
            </a>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </header>

        {error ? (
          <Card>
            <CardContent className="p-6 text-rose-700">请求失败: {error}</CardContent>
          </Card>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <StatCard icon={<ShieldCheck className="h-5 w-5" />} title="Online Rate" value={`${onlineRate}%`} />
          <StatCard icon={<Activity className="h-5 w-5" />} title="Online" value={String(status?.online ?? 0)} />
          <StatCard icon={<Gauge className="h-5 w-5" />} title="Average Latency" value={`${status?.avgLatencyMs ?? 0}ms`} />
          <StatCard icon={<Globe2 className="h-5 w-5" />} title="Current IP" value={systemIP} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" />
              Runtime Config
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm md:grid-cols-4">
            <p>Version: {systemInfo?.version ?? "-"}</p>
            <p>Uptime: {systemInfo?.uptime ?? "-"}</p>
            <p>Method: {config?.checkMethod ?? "-"}</p>
            <p>Check Interval: {config?.checkInterval ?? "-"}s</p>
            <p>Subscription Update: {config?.subscriptionUpdate ? "On" : "Off"}</p>
            <p>Subscription Interval: {config?.subscriptionUpdateInterval ?? "-"}s</p>
            <p>Timeout: {config?.timeout ?? "-"}s</p>
            <p>Mode: {publicMode ? "Public API" : "Full API"}</p>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Latency Distribution</CardTitle>
            </CardHeader>
            <CardContent className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={filteredProxies.slice(0, 24)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d4d4d4" />
                  <XAxis dataKey="name" hide />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="latencyMs" fill="#0f766e" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Online Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <svg viewBox="0 0 260 70" className="h-[140px] w-full">
                {sparkPath ? <path d={sparkPath} fill="none" stroke="#0f766e" strokeWidth="3" /> : null}
              </svg>
              <p className="text-sm text-muted-foreground">每 15 秒采样在线节点数，使用 D3 曲线平滑。</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Proxy Nodes ({filteredProxies.length}/{proxies.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 md:grid-cols-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="rounded-md border border-border bg-white px-3 py-2 text-sm"
                placeholder="Search by name or stableId"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as "all" | "online" | "offline")}
                title="Status filter"
                aria-label="Status filter"
                className="rounded-md border border-border bg-white px-3 py-2 text-sm"
              >
                <option value="all">All Status</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
              </select>
              <select
                value={subFilter}
                onChange={(e) => setSubFilter(e.target.value)}
                title="Subscription filter"
                aria-label="Subscription filter"
                className="rounded-md border border-border bg-white px-3 py-2 text-sm"
              >
                <option value="all">All Subscriptions</option>
                {subNames.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {filteredProxies.map((proxy) => (
                <div key={proxy.stableId} className="rounded-lg border border-border bg-white/70 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{proxy.name}</p>
                    <Badge variant={proxy.online ? "online" : "offline"}>{proxy.online ? "Online" : "Offline"}</Badge>
                  </div>
                  <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                    <p>Protocol: {proxy.protocol ?? "-"}</p>
                    <p>Subscription: {proxy.subName ?? "-"}</p>
                    <p>Server: {proxy.server ? `${proxy.server}:${proxy.port ?? "-"}` : "hidden"}</p>
                    <p>Proxy Port: {proxy.proxyPort ?? "-"}</p>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span>Latency: {proxy.latencyMs} ms</span>
                    <span className={`font-semibold ${latencyBandClass(proxy.latencyMs)}`}>
                      {latencyBand(proxy.latencyMs)}
                    </span>
                  </div>
                  <a href={`config/${proxy.stableId}`} className="mt-2 block text-xs text-primary underline">
                    Status Endpoint
                  </a>
                </div>
              ))}
              {filteredProxies.length === 0 && !loading ? <p className="text-sm text-muted-foreground">暂无代理数据</p> : null}
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function StatCard({ icon, title, value }: { icon: JSX.Element; title: string; value: string }): JSX.Element {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{title}</p>
          <p className="mt-1 text-2xl font-bold">{value}</p>
        </div>
        <div className="rounded-md bg-primary/10 p-2 text-primary">{icon}</div>
      </CardContent>
    </Card>
  );
}

function latencyBand(latencyMs: number): string {
  if (latencyMs <= 0) {
    return "No Data";
  }
  if (latencyMs < 200) {
    return "Fast";
  }
  if (latencyMs < 800) {
    return "Medium";
  }
  return "Slow";
}

function latencyBandClass(latencyMs: number): string {
  if (latencyMs <= 0) {
    return "text-slate-500";
  }
  if (latencyMs < 200) {
    return "text-emerald-700";
  }
  if (latencyMs < 800) {
    return "text-amber-700";
  }
  return "text-rose-700";
}