import { useLoadable, useGet, useSet } from "ccstate-react";
import {
  usageRunsAsync$,
  runsPage$,
  runsMemberFilter$,
  setRunsPage$,
  setRunsFilter$,
  usageMembersAsync$,
} from "../../../signals/usage-page/usage-signals.ts";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import type { UsageRun } from "@vm0/core";

// --- Helpers ---

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "-";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_STYLES = {
  completed: "bg-emerald-500/10 text-emerald-600",
  failed: "bg-red-500/10 text-red-600",
  running: "bg-blue-500/10 text-blue-600",
  timeout: "bg-amber-500/10 text-amber-600",
  cancelled: "bg-gray-500/10 text-gray-500",
  queued: "bg-gray-500/10 text-gray-500",
  pending: "bg-gray-500/10 text-gray-500",
} as const;

function StatusBadge({ status }: { status: string }) {
  const style =
    (STATUS_STYLES as Record<string, string>)[status] ??
    "bg-gray-500/10 text-gray-500";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {status}
    </span>
  );
}

// --- Filters ---

function RunsFilters() {
  const memberFilter = useGet(runsMemberFilter$);
  const setFilter = useSet(setRunsFilter$);
  const membersLoadable = useLoadable(usageMembersAsync$);

  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data.members : [];

  const uniqueMembers = members.map((m) => {
    return { value: m.userId, label: m.email };
  });

  const handleMemberChange = (val: string) => {
    setFilter({ userId: val === "all" ? "" : val });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <Select value={memberFilter ?? "all"} onValueChange={handleMemberChange}>
        <SelectTrigger className="h-8 w-[180px] text-xs">
          <SelectValue placeholder="All members" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All members</SelectItem>
          {uniqueMembers.map((m) => {
            return (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

// --- Table ---

function RunRow({ run }: { run: UsageRun }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/10">
      <td className="px-3 py-2.5 text-foreground truncate max-w-[140px]">
        {run.agentName ?? "-"}
      </td>
      <td className="px-3 py-2.5 text-foreground truncate max-w-[160px]">
        {run.memberEmail}
      </td>
      <td className="px-3 py-2.5 text-foreground text-xs truncate max-w-[100px]">
        {run.model}
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={run.status} />
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-foreground">
        {formatDuration(run.durationMs)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground text-xs">
        <span title="Input">{formatNumber(run.inputTokens)}</span>
        {" / "}
        <span title="Output">{formatNumber(run.outputTokens)}</span>
        {" / "}
        <span title="Cache">{formatNumber(run.cacheTokens)}</span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-foreground">
        {formatNumber(run.creditsCharged)}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground whitespace-nowrap">
        {formatTime(run.createdAt)}
      </td>
    </tr>
  );
}

function Pagination({
  page,
  pageSize,
  total,
}: {
  page: number;
  pageSize: number;
  total: number;
}) {
  const setPage = useSet(setRunsPage$);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex items-center justify-between pt-3 px-1">
      <span className="text-xs text-muted-foreground">
        {total > 0 ? `${from}–${to} of ${total}` : "No records"}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={page <= 1}
          onClick={() => {
            setPage(page - 1);
          }}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground px-2">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={page >= totalPages}
          onClick={() => {
            setPage(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// --- Main component ---

export function RunsTab() {
  const loadable = useLoadable(usageRunsAsync$);
  const page = useGet(runsPage$);

  const isLoading = loadable.state === "loading";
  const data = loadable.state === "hasData" ? loadable.data : null;

  return (
    <div>
      <RunsFilters />

      {isLoading ? (
        <div className="zero-card h-64 animate-pulse bg-muted/20" />
      ) : !data || data.runs.length === 0 ? (
        <div className="zero-card flex items-center justify-center p-12">
          <p className="text-sm text-muted-foreground">
            No run records found for the selected filters.
          </p>
        </div>
      ) : (
        <div className="zero-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                    Agent
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                    Member
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                    Model
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                    Duration
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                    Tokens (I/O/C)
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                    Credits
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => {
                  return <RunRow key={run.runId} run={run} />;
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border px-3 py-2">
            <Pagination
              page={page}
              pageSize={data.pagination.pageSize}
              total={data.pagination.total}
            />
          </div>
        </div>
      )}
    </div>
  );
}
