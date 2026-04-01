import { useState } from "react";
import { useLastLoadable, useGet, useLastResolved } from "ccstate-react";
import { IconWorldWww, IconChartLine } from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton,
} from "@vm0/ui";
import { FeatureSwitchKey, type NetworkLogEntry } from "@vm0/core";
import { Link } from "../router/link.tsx";
import { currentRunId$ } from "../../signals/activity-page/activity-signals.ts";
import { zeroActivityNetworkLogs$ } from "../../signals/activity-page/activity-network-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(timestamp: string): string {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatSize(bytes: number | undefined | null): string {
  if (bytes === null || bytes === undefined) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatLatency(ms: number | undefined | null): string {
  if (ms === null || ms === undefined) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function entryType(entry: NetworkLogEntry): string {
  if (entry.action === "DENY") {
    return "DENY";
  }
  if (entry.type === "tcp") {
    return "TCP";
  }
  if (entry.type && entry.type !== "http") {
    return entry.type.toUpperCase();
  }
  return "HTTP";
}

function typeColor(type: string): string {
  if (type === "HTTP") {
    return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
  }
  if (type === "TCP") {
    return "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400";
  }
  if (type === "UDP" || type === "ICMP") {
    return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  }
  if (type === "DENY") {
    return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
  }
  return "bg-muted text-muted-foreground";
}

function statusColor(status: number | undefined): string {
  if (!status) {
    return "text-muted-foreground";
  }
  if (status < 300) {
    return "text-green-600 dark:text-green-400";
  }
  if (status < 400) {
    return "text-yellow-600 dark:text-yellow-400";
  }
  return "text-red-600 dark:text-red-400";
}

function latencyColor(ms: number | undefined | null): string {
  if (ms === null || ms === undefined) {
    return "text-muted-foreground";
  }
  if (ms < 500) {
    return "text-green-600 dark:text-green-400";
  }
  if (ms < 2000) {
    return "text-yellow-600 dark:text-yellow-400";
  }
  return "text-red-600 dark:text-red-400";
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function TypeBadge({ type }: { type: string }) {
  const color = typeColor(type);
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${color}`}
    >
      {type}
    </span>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatParams(params: Record<string, string> | undefined): string {
  if (!params) {
    return "—";
  }
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([, v]) => {
      return v !== null && v !== undefined;
    }),
  );
  if (Object.keys(filtered).length === 0) {
    return "—";
  }
  return JSON.stringify(filtered);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function addField(
  out: [string, string][],
  label: string,
  raw: unknown,
  formatted: string,
): void {
  if (hasValue(raw)) {
    out.push([label, formatted]);
  }
}

function collectDetails(entry: NetworkLogEntry): [string, string][] {
  const out: [string, string][] = [];
  addField(out, "Timestamp", entry.timestamp, entry.timestamp);
  addField(out, "Type", entry.type, formatValue(entry.type));
  addField(out, "Action", entry.action, formatValue(entry.action));
  addField(out, "Method", entry.method, formatValue(entry.method));
  addField(out, "URL", entry.url, formatValue(entry.url));
  addField(out, "Host", entry.host, formatValue(entry.host));
  addField(out, "Port", entry.port, formatValue(entry.port));
  addField(out, "Status", entry.status, formatValue(entry.status));
  addField(out, "Latency", entry.latency_ms, formatLatency(entry.latency_ms));
  addField(
    out,
    "Request Size",
    entry.request_size,
    formatSize(entry.request_size),
  );
  addField(
    out,
    "Response Size",
    entry.response_size,
    formatSize(entry.response_size),
  );
  addField(
    out,
    "Firewall",
    entry.firewall_name,
    formatValue(entry.firewall_name),
  );
  addField(
    out,
    "Firewall Ref",
    entry.firewall_ref,
    formatValue(entry.firewall_ref),
  );
  addField(
    out,
    "Firewall Permission",
    entry.firewall_permission,
    formatValue(entry.firewall_permission),
  );
  addField(
    out,
    "Firewall Rule Match",
    entry.firewall_rule_match,
    formatValue(entry.firewall_rule_match),
  );
  addField(
    out,
    "Firewall Base URL",
    entry.firewall_base,
    formatValue(entry.firewall_base),
  );
  addField(
    out,
    "Firewall Params",
    entry.firewall_params,
    formatParams(entry.firewall_params),
  );
  addField(
    out,
    "Firewall Error",
    entry.firewall_error,
    formatValue(entry.firewall_error),
  );
  addField(
    out,
    "Resolved Secrets",
    entry.token_resolved_secrets,
    formatValue(entry.token_resolved_secrets),
  );
  addField(
    out,
    "Refreshed Connectors",
    entry.token_refreshed_connectors,
    formatValue(entry.token_refreshed_connectors),
  );
  addField(
    out,
    "Refreshed Secrets",
    entry.token_refreshed_secrets,
    formatValue(entry.token_refreshed_secrets),
  );
  addField(
    out,
    "Cache Hit",
    entry.token_cache_hit,
    formatValue(entry.token_cache_hit),
  );
  addField(out, "Error", entry.error, formatValue(entry.error));
  return out;
}

function NetworkLogRowDetail({ entry }: { entry: NetworkLogEntry }) {
  const details = collectDetails(entry);

  if (details.length === 0) {
    return null;
  }

  return (
    <TableRow>
      <td colSpan={7} className="bg-muted/30 px-8 py-2">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {details.map(([label, value]) => {
            return (
              <div key={label} className="contents">
                <span className="text-muted-foreground font-medium">
                  {label}
                </span>
                <span className="font-mono break-all">{value}</span>
              </div>
            );
          })}
        </div>
      </td>
    </TableRow>
  );
}

function NetworkLogRow({ entry }: { entry: NetworkLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const type = entryType(entry);
  const isHttp = type === "HTTP" || type === "DENY";

  const target = isHttp
    ? (entry.url ?? "—")
    : `${entry.host ?? "unknown"}:${entry.port ?? 0}`;

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => {
          setExpanded((prev) => {
            return !prev;
          });
        }}
      >
        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(entry.timestamp)}
        </TableCell>
        <TableCell>
          <TypeBadge type={type} />
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {isHttp ? (entry.method ?? "—") : "—"}
        </TableCell>
        <TableCell className="font-mono text-xs truncate max-w-[400px]">
          {target}
        </TableCell>
        <TableCell
          className={`font-mono text-xs whitespace-nowrap ${statusColor(entry.status)}`}
        >
          {entry.status ?? "—"}
        </TableCell>
        <TableCell
          className={`font-mono text-xs whitespace-nowrap ${latencyColor(entry.latency_ms)}`}
        >
          {formatLatency(entry.latency_ms)}
        </TableCell>
        <TableCell className="text-xs text-cyan-600 dark:text-cyan-400 truncate max-w-[120px]">
          {entry.firewall_name ?? ""}
        </TableCell>
      </TableRow>
      {expanded && <NetworkLogRowDetail entry={entry} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ZeroActivityNetworkPage() {
  const currentRunId = useGet(currentRunId$);
  const logsLoadable = useLastLoadable(zeroActivityNetworkLogs$);

  if (logsLoadable.state === "loading" || logsLoadable.state === "hasError") {
    return <NetworkSkeleton runId={currentRunId} />;
  }

  const data = logsLoadable.data;
  if (!data || data.networkLogs.length === 0) {
    return <NetworkEmpty runId={currentRunId} />;
  }

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <Breadcrumb runId={currentRunId} />
        <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 pt-4 pb-8">
          {data.hasMore && (
            <p className="text-xs text-muted-foreground mb-3">
              Showing first {data.networkLogs.length} entries. Some entries may
              be truncated.
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Time</TableHead>
                <TableHead className="w-[60px]">Type</TableHead>
                <TableHead className="w-[60px]">Method</TableHead>
                <TableHead>URL / Host</TableHead>
                <TableHead className="w-[60px]">Status</TableHead>
                <TableHead className="w-[80px]">Latency</TableHead>
                <TableHead className="w-[100px]">Firewall</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.networkLogs.map((entry, idx) => {
                const key = `${entry.timestamp}-${entry.type}-${entry.host}-${entry.port}-${entry.url}-${idx}`;
                return <NetworkLogRow key={key} entry={entry} />;
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function Breadcrumb({ runId }: { runId: string | null }) {
  const features = useLastResolved(featureSwitch$);
  return (
    <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
      {features?.[FeatureSwitchKey.ActivityLogList] && (
        <>
          <Link
            pathname="/activity"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
          >
            <IconChartLine size={14} stroke={1.5} className="shrink-0" />
            Activity
          </Link>
          <span className="text-muted-foreground/40 select-none">/</span>
        </>
      )}
      {runId && (
        <>
          <Link
            pathname="/activity/:runId"
            options={{ pathParams: { runId } }}
            className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
          >
            Run
          </Link>
          <span className="text-muted-foreground/40 select-none">/</span>
        </>
      )}
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
        Network
      </span>
    </nav>
  );
}

function NetworkEmpty({ runId }: { runId: string | null }) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <Breadcrumb runId={runId} />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <IconWorldWww
          size={32}
          stroke={1.5}
          className="text-muted-foreground"
        />
        <h2 className="text-lg font-semibold text-foreground">
          No network logs
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          No network traffic was recorded for this run.
        </p>
        {runId && (
          <Link
            pathname="/activity/:runId"
            options={{ pathParams: { runId } }}
            className="mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
          >
            Back to run
          </Link>
        )}
      </div>
    </div>
  );
}

function NetworkSkeleton({ runId }: { runId: string | null }) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <Breadcrumb runId={runId} />
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 pt-4 pb-8 flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => {
          return <Skeleton key={i} className="h-8 w-full" />;
        })}
      </div>
    </div>
  );
}
