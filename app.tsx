import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";

type StatusPayload = Awaited<
  ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>
>;
type StatusData = Extract<StatusPayload, { readonly tracked: unknown }>;
type TrackedItem = StatusData["tracked"][number];
type FilterMode = "scheduled" | "all";

function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (targetMs === null) return "—";
  const diffSec = Math.round((targetMs - nowMs) / 1000);
  if (diffSec <= 0) return "now";
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  if (mins < 60) return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `${hours}h` : `${hours}h ${remMins}m`;
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

function stateBadgeClass(state: TrackedItem["state"]): string {
  switch (state) {
    case "scheduled":
      return "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "compacting":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
    case "compacted":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400";
    case "expired":
    case "skipped":
    case "active":
      return "border-border bg-muted/60 text-muted-foreground";
  }
}

function ttlSourceLabel(source: TrackedItem["ttlSource"]): string {
  switch (source) {
    case "provider-ttl":
      return "exact TTL";
    case "compaction-offer":
      return "offer TTL";
    case "fallback-ttl":
      return "fallback TTL";
    case null:
      return "—";
  }
}

function CacheCompactSettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();

  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>("scheduled");
  const [reconciling, setReconciling] = useState(false);
  const [busyThreads, setBusyThreads] = useState<ReadonlySet<string>>(new Set());
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(() => {
    rpc
      .call("status", null)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [rpc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtime("changed", refresh);

  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(() => {
    const items = data?.tracked ?? [];
    let scheduled = 0;
    let compacted = 0;
    let skipped = 0;
    for (const item of items) {
      if (item.state === "scheduled" || item.state === "compacting") scheduled += 1;
      else if (item.state === "compacted") compacted += 1;
      else skipped += 1;
    }
    return { scheduled, compacted, skipped, total: items.length };
  }, [data]);

  const visibleItems = useMemo(() => {
    const items = data?.tracked ?? [];
    if (filter === "scheduled") {
      return items.filter(
        (item) => item.state === "scheduled" || item.state === "compacting",
      );
    }
    return items;
  }, [data, filter]);

  async function handleReconcile() {
    setReconciling(true);
    try {
      const result = await rpc.call("reconcile", null);
      toast.success(
        `Scanned ${result.scanned} idle threads; ${result.scheduled} scheduled.`,
      );
      refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReconciling(false);
    }
  }

  async function withThreadBusy(threadId: string, action: () => Promise<void>) {
    setBusyThreads((prev) => new Set(prev).add(threadId));
    try {
      await action();
    } finally {
      setBusyThreads((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  }

  async function handleCompactNow(item: TrackedItem) {
    await withThreadBusy(item.threadId, async () => {
      try {
        const result = await rpc.call("compact_now", {
          threadId: item.threadId,
          force: true,
        });
        if (result.compacted) {
          toast.success(`Compaction started (${result.method ?? "native"}).`);
        } else {
          toast.error(result.reason);
        }
        refresh();
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }

  async function handleToggleOptOut(item: TrackedItem) {
    await withThreadBusy(item.threadId, async () => {
      try {
        await rpc.call("set_opt_out", {
          threadId: item.threadId,
          optedOut: !item.optedOut,
        });
        toast.success(
          item.optedOut
            ? "Thread opted back in to pre-expiry compaction."
            : "Thread opted out of pre-expiry compaction.",
        );
        refresh();
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Scheduled
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {counts.scheduled}
          </div>
          <div className="text-[11px] text-muted-foreground">warm idle threads</div>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Compacted
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {counts.compacted}
          </div>
          <div className="text-[11px] text-muted-foreground">tracked runs</div>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Threshold
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {data ? formatTokens(data.config.minTokens) : "—"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {data ? `${data.config.leadMinutes}m before expiry` : "loading"}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Fallback TTL
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">
            {data ? `${data.config.fallbackTtlMinutes}m` : "—"}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {data ? `${data.config.providers.length} providers` : "loading"}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setFilter("scheduled")}
            className={`rounded px-2.5 py-1 font-medium transition-colors ${
              filter === "scheduled"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Scheduled ({counts.scheduled})
          </button>
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded px-2.5 py-1 font-medium transition-colors ${
              filter === "all"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            All tracked ({counts.total})
          </button>
        </div>

        <button
          type="button"
          disabled={reconciling}
          onClick={() => void handleReconcile()}
          className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {reconciling ? "Scanning..." : "Re-scan idle threads"}
        </button>
      </div>

      {error !== null && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {visibleItems.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center">
          <p className="text-sm font-medium text-foreground">
            {filter === "scheduled"
              ? "No threads scheduled for pre-expiry compaction"
              : "No tracked threads yet"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Idle threads on{" "}
            <span className="font-mono">
              {data?.config.providers.join(", ") || "enabled providers"}
            </span>{" "}
            at or above {data ? formatTokens(data.config.minTokens) : "100k"} tokens
            appear here automatically with their cache countdown.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {visibleItems.map((item) => {
            const busy = busyThreads.has(item.threadId);
            return (
              <div
                key={item.threadId}
                className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => navigate.toThread(item.threadId)}
                      className="truncate text-left text-sm font-medium text-foreground hover:underline"
                      title={item.title || item.threadId}
                    >
                      {item.title || item.threadId}
                    </button>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${stateBadgeClass(item.state)}`}
                    >
                      {item.state}
                    </span>
                    {item.optedOut && (
                      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        opted out
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{item.providerId}</span>
                    <span>·</span>
                    <span className="tabular-nums">
                      {formatTokens(item.usedTokens)} tokens
                    </span>
                    {item.method !== null && (
                      <>
                        <span>·</span>
                        <span>
                          {item.method === "slash-command" ? "/compact" : "native"}
                        </span>
                      </>
                    )}
                    {item.ttlSource !== null && (
                      <>
                        <span>·</span>
                        <span>{ttlSourceLabel(item.ttlSource)}</span>
                      </>
                    )}
                  </div>

                  <div className="text-xs text-muted-foreground">
                    {item.state === "scheduled" && item.compactAtMs !== null ? (
                      <span>
                        Compacts in{" "}
                        <strong className="font-medium tabular-nums text-foreground">
                          {formatCountdown(item.compactAtMs, nowMs)}
                        </strong>
                        {item.expiresAtMs !== null && (
                          <>
                            {" "}
                            · cache expires in{" "}
                            <span className="tabular-nums">
                              {formatCountdown(item.expiresAtMs, nowMs)}
                            </span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span>{item.lastReason ?? item.state}</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy || item.state === "compacting"}
                    onClick={() => void handleCompactNow(item)}
                    className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    Compact now
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleToggleOptOut(item)}
                    className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    {item.optedOut ? "Opt in" : "Opt out"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "schedule",
    title: "Scheduled & tracked threads",
    description:
      "Live countdowns before prompt cache expiry, with one-click compaction and per-thread opt-out.",
    component: CacheCompactSettingsSection,
  });
});
