import {
  IconCheck,
  IconChevronDown,
  IconFilter,
  IconLoader2,
} from "@tabler/icons-react";
import { useGet, useSet } from "ccstate-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import { type BadgeColor, formatSize, InlineBadge } from "./network-badge.tsx";
import { CapturedBodySections } from "./captured-body-sections.tsx";
import {
  defaultNetworkLogTypes,
  type NetworkLogTypeFilter,
  networkLogExpandedRows$,
  networkLogTypeFilter$,
  setNetworkLogTypeFilter$,
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
  return entry.type ? entry.type.toUpperCase() : "HTTP";
}

function typeBadgeColor(type: string): BadgeColor {
  if (type === "HTTP") {
    return "blue";
  }
  if (type === "TCP") {
    return "violet";
  }
  if (type === "UDP" || type === "ICMP") {
    return "amber";
  }
  if (type === "DNS") {
    return "teal";
  }
  return "muted";
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

function TypeBadge({
  type,
  denied = false,
}: {
  type: string;
  denied?: boolean;
}) {
  return (
    <InlineBadge color={denied ? "red" : typeBadgeColor(type)}>
      <span className={denied ? "line-through" : undefined}>{type}</span>
    </InlineBadge>
  );
}

function typeRank(type: string): number {
  switch (type) {
    case "HTTP": {
      return 0;
    }
    case "DNS": {
      return 1;
    }
    case "TCP": {
      return 2;
    }
    case "UDP": {
      return 3;
    }
    case "ICMP": {
      return 4;
    }
    default: {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}

function sortTypes(types: string[]): string[] {
  return [...types].sort((a, b) => {
    const rankDelta = typeRank(a) - typeRank(b);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return a.localeCompare(b);
  });
}

function networkTypeOptions(
  networkLogs: NetworkLogEntry[],
  typeFilter: NetworkLogTypeFilter,
): string[] {
  const selectedTypes = typeFilter.mode === "selected" ? typeFilter.types : [];
  const types = new Set<string>([
    ...defaultNetworkLogTypes(),
    ...selectedTypes,
  ]);
  for (const entry of networkLogs) {
    types.add(entryType(entry));
  }
  return sortTypes(Array.from(types));
}

function selectedTypeValues(
  typeFilter: NetworkLogTypeFilter,
  typeOptions: string[],
): string[] {
  return typeFilter.mode === "all" ? typeOptions : [...typeFilter.types];
}

function toggleSelectedType(
  typeFilter: NetworkLogTypeFilter,
  typeOptions: string[],
  type: string,
): NetworkLogTypeFilter {
  const selectedTypes = selectedTypeValues(typeFilter, typeOptions);
  const nextTypes = selectedTypes.includes(type)
    ? selectedTypes.filter((selected) => {
        return selected !== type;
      })
    : sortTypes([...selectedTypes, type]);
  if (nextTypes.length === 0) {
    return { mode: "all" };
  }
  return { mode: "selected", types: nextTypes };
}

function typeFilterLabel(typeFilter: NetworkLogTypeFilter): string {
  if (typeFilter.mode === "all") {
    return "All types";
  }
  const selectedTypes = typeFilter.types;
  if (selectedTypes.length === 0) {
    return "All types";
  }
  if (selectedTypes.length === 1) {
    return selectedTypes[0] ?? "All types";
  }
  return `${selectedTypes.length} types`;
}

function TypeFilter({
  typeOptions,
  typeFilter,
  onChange,
}: {
  typeOptions: string[];
  typeFilter: NetworkLogTypeFilter;
  onChange: (filter: NetworkLogTypeFilter) => void;
}) {
  const selectedTypes = selectedTypeValues(typeFilter, typeOptions);
  const selectedSet = new Set(selectedTypes);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Type filter"
          className="flex h-8 min-w-[140px] items-center justify-between gap-1.5 rounded-md border border-border bg-input px-3 text-xs text-foreground outline-none transition-colors hover:bg-accent focus:border-primary focus:ring-[3px] focus:ring-primary/10"
        >
          <span className="flex items-center gap-1.5">
            <IconFilter size={14} stroke={1.5} className="shrink-0" />
            {typeFilterLabel(typeFilter)}
          </span>
          <IconChevronDown
            size={14}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={typeFilter.mode === "all"}
          onSelect={(event) => {
            event.preventDefault();
            onChange({ mode: "all" });
          }}
        >
          <span className="flex h-4 w-4 items-center justify-center">
            {typeFilter.mode === "all" && <IconCheck size={14} />}
          </span>
          All types
        </DropdownMenuItem>
        {typeOptions.map((type) => {
          const selected = selectedSet.has(type);
          return (
            <DropdownMenuItem
              key={type}
              role="menuitemcheckbox"
              aria-checked={selected}
              onSelect={(event) => {
                event.preventDefault();
                onChange(toggleSelectedType(typeFilter, typeOptions, type));
              }}
            >
              <span className="flex h-4 w-4 items-center justify-center">
                {selected && <IconCheck size={14} />}
              </span>
              {type}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
// Note: request_headers, request/response body fields are rendered
// separately by CapturedBodySections below.
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
    "Browser User-Agent",
    entry.browser_user_agent,
    entry.browser_user_agent ? "Yes" : "No",
  );
  addField(out, "DNS Event", entry.dns_event, formatValue(entry.dns_event));
  addField(
    out,
    "DNS Query Type",
    entry.dns_query_type,
    formatValue(entry.dns_query_type),
  );
  addField(out, "DNS Result", entry.dns_result, formatValue(entry.dns_result));
  addField(out, "DNS Serial", entry.dns_serial, formatValue(entry.dns_serial));
  addField(
    out,
    "Firewall",
    entry.firewall_name,
    formatValue(entry.firewall_name),
  );
  addField(
    out,
    "Permission",
    entry.firewall_permission,
    formatValue(entry.firewall_permission),
  );
  addField(
    out,
    "Rule Match",
    entry.firewall_rule_match,
    formatValue(entry.firewall_rule_match),
  );
  addField(
    out,
    "Base URL",
    entry.firewall_base,
    formatValue(entry.firewall_base),
  );
  addField(
    out,
    "Params",
    entry.firewall_params,
    formatParams(entry.firewall_params),
  );
  addField(
    out,
    "Billable",
    entry.firewall_billable,
    entry.firewall_billable ? "Yes" : "No",
  );
  addField(
    out,
    "Permission Error",
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

// ---------------------------------------------------------------------------
// Detail row
// ---------------------------------------------------------------------------

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
        <CapturedBodySections entry={entry} />
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
  const isHttp = type === "HTTP";

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
          <TypeBadge type={type} denied={entry.action === "DENY"} />
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
        <TableCell className="w-[160px] max-w-[160px]">
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
            {entry.firewall_name ? (
              <span className="min-w-0 max-w-full truncate text-cyan-600 dark:text-cyan-400">
                {entry.firewall_name}
              </span>
            ) : null}
            {entry.browser_user_agent ? (
              <span className="shrink-0 font-mono text-muted-foreground">
                browser
              </span>
            ) : null}
          </div>
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
  const typeFilter = useGet(networkLogTypeFilter$);
  const setTypeFilter = useSet(setNetworkLogTypeFilter$);
  const typeOptions = networkTypeOptions(networkLogs, typeFilter);
  const selectedTypes = selectedTypeValues(typeFilter, typeOptions);
  const selectedTypeSet = new Set(selectedTypes);
  const filteredNetworkLogs =
    typeFilter.mode === "all"
      ? networkLogs
      : networkLogs.filter((entry) => {
          return selectedTypeSet.has(entryType(entry));
        });

  return (
    <div className="pb-8">
      <div className="mb-3 flex justify-end">
        <TypeFilter
          typeOptions={typeOptions}
          typeFilter={typeFilter}
          onChange={setTypeFilter}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">Time</TableHead>
            <TableHead className="w-[60px]">Type</TableHead>
            <TableHead className="w-[60px]">Method</TableHead>
            <TableHead>URL / Host</TableHead>
            <TableHead className="w-[60px]">Status</TableHead>
            <TableHead className="w-[80px]">Latency</TableHead>
            <TableHead className="w-[160px]">Permission</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredNetworkLogs.length === 0 ? (
            <TableRow>
              <td
                colSpan={7}
                className="h-24 text-center text-sm text-muted-foreground"
              >
                No matching logs in loaded results
              </td>
            </TableRow>
          ) : (
            filteredNetworkLogs.map((entry, idx) => {
              const key = `${entry.timestamp}-${entry.type}-${entry.host}-${entry.port}-${entry.url}-${idx}`;
              return <NetworkLogRow key={key} rowKey={key} entry={entry} />;
            })
          )}
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
