import { useLoadable, useGet, useSet } from "ccstate-react";
import {
  usageRunsAsync$,
  runsPage$,
  runsPageSize$,
  runsMemberFilter$,
  setRunsPage$,
  setRunsPageSize$,
  setRunsFilter$,
} from "../../../signals/usage-page/usage-signals.ts";
import { orgMembers$ } from "../../../signals/external/org-members.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { IconUsers } from "@tabler/icons-react";
import type { UsageRun } from "@vm0/core";
import { Pagination } from "../../components/pagination.tsx";

// --- Helpers ---

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- Filters ---

function RunsFilters() {
  const memberFilter = useGet(runsMemberFilter$);
  const setFilter = useSet(setRunsFilter$);
  const membersLoadable = useLoadable(orgMembers$);

  const members =
    membersLoadable.state === "hasData" ? membersLoadable.data : [];

  const memberOptions = [
    { value: "all", label: "All members" },
    ...members.map((m) => {
      const name = [m.firstName, m.lastName].filter(Boolean).join(" ");
      return { value: m.userId, label: name || m.email };
    }),
  ];

  const handleMemberChange = (value: string) => {
    setFilter({ userId: value === "all" ? "" : value });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <Select value={memberFilter ?? "all"} onValueChange={handleMemberChange}>
        <SelectTrigger
          aria-label="Member filter"
          className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium"
        >
          <IconUsers size={14} stroke={1.5} className="shrink-0" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {memberOptions.map((opt) => {
            return (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
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
      <td
        className="px-3 py-2.5 text-foreground text-xs truncate max-w-[240px]"
        title={run.prompt}
      >
        {run.prompt}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums font-medium text-foreground">
        {formatNumber(run.creditsCharged)}
      </td>
      <td className="px-3 py-2.5 text-foreground truncate max-w-[160px]">
        {run.memberEmail}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted-foreground whitespace-nowrap">
        {formatTime(run.createdAt)}
      </td>
    </tr>
  );
}

// --- Main component ---

export function RunsTab() {
  const loadable = useLoadable(usageRunsAsync$);
  const page = useGet(runsPage$);
  const pageSize = useGet(runsPageSize$);
  const setPage = useSet(setRunsPage$);
  const setPageSize = useSet(setRunsPageSize$);

  const isLoading = loadable.state === "loading";
  const data = loadable.state === "hasData" ? loadable.data : null;

  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

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
                    Prompt
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                    Credits
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                    Member
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
        </div>
      )}

      {(totalPages > 1 || pageSize !== 20) && (
        <div className="pt-3">
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            rowsPerPage={pageSize}
            hasNext={hasNext}
            hasPrev={hasPrev}
            isLoading={isLoading}
            labelClassName="font-normal text-muted-foreground"
            buttonClassName="bg-transparent border-border/70"
            onNextPage={() => {
              setPage(page + 1);
            }}
            onPrevPage={() => {
              setPage(page - 1);
            }}
            onForwardTwoPages={() => {
              setPage(Math.min(totalPages, page + 2));
            }}
            onBackTwoPages={() => {
              setPage(Math.max(1, page - 2));
            }}
            onRowsPerPageChange={(limit) => {
              setPageSize(limit);
            }}
          />
        </div>
      )}
    </div>
  );
}
