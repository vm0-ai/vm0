import { IconLoader2 } from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui";
import type { NetworkLogEntry } from "@vm0/core";
import {
  networkLogExpandedRows$,
  toggleNetworkLogRowExpanded$,
} from "../../../signals/zero-page/network-log-ui.ts";

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
  if (type === "DNS") {
    return "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400";
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

// [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
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
    entry.auth_resolved_secrets,
    formatValue(entry.auth_resolved_secrets),
  );
  addField(
    out,
    "Refreshed Connectors",
    entry.auth_refreshed_connectors,
    formatValue(entry.auth_refreshed_connectors),
  );
  addField(
    out,
    "Refreshed Secrets",
    entry.auth_refreshed_secrets,
    formatValue(entry.auth_refreshed_secrets),
  );
  addField(
    out,
    "Cache Hit",
    entry.auth_cache_hit,
    formatValue(entry.auth_cache_hit),
  );
  addField(
    out,
    "URL Rewrite",
    entry.auth_url_rewrite,
    formatValue(entry.auth_url_rewrite),
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

function NetworkLogRow({
  entry,
  rowKey,
}: {
  entry: NetworkLogEntry;
  rowKey: string;
}) {
  const expandedRows = useGet(networkLogExpandedRows$);
  const toggleExpanded = useSet(toggleNetworkLogRowExpanded$);
  const expanded = expandedRows.has(rowKey);
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
          toggleExpanded(rowKey);
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
// Exported content component
// ---------------------------------------------------------------------------

export function NetworkContent({
  networkLogs,
  hasMore,
  loading,
  onLoadMore,
}: {
  networkLogs: NetworkLogEntry[];
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
}) {
  return (
    <div className="pb-8">
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
          {networkLogs.map((entry, idx) => {
            const key = `${entry.timestamp}-${entry.type}-${entry.host}-${entry.port}-${entry.url}-${idx}`;
            return <NetworkLogRow key={key} rowKey={key} entry={entry} />;
          })}
        </TableBody>
      </Table>
      {hasMore && onLoadMore && (
        <div className="flex justify-center py-4">
          {loading ? (
            <IconLoader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={onLoadMore}
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
