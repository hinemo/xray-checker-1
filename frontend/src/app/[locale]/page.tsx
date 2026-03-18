"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Gauge,
  Globe2,
  RefreshCw,
  ShieldCheck,
  Server,
  LayoutDashboard,
  Layers,
  BarChart3,
  ListChecks,
  X,
  Copy,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

import {
  addSubscription,
  getActionLogs,
  deleteSubscription,
  getDashboardSnapshot,
  getScheduleSettings,
  getSubscriptionGroups,
  getSubscriptions,
  refreshSubscription,
  triggerCheck,
  triggerReload,
  updateScheduleSettings,
  type ProxyInfo,
  type PublicProxyInfo,
  type ScheduleSettings,
  type SubscriptionGroup,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

function StatCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="flex items-center justify-between gap-3 p-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {title}
          </p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
        </div>
        <div className="rounded-2xl bg-primary/10 p-3 text-primary">{icon}</div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ online, label }: { online: boolean; label: string }) {
  return <Badge variant={online ? "online" : "offline"}>{label}</Badge>;
}

function getProxyName(proxy: ProxyInfo | PublicProxyInfo) {
  return proxy.name || proxy.stableId;
}

function formatTimestamp(value: string | undefined, locale: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getActionStatusVariant(status: string) {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "started") return "started";
  return "neutral";
}

export default function DashboardPage() {
  const t = useTranslations();
  const locale = useLocale();
  const switchTo = locale === "zh" ? "en" : "zh";
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline">("all");
  const [subFilter, setSubFilter] = useState("all");
  const [history, setHistory] = useState<Array<{ time: string; online: number }>>([]);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [actionMessage, setActionMessage] = useState<string>("");
  const [actionError, setActionError] = useState<string>("");
  const [isActionBusy, setIsActionBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeProxy, setActiveProxy] = useState<ProxyInfo | PublicProxyInfo | null>(null);
  const [subscriptionInput, setSubscriptionInput] = useState("");
  const [isSubscriptionBusy, setIsSubscriptionBusy] = useState(false);
  const [autoFetchEnabled, setAutoFetchEnabled] = useState(false);
  const [autoCheckEnabled, setAutoCheckEnabled] = useState(false);
  const [autoFetchMinutes, setAutoFetchMinutes] = useState(30);
  const [autoCheckMinutes, setAutoCheckMinutes] = useState(5);
  const [nextFetchAt, setNextFetchAt] = useState<string>("");
  const [nextCheckAt, setNextCheckAt] = useState<string>("");
  const [fetchRuns, setFetchRuns] = useState(0);
  const [fetchFails, setFetchFails] = useState(0);
  const [checkRuns, setCheckRuns] = useState(0);
  const [checkFails, setCheckFails] = useState(0);
  const [lastFetchResult, setLastFetchResult] = useState<string>("");
  const [lastCheckResult, setLastCheckResult] = useState<string>("");
  const [scheduleSource, setScheduleSource] = useState<"db" | "local">("local");
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleSavedAt, setScheduleSavedAt] = useState<string>("");
  const [isScheduleSaving, setIsScheduleSaving] = useState(false);
  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);
  const [actionFilter, setActionFilter] = useState("all");
  const [actionStatusFilter, setActionStatusFilter] = useState("all");
  const [actionQuery, setActionQuery] = useState("");

  const skipScheduleSaveRef = useRef(true);

  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboardSnapshot,
    refetchInterval: 15000,
  });

  const { data: subscriptions, isLoading: isSubscriptionsLoading } = useQuery({
    queryKey: ["subscriptions"],
    queryFn: getSubscriptions,
  });

  const { data: subscriptionGroups } = useQuery({
    queryKey: ["subscription-groups"],
    queryFn: getSubscriptionGroups,
    refetchInterval: 15000,
  });

  const { data: scheduleSettings } = useQuery({
    queryKey: ["schedule-settings"],
    queryFn: getScheduleSettings,
    retry: false,
  });

  const { data: actionLogs } = useQuery({
    queryKey: ["action-logs", actionFilter, actionStatusFilter, actionQuery],
    queryFn: () =>
      getActionLogs({
        action: actionFilter === "all" ? undefined : actionFilter,
        status: actionStatusFilter === "all" ? undefined : actionStatusFilter,
        query: actionQuery || undefined,
        limit: 50,
      }),
    refetchInterval: 15000,
  });

  const proxies = (data?.proxies ?? []) as Array<ProxyInfo | PublicProxyInfo>;
  const status = data?.status;
  const onlineRate = status && status.total > 0 ? Math.round((status.online / status.total) * 100) : 0;

  const subscriptionNames = useMemo(() => {
    const names = new Set<string>();
    proxies.forEach((proxy) => {
      if ("subName" in proxy && typeof proxy.subName === "string" && proxy.subName) {
        names.add(proxy.subName);
      }
    });
    return Array.from(names);
  }, [proxies]);

  const groupedSubscriptions = useMemo<SubscriptionGroup[]>(() => {
    if (subscriptionGroups && subscriptionGroups.length > 0) {
      return subscriptionGroups;
    }

    const map = new Map<string, number>();
    proxies.forEach((proxy) => {
      if ("subName" in proxy && proxy.subName) {
        map.set(proxy.subName, (map.get(proxy.subName) ?? 0) + 1);
      }
    });

    return Array.from(map.entries()).map(([name, nodeCount]) => ({
      name,
      nodeCount,
    }));
  }, [subscriptionGroups, proxies]);

  const actionOptions = useMemo(() => {
    if (!actionLogs) return [];
    const set = new Set<string>();
    actionLogs.forEach((log) => set.add(log.action));
    return Array.from(set.values()).sort();
  }, [actionLogs]);

  const filteredProxies = useMemo(() => {
    return proxies.filter((proxy) => {
      const name = getProxyName(proxy).toLowerCase();
      const searchHit = name.includes(search.toLowerCase()) || proxy.stableId.includes(search);
      const statusHit =
        statusFilter === "all" || (statusFilter === "online" ? proxy.online : !proxy.online);
      const subName = "subName" in proxy ? proxy.subName : "";
      const subHit = subFilter === "all" || subName === subFilter;
      return searchHit && statusHit && subHit;
    });
  }, [proxies, search, statusFilter, subFilter]);

  const allSelected = filteredProxies.length > 0 && filteredProxies.every((proxy) => selectedIds.includes(proxy.stableId));

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => filteredProxies.some((proxy) => proxy.stableId === id)));
  }, [filteredProxies]);

  const chartData = useMemo(() => {
    return filteredProxies.slice(0, 12).map((proxy) => ({
      name: getProxyName(proxy),
      latency: proxy.latencyMs,
    }));
  }, [filteredProxies]);

  useEffect(() => {
    if (!status) return;
    const now = new Date();
    const time = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    setHistory((prev) => {
      const next = [...prev, { time, online: status.online }];
      return next.slice(-24);
    });
    setLastUpdated(time);
  }, [status, locale]);

  useEffect(() => {
    const onUpdate = () => setSwUpdateAvailable(true);
    window.addEventListener("swUpdated", onUpdate as EventListener);
    return () => window.removeEventListener("swUpdated", onUpdate as EventListener);
  }, []);

  useEffect(() => {
    if (scheduleSettings) {
      setScheduleSource("db");
      setAutoFetchEnabled(scheduleSettings.autoFetchEnabled);
      setAutoFetchMinutes(scheduleSettings.autoFetchMinutes);
      setAutoCheckEnabled(scheduleSettings.autoCheckEnabled);
      setAutoCheckMinutes(scheduleSettings.autoCheckMinutes);
      setScheduleSavedAt(scheduleSettings.updatedAt ?? "");
      setScheduleLoaded(true);
      skipScheduleSaveRef.current = true;
      return;
    }

    if (scheduleSettings === null) {
      const savedFetchEnabled = localStorage.getItem("xray.autoFetchEnabled");
      const savedCheckEnabled = localStorage.getItem("xray.autoCheckEnabled");
      const savedFetchMinutes = localStorage.getItem("xray.autoFetchMinutes");
      const savedCheckMinutes = localStorage.getItem("xray.autoCheckMinutes");

      setScheduleSource("local");
      if (savedFetchEnabled !== null) setAutoFetchEnabled(savedFetchEnabled === "true");
      if (savedCheckEnabled !== null) setAutoCheckEnabled(savedCheckEnabled === "true");
      if (savedFetchMinutes) setAutoFetchMinutes(Number(savedFetchMinutes));
      if (savedCheckMinutes) setAutoCheckMinutes(Number(savedCheckMinutes));
      setScheduleLoaded(true);
      skipScheduleSaveRef.current = true;
    }
  }, [scheduleSettings]);

  useEffect(() => {
    if (scheduleSource !== "local") return;
    localStorage.setItem("xray.autoFetchEnabled", String(autoFetchEnabled));
    localStorage.setItem("xray.autoCheckEnabled", String(autoCheckEnabled));
    localStorage.setItem("xray.autoFetchMinutes", String(autoFetchMinutes));
    localStorage.setItem("xray.autoCheckMinutes", String(autoCheckMinutes));
  }, [autoFetchEnabled, autoCheckEnabled, autoFetchMinutes, autoCheckMinutes, scheduleSource]);

  useEffect(() => {
    if (!scheduleLoaded || scheduleSource !== "db") return;
    if (skipScheduleSaveRef.current) {
      skipScheduleSaveRef.current = false;
      return;
    }
    setIsScheduleSaving(true);
    const timer = window.setTimeout(async () => {
      setScheduleError("");
      try {
        const payload: ScheduleSettings = {
          autoFetchEnabled,
          autoFetchMinutes,
          autoCheckEnabled,
          autoCheckMinutes,
        };
        await updateScheduleSettings(payload);
        setScheduleSavedAt(new Date().toISOString());
      } catch (err) {
        setScheduleError(err instanceof Error ? err.message : t("schedule.saveFailed"));
      } finally {
        setIsScheduleSaving(false);
      }
    }, 600);

    return () => window.clearTimeout(timer);
  }, [
    autoFetchEnabled,
    autoFetchMinutes,
    autoCheckEnabled,
    autoCheckMinutes,
    scheduleLoaded,
    scheduleSource,
    t,
  ]);

  useEffect(() => {
    if (!autoFetchEnabled) {
      setNextFetchAt("");
      return undefined;
    }
    const intervalMs = Math.max(1, autoFetchMinutes) * 60 * 1000;
    const scheduleNext = () => {
      const next = new Date(Date.now() + intervalMs);
      setNextFetchAt(next.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
    };
    scheduleNext();
    const timer = window.setInterval(async () => {
      await runScheduledFetch();
      scheduleNext();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoFetchEnabled, autoFetchMinutes, locale]);

  useEffect(() => {
    if (!autoCheckEnabled) {
      setNextCheckAt("");
      return undefined;
    }
    const intervalMs = Math.max(1, autoCheckMinutes) * 60 * 1000;
    const scheduleNext = () => {
      const next = new Date(Date.now() + intervalMs);
      setNextCheckAt(next.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
    };
    scheduleNext();
    const timer = window.setInterval(async () => {
      await runScheduledCheck();
      scheduleNext();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [autoCheckEnabled, autoCheckMinutes, locale]);

  const handleManualCheck = async (): Promise<boolean> => {
    setIsActionBusy(true);
    setActionError("");
    try {
      const message = await triggerCheck();
      setActionMessage(message || t("actions.checkSuccess"));
      setTimeout(() => {
        void refetch();
      }, 1000);
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("actions.checkFailed"));
      return false;
    } finally {
      setIsActionBusy(false);
    }
  };

  const handleManualReload = async () => {
    setIsActionBusy(true);
    setActionError("");
    try {
      const message = await triggerReload();
      setActionMessage(message || t("actions.reloadSuccess"));
      setTimeout(() => {
        void refetch();
      }, 1000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("actions.reloadFailed"));
    } finally {
      setIsActionBusy(false);
    }
  };

  const handleAddSubscription = async () => {
    if (!subscriptionInput.trim()) {
      setActionError(t("subscriptions.invalid"));
      return;
    }
    setIsSubscriptionBusy(true);
    setActionError("");
    try {
      const message = await addSubscription(subscriptionInput.trim());
      setActionMessage(message || t("subscriptions.added"));
      setSubscriptionInput("");
      await queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("subscriptions.addFailed"));
    } finally {
      setIsSubscriptionBusy(false);
    }
  };

  const handleDeleteSubscription = async (url: string) => {
    setIsSubscriptionBusy(true);
    setActionError("");
    try {
      const message = await deleteSubscription(url);
      setActionMessage(message || t("subscriptions.deleted"));
      await queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("subscriptions.deleteFailed"));
    } finally {
      setIsSubscriptionBusy(false);
    }
  };

  const handleRefreshSubscription = async (url: string) => {
    setIsSubscriptionBusy(true);
    setActionError("");
    try {
      const message = await refreshSubscription(url);
      setActionMessage(message || t("subscriptions.refreshed"));
      setTimeout(() => {
        void refetch();
      }, 1000);
      await queryClient.invalidateQueries({ queryKey: ["subscription-groups"] });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("subscriptions.refreshFailed"));
    } finally {
      setIsSubscriptionBusy(false);
    }
  };

  const handleActivateSubscriptions = async (): Promise<boolean> => {
    setIsSubscriptionBusy(true);
    setActionError("");
    try {
      const message = await triggerReload();
      setActionMessage(message || t("subscriptions.activated"));
      setTimeout(() => {
        void refetch();
      }, 1000);
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("subscriptions.activateFailed"));
      return false;
    } finally {
      setIsSubscriptionBusy(false);
    }
  };

  const runScheduledFetch = async () => {
    const ok = await handleActivateSubscriptions();
    setFetchRuns((prev) => prev + 1);
    if (!ok) {
      setFetchFails((prev) => prev + 1);
    }
    setLastFetchResult(ok ? t("schedule.lastSuccess") : t("schedule.lastFailed"));
  };

  const runScheduledCheck = async () => {
    const ok = await handleManualCheck();
    setCheckRuns((prev) => prev + 1);
    if (!ok) {
      setCheckFails((prev) => prev + 1);
    }
    setLastCheckResult(ok ? t("schedule.lastSuccess") : t("schedule.lastFailed"));
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredProxies.map((proxy) => proxy.stableId));
    }
  };

  const toggleSelectOne = (stableId: string) => {
    setSelectedIds((prev) => (prev.includes(stableId) ? prev.filter((id) => id !== stableId) : [...prev, stableId]));
  };

  const handleCopySelected = async () => {
    try {
      await navigator.clipboard.writeText(selectedIds.join("\n"));
      setActionMessage(t("actions.copySuccess"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("actions.copyFailed"));
    }
  };

  const navItems = [
    { id: "overview", label: t("nav.overview"), icon: LayoutDashboard },
    { id: "runtime", label: t("nav.runtime"), icon: Layers },
    { id: "trend", label: t("nav.trend"), icon: BarChart3 },
    { id: "nodes", label: t("nav.nodes"), icon: ListChecks },
    { id: "filters", label: t("nav.filters"), icon: Gauge },
    { id: "subscriptions", label: t("nav.subscriptions"), icon: Server },
    { id: "actions", label: t("nav.actions"), icon: Activity },
  ];

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 md:px-8 lg:flex-row">
        <aside className="hidden w-60 shrink-0 flex-col gap-4 lg:flex">
          <div className="rounded-3xl border border-border/60 bg-white/70 p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              {t("app.subtitle")}
            </p>
            <h2 className="mt-2 text-xl font-bold">{t("app.title")}</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("stats.onlineRate")}: {onlineRate}%
            </p>
          </div>
          <nav className="rounded-3xl border border-border/60 bg-white/70 p-3 shadow-sm">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </a>
              );
            })}
          </nav>
        </aside>

        <main className="flex-1">
          <section className="flex w-full flex-col gap-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                  {t("app.subtitle")}
                </p>
                <h1 className="mt-2 text-3xl font-black tracking-tight md:text-5xl">
                  {t("app.title")}
                </h1>
                {data?.publicMode ? (
                  <p className="mt-2 text-sm text-amber-600">{t("app.publicMode")}</p>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  {isLoading ? t("app.loading") : `${t("app.lastUpdated")}: ${lastUpdated || "-"}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="/api/v1/docs"
                  className="rounded-full border border-border bg-white/70 px-4 py-2 text-sm font-semibold"
                >
                  {t("app.apiDocs")}
                </a>
                <Button variant="outline" onClick={handleManualCheck} disabled={isActionBusy}>
                  <Activity className="mr-2 h-4 w-4" />
                  {t("actions.check")}
                </Button>
                <Button variant="outline" onClick={handleManualReload} disabled={isActionBusy}>
                  <Server className="mr-2 h-4 w-4" />
                  {t("actions.reload")}
                </Button>
                <Link
                  href={`/${switchTo}/`}
                  className="rounded-full border border-border px-4 py-2 text-sm font-semibold text-foreground"
                >
                  {switchTo.toUpperCase()}
                </Link>
                <Button variant="outline" onClick={() => void refetch()} disabled={isLoading}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t("app.refresh")}
                </Button>
              </div>
            </header>

            {swUpdateAvailable ? (
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                  <span>{t("pwa.updateReady")}</span>
                  <Button
                    variant="outline"
                    onClick={() => window.location.reload()}
                  >
                    {t("pwa.reload")}
                  </Button>
                </CardContent>
              </Card>
            ) : null}

            {actionError ? (
              <Card>
                <CardContent className="p-6 text-rose-700">{actionError}</CardContent>
              </Card>
            ) : null}

            {actionMessage ? (
              <Card>
                <CardContent className="p-6 text-emerald-700">{actionMessage}</CardContent>
              </Card>
            ) : null}

            {scheduleError ? (
              <Card>
                <CardContent className="p-6 text-rose-700">{scheduleError}</CardContent>
              </Card>
            ) : null}

            {error ? (
              <Card>
                <CardContent className="p-6 text-rose-700">{String(error)}</CardContent>
              </Card>
            ) : null}

            <div id="overview" className="grid gap-4 md:grid-cols-4">
              <StatCard title={t("stats.onlineRate")} value={`${onlineRate}%`} icon={<ShieldCheck className="h-5 w-5" />} />
              <StatCard title={t("stats.online")} value={String(status?.online ?? 0)} icon={<Activity className="h-5 w-5" />} />
              <StatCard title={t("stats.avgLatency")} value={`${status?.avgLatencyMs ?? 0}ms`} icon={<Gauge className="h-5 w-5" />} />
              <StatCard title={t("stats.currentIp")} value={data?.systemIP?.ip ?? "-"} icon={<Globe2 className="h-5 w-5" />} />
            </div>

            <Card id="runtime">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Server className="h-5 w-5" />
                  {t("sections.runtime")}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm md:grid-cols-4">
                <p>{t("runtime.version")}: {data?.systemInfo?.version ?? "-"}</p>
                <p>{t("runtime.uptime")}: {data?.systemInfo?.uptime ?? "-"}</p>
                <p>{t("runtime.method")}: {data?.config?.checkMethod ?? "-"}</p>
                <p>{t("runtime.interval")}: {data?.config?.checkInterval ?? "-"}s</p>
                <p>{t("runtime.timeout")}: {data?.config?.timeout ?? "-"}s</p>
                <p>{t("runtime.startPort")}: {data?.config?.startPort ?? "-"}</p>
                <p>{t("runtime.updates")}: {data?.config?.subscriptionUpdate ? t("runtime.on") : t("runtime.off")}</p>
                <p>{t("runtime.updateEvery")}: {data?.config?.subscriptionUpdateInterval ?? "-"}s</p>
              </CardContent>
            </Card>

            <Card id="filters">
              <CardHeader>
                <CardTitle className="text-lg">{t("nav.filters")}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    {t("filters.search")}
                  </p>
                  <Input
                    placeholder={t("filters.searchPlaceholder")}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    {t("filters.status")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(["all", "online", "offline"] as const).map((option) => (
                      <Button
                        key={option}
                        variant={statusFilter === option ? "default" : "outline"}
                        size="sm"
                        onClick={() => setStatusFilter(option)}
                      >
                        {t(`filters.${option}`)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    {t("filters.subscription")}
                  </p>
                  <select
                    className="h-10 w-full rounded-md border border-border bg-white/70 px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    value={subFilter}
                    onChange={(event) => setSubFilter(event.target.value)}
                    aria-label={t("filters.subscription")}
                  >
                    <option value="all">{t("filters.all")}</option>
                    {subscriptionNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>

            <Card id="subscriptions">
              <CardHeader>
                <CardTitle className="text-lg">{t("subscriptions.title")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 rounded-2xl border border-border bg-white/70 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-foreground">{t("schedule.autoFetch")}</p>
                      <p className="text-xs text-muted-foreground">{t("schedule.autoFetchHint")}</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={autoFetchEnabled}
                        onChange={(event) => setAutoFetchEnabled(event.target.checked)}
                      />
                      {t("schedule.enabled")}
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      value={autoFetchMinutes}
                      onChange={(event) => setAutoFetchMinutes(Number(event.target.value))}
                    />
                    <span className="text-xs text-muted-foreground">{t("schedule.minutes")}</span>
                    {nextFetchAt ? (
                      <span className="text-xs text-muted-foreground">
                        {t("schedule.nextRun")}: {nextFetchAt}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <span>{t("schedule.runs")}: {fetchRuns}</span>
                    <span>{t("schedule.failures")}: {fetchFails}</span>
                    {lastFetchResult ? <span>{t("schedule.lastResult")}: {lastFetchResult}</span> : null}
                  </div>
                  {scheduleLoaded ? (
                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <span>
                        {t("schedule.storage")}: {scheduleSource === "db" ? t("schedule.db") : t("schedule.local")}
                      </span>
                      <span>
                        {t("schedule.savedAt")}: {formatTimestamp(scheduleSavedAt, locale)}
                      </span>
                      {isScheduleSaving ? <span>{t("schedule.saving")}</span> : null}
                    </div>
                  ) : null}
                  {scheduleLoaded && scheduleSource !== "db" ? (
                    <p className="text-xs text-amber-700">{t("schedule.localHint")}</p>
                  ) : null}
                </div>

                <div className="grid gap-3 rounded-2xl border border-border bg-white/70 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium text-foreground">{t("schedule.autoCheck")}</p>
                      <p className="text-xs text-muted-foreground">{t("schedule.autoCheckHint")}</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={autoCheckEnabled}
                        onChange={(event) => setAutoCheckEnabled(event.target.checked)}
                      />
                      {t("schedule.enabled")}
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      value={autoCheckMinutes}
                      onChange={(event) => setAutoCheckMinutes(Number(event.target.value))}
                    />
                    <span className="text-xs text-muted-foreground">{t("schedule.minutes")}</span>
                    {nextCheckAt ? (
                      <span className="text-xs text-muted-foreground">
                        {t("schedule.nextRun")}: {nextCheckAt}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <span>{t("schedule.runs")}: {checkRuns}</span>
                    <span>{t("schedule.failures")}: {checkFails}</span>
                    {lastCheckResult ? <span>{t("schedule.lastResult")}: {lastCheckResult}</span> : null}
                  </div>
                </div>

                {groupedSubscriptions.length > 0 ? (
                  <div className="rounded-2xl border border-border bg-white/70 p-4">
                    <p className="text-sm font-semibold text-foreground">{t("subscriptions.groupsTitle")}</p>
                    <div className="mt-3 overflow-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="text-muted-foreground">
                          <tr className="border-b border-border">
                            <th className="py-2 pr-4">{t("subscriptions.groupName")}</th>
                            <th className="py-2 pr-4">{t("subscriptions.groupNodes")}</th>
                            <th className="py-2 pr-4">{t("subscriptions.groupUpdated")}</th>
                            <th className="py-2">{t("subscriptions.groupChecked")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupedSubscriptions.map((group) => (
                            <tr key={group.name} className="border-b border-border/60 hover:bg-muted/40">
                              <td className="py-2 pr-4 font-medium">{group.name}</td>
                              <td className="py-2 pr-4">{group.nodeCount}</td>
                              <td className="py-2 pr-4">
                                {formatTimestamp(group.lastUpdatedAt, locale)}
                              </td>
                              <td className="py-2">
                                {formatTimestamp(group.lastCheckedAt, locale)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={handleActivateSubscriptions}
                    disabled={isSubscriptionBusy}
                  >
                    {t("subscriptions.activate")}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t("subscriptions.activateHint")}
                  </span>
                </div>
                {subscriptions === null && !isSubscriptionsLoading ? (
                  <p className="text-sm text-muted-foreground">{t("subscriptions.unavailable")}</p>
                ) : null}

                {subscriptions && subscriptions.length === 0 && !isSubscriptionsLoading ? (
                  <p className="text-sm text-muted-foreground">{t("subscriptions.empty")}</p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Input
                    placeholder={t("subscriptions.placeholder")}
                    value={subscriptionInput}
                    onChange={(event) => setSubscriptionInput(event.target.value)}
                  />
                  <Button
                    variant="outline"
                    onClick={handleAddSubscription}
                    disabled={isSubscriptionBusy}
                  >
                    {t("subscriptions.add")}
                  </Button>
                </div>

                {subscriptions && subscriptions.length > 0 ? (
                  <div className="space-y-2">
                    {subscriptions.map((url) => (
                      <div
                        key={url}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-muted/30 px-3 py-2"
                      >
                        <span className="text-sm text-foreground break-all">{url}</span>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRefreshSubscription(url)}
                            disabled={isSubscriptionBusy}
                          >
                            {t("subscriptions.refresh")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDeleteSubscription(url)}
                            disabled={isSubscriptionBusy}
                          >
                            {t("subscriptions.delete")}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card id="actions">
              <CardHeader>
                <CardTitle className="text-lg">{t("actionsLog.title")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid gap-3 rounded-2xl border border-border bg-white/70 p-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      {t("actionsLog.filterAction")}
                    </p>
                    <select
                      className="h-10 w-full rounded-md border border-border bg-white/70 px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      value={actionFilter}
                      onChange={(event) => setActionFilter(event.target.value)}
                      aria-label={t("actionsLog.filterAction")}
                    >
                      <option value="all">{t("actionsLog.filterAll")}</option>
                      {actionOptions.map((action) => (
                        <option key={action} value={action}>
                          {action}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      {t("actionsLog.filterStatus")}
                    </p>
                    <select
                      className="h-10 w-full rounded-md border border-border bg-white/70 px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      value={actionStatusFilter}
                      onChange={(event) => setActionStatusFilter(event.target.value)}
                      aria-label={t("actionsLog.filterStatus")}
                    >
                      <option value="all">{t("actionsLog.filterAll")}</option>
                      <option value="success">{t("actionsLog.statusSuccess")}</option>
                      <option value="failed">{t("actionsLog.statusFailed")}</option>
                      <option value="started">{t("actionsLog.statusStarted")}</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      {t("actionsLog.filterQuery")}
                    </p>
                    <Input
                      placeholder={t("actionsLog.filterQueryPlaceholder")}
                      value={actionQuery}
                      onChange={(event) => setActionQuery(event.target.value)}
                    />
                  </div>
                </div>
                {actionLogs === null ? (
                  <p className="text-muted-foreground">{t("actionsLog.unavailable")}</p>
                ) : null}
                {actionLogs && actionLogs.length === 0 ? (
                  <p className="text-muted-foreground">{t("actionsLog.empty")}</p>
                ) : null}
                {actionLogs && actionLogs.length > 0 ? (
                  <div className="space-y-2">
                    {actionLogs.map((log) => (
                      <div
                        key={log.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-muted/30 px-3 py-2"
                      >
                        <div className="space-y-1">
                          <p className="font-medium text-foreground">{log.action}</p>
                          <p className="text-xs text-muted-foreground">{log.message || "-"}</p>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant={getActionStatusVariant(log.status)}>
                            {log.status === "success"
                              ? t("actionsLog.statusSuccess")
                              : log.status === "failed"
                                ? t("actionsLog.statusFailed")
                                : log.status === "started"
                                  ? t("actionsLog.statusStarted")
                                  : log.status}
                          </Badge>
                          <span>{formatTimestamp(log.createdAt, locale)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {filteredProxies.length === 0 && !isLoading ? (
              <Card>
                <CardContent className="p-6">
                  <p className="text-lg font-semibold">{t("empty.title")}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{t("empty.body")}</p>
                </CardContent>
              </Card>
            ) : null}

            <div id="trend" className="grid gap-4 lg:grid-cols-5">
              <Card className="lg:col-span-3">
                <CardHeader>
                  <CardTitle className="text-lg">{t("sections.latency")}</CardTitle>
                </CardHeader>
                <CardContent className="h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#d4d4d4" />
                      <XAxis dataKey="name" hide />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="latency" fill="#0ea5e9" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg">{t("sections.trend")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-[160px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={history}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#d4d4d4" />
                        <XAxis dataKey="time" hide />
                        <YAxis allowDecimals={false} />
                        <Tooltip />
                        <Line type="monotone" dataKey="online" stroke="#f97316" strokeWidth={3} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                    <p>{t("runtime.total")}: {status?.total ?? 0}</p>
                    <p>{t("stats.online")}: {status?.online ?? 0}</p>
                    <p>{t("stats.offline")}: {status?.offline ?? 0}</p>
                    <p>{t("stats.avgLatency")}: {status?.avgLatencyMs ?? 0}ms</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card id="nodes">
              <CardHeader>
                <CardTitle className="text-lg">
                  {t("sections.nodes")} ({filteredProxies.length}/{proxies.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-auto">
                {selectedIds.length > 0 ? (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm">
                    <p>
                      {t("bulk.selected")}: {selectedIds.length}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={handleCopySelected}>
                        <Copy className="mr-2 h-4 w-4" />
                        {t("actions.copy")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setSelectedIds([])}>
                        <X className="mr-2 h-4 w-4" />
                        {t("actions.clear")}
                      </Button>
                    </div>
                  </div>
                ) : null}
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="py-2 pr-4">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          aria-label={t("bulk.selectAll")}
                        />
                      </th>
                      <th className="py-2 pr-4">{t("table.name")}</th>
                      <th className="py-2 pr-4">{t("table.status")}</th>
                      <th className="py-2 pr-4">{t("table.latency")}</th>
                      <th className="py-2">{t("table.sub")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProxies.map((proxy) => {
                      const name = getProxyName(proxy);
                      const subscription =
                        "subName" in proxy && typeof proxy.subName === "string" ? proxy.subName : "-";
                      const label = proxy.online ? t("status.online") : t("status.offline");

                      return (
                        <tr
                          key={proxy.stableId}
                          className="cursor-pointer border-b border-border/60 hover:bg-muted/40"
                          onClick={() => setActiveProxy(proxy)}
                        >
                          <td className="py-3 pr-4" onClick={(event) => event.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(proxy.stableId)}
                              onChange={() => toggleSelectOne(proxy.stableId)}
                              aria-label={proxy.stableId}
                            />
                          </td>
                          <td className="py-3 pr-4 font-medium">{name}</td>
                          <td className="py-3 pr-4">
                            <StatusBadge online={proxy.online} label={label} />
                          </td>
                          <td className="py-3 pr-4">{proxy.latencyMs}ms</td>
                          <td className="py-3">{subscription || "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </section>
        </main>
      </div>

      {activeProxy ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-3xl border border-border bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{t("details.title")}</h3>
              <button
                className="rounded-full border border-border p-2 text-muted-foreground hover:text-foreground"
                onClick={() => setActiveProxy(null)}
                aria-label={t("details.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 space-y-2 text-sm text-muted-foreground">
              <p><span className="text-foreground">{t("details.name")}:</span> {getProxyName(activeProxy)}</p>
              <p><span className="text-foreground">{t("details.id")}:</span> {activeProxy.stableId}</p>
              <p><span className="text-foreground">{t("details.status")}:</span> {activeProxy.online ? t("status.online") : t("status.offline")}</p>
              <p><span className="text-foreground">{t("details.latency")}:</span> {activeProxy.latencyMs}ms</p>
              {"server" in activeProxy ? (
                <p><span className="text-foreground">{t("details.server")}:</span> {activeProxy.server || "-"}</p>
              ) : null}
              {"protocol" in activeProxy ? (
                <p><span className="text-foreground">{t("details.protocol")}:</span> {activeProxy.protocol || "-"}</p>
              ) : null}
              {"port" in activeProxy ? (
                <p><span className="text-foreground">{t("details.port")}:</span> {activeProxy.port ?? "-"}</p>
              ) : null}
              {"proxyPort" in activeProxy ? (
                <p><span className="text-foreground">{t("details.proxyPort")}:</span> {activeProxy.proxyPort ?? "-"}</p>
              ) : null}
              {"subName" in activeProxy ? (
                <p><span className="text-foreground">{t("details.subscription")}:</span> {activeProxy.subName || "-"}</p>
              ) : null}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(activeProxy.stableId);
                  setActionMessage(t("actions.copySuccess"));
                }}
              >
                <Copy className="mr-2 h-4 w-4" />
                {t("actions.copy")}
              </Button>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const detail = {
                        name: getProxyName(activeProxy),
                        stableId: activeProxy.stableId,
                        online: activeProxy.online,
                        latencyMs: activeProxy.latencyMs,
                        server: "server" in activeProxy ? activeProxy.server : undefined,
                        protocol: "protocol" in activeProxy ? activeProxy.protocol : undefined,
                        port: "port" in activeProxy ? activeProxy.port : undefined,
                        proxyPort: "proxyPort" in activeProxy ? activeProxy.proxyPort : undefined,
                        subscription: "subName" in activeProxy ? activeProxy.subName : undefined,
                      };
                      await navigator.clipboard.writeText(JSON.stringify(detail, null, 2));
                      setActionMessage(t("actions.copyDetailSuccess"));
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    {t("actions.copyDetail")}
                  </Button>
              <Button onClick={() => setActiveProxy(null)}>{t("details.close")}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
