import { useGet, useLastLoadable, useSet } from "ccstate-react";
import {
  IconCalendar,
  IconCircleDot,
  IconMessageCircle,
  IconRotateClockwise2,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { pathParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  allOrgAutomationEntries$,
  allOrgAutomationsLoaded$,
  type OrgAutomationEntry,
} from "../../signals/zero-page/zero-automations.ts";
import {
  automationTitle,
  automationTitleExcerpt,
} from "../../signals/zero-page/automation-title.ts";
import { LogTable, STATUS_LABELS } from "./components/log-views/log-table.tsx";
import { Pagination } from "../components/pagination.tsx";
import {
  automationRunAvailableStatuses$,
  automationRunCurrentPage$,
  automationRunData$,
  automationRunHasPrev$,
  automationRunLimit$,
  automationRunStatusFilter$,
  goBackTwoAutomationRunPages$,
  goForwardTwoAutomationRunPages$,
  goToNextAutomationRunPage$,
  goToPrevAutomationRunPage$,
  setAutomationRunRowsPerPage$,
  setAutomationRunStatusFilter$,
} from "../../signals/automation-page/automation-run-history.ts";
import { ZeroNoPermissionIllustration } from "./components/zero-no-permission-illustration.tsx";
import { Link } from "../router/link.tsx";
import {
  buildCombinedAutomations,
  type CombinedEntry,
} from "./zero-automations-page.tsx";

function formatRunAt(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function AutomationBreadcrumbLink({ chatThreadId }: { chatThreadId?: string }) {
  if (chatThreadId) {
    return (
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: chatThreadId } }}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconMessageCircle size={14} stroke={1.5} className="shrink-0" />
        Chat thread
      </Link>
    );
  }

  return (
    <Link
      pathname="/automations"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
    >
      <IconCalendar size={14} stroke={1.5} className="shrink-0" />
      Automations
    </Link>
  );
}

function AutomationDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <AutomationBreadcrumbLink />
        <span className="text-muted-foreground/40 select-none">/</span>
        <div className="h-4 w-32 rounded bg-muted/50 animate-pulse" />
      </nav>
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-stretch gap-4">
            <Skeleton className="h-14 w-14 shrink-0 rounded-xl bg-muted/60 sm:h-16 sm:w-16" />
            <div className="min-w-0 flex-1 h-14 sm:h-16 flex flex-col justify-center gap-1.5">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          </div>
        </div>
      </header>
      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card overflow-hidden">
            <CardContent className="p-4 sm:p-5 space-y-4">
              <Skeleton className="h-20 w-full" />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

function AutomationNotFound() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <AutomationBreadcrumbLink />
        <span className="text-muted-foreground/40 select-none">/</span>
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          Automation
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 pb-20">
        <ZeroNoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
        <h2 className="text-lg font-semibold text-foreground">
          Automation not found
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          This automation does not exist or was removed.
        </p>
        <Link
          pathname="/automations"
          className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
        >
          Back to automations
        </Link>
      </div>
    </div>
  );
}

function AutomationSummaryCard({ entry }: { entry: CombinedEntry }) {
  const rows = [
    { label: "Status", value: entry.enabled ? "Active" : "Paused" },
    { label: "Schedule", value: entry.triggerSummary ?? entry.time },
    { label: "Next run", value: formatRunAt(entry.nextRunAt) },
    { label: "Last run", value: formatRunAt(entry.lastRunAt) },
    { label: "Agent", value: entry.agentLabel },
  ];

  return (
    <Card className="zero-card overflow-hidden">
      <CardContent className="p-0">
        <dl className="divide-y divide-border/60">
          {rows.map((row) => {
            return (
              <div
                key={row.label}
                className="grid grid-cols-[8rem,1fr] gap-4 px-4 py-3 text-sm sm:grid-cols-[10rem,1fr] sm:px-5"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd
                  className={cn(
                    "min-w-0 truncate text-foreground",
                    row.label === "Status" && "font-medium",
                  )}
                  title={row.value}
                >
                  {row.value}
                </dd>
              </div>
            );
          })}
          {entry.chatThreadId && (
            <div className="grid grid-cols-[8rem,1fr] gap-4 px-4 py-3 text-sm sm:grid-cols-[10rem,1fr] sm:px-5">
              <dt className="text-muted-foreground">Chat thread</dt>
              <dd className="min-w-0">
                <Link
                  pathname="/chats/:threadId"
                  options={{ pathParams: { threadId: entry.chatThreadId } }}
                  className="inline-flex max-w-full items-center gap-1 truncate rounded-md text-foreground underline-offset-4 hover:underline"
                >
                  <IconMessageCircle
                    size={14}
                    stroke={1.5}
                    className="shrink-0"
                  />
                  <span className="truncate">{entry.chatThreadId}</span>
                </Link>
              </dd>
            </div>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}

function AutomationRunHistoryTab() {
  const pageSignal = useGet(pageSignal$);
  const dataLoadable = useLastLoadable(automationRunData$);
  const hasPrev = useGet(automationRunHasPrev$);
  const currentPage = useGet(automationRunCurrentPage$);
  const rowsPerPage = useGet(automationRunLimit$);
  const goToNext = useSet(goToNextAutomationRunPage$);
  const goToPrev = useSet(goToPrevAutomationRunPage$);
  const goForwardTwo = useSet(goForwardTwoAutomationRunPages$);
  const goBackTwo = useSet(goBackTwoAutomationRunPages$);
  const setRowsPerPage = useSet(setAutomationRunRowsPerPage$);
  const statusFilter = useGet(automationRunStatusFilter$);
  const setStatusFilter = useSet(setAutomationRunStatusFilter$);
  const availableStatusesLoadable = useLastLoadable(
    automationRunAvailableStatuses$,
  );

  const logs = dataLoadable.state === "hasData" ? dataLoadable.data.data : [];
  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const totalPages =
    dataLoadable.state === "hasData"
      ? dataLoadable.data.pagination.totalPages
      : undefined;
  const isLoading = dataLoadable.state === "loading";

  const statusOptions = [
    { value: "all", label: "All status" },
    ...(availableStatusesLoadable.state === "hasData"
      ? availableStatusesLoadable.data.map((status) => {
          return {
            value: status,
            label: STATUS_LABELS[status],
          };
        })
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            return setStatusFilter(value);
          }}
        >
          <SelectTrigger
            aria-label="Status filter"
            className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium"
          >
            <IconCircleDot size={14} stroke={1.5} className="shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((option) => {
              return (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      <Card className="zero-card overflow-hidden">
        <CardContent className="pb-3 pt-0 px-0">
          <LogTable
            logs={logs}
            isLoading={isLoading}
            rowsPerPage={rowsPerPage}
            emptyTitle="No runs yet"
            emptyDescription="When this automation runs, its history will show up here."
            filteredEmptyTitle="Nothing matches that filter"
            filteredEmptyDescription="Try a different status filter."
            hasActiveFilter={statusFilter !== "all"}
            minWidth="440px"
          />
        </CardContent>
      </Card>

      {(totalPages === undefined || totalPages > 1) && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          rowsPerPage={rowsPerPage}
          hasNext={hasNext}
          hasPrev={hasPrev}
          isLoading={isLoading}
          labelClassName="font-normal text-muted-foreground"
          buttonClassName="bg-transparent border-border/70"
          onNextPage={() => {
            return detach(goToNext(pageSignal), Reason.DomCallback);
          }}
          onPrevPage={() => {
            return goToPrev();
          }}
          onForwardTwoPages={() => {
            return detach(goForwardTwo(pageSignal), Reason.DomCallback);
          }}
          onBackTwoPages={() => {
            return goBackTwo();
          }}
          onRowsPerPageChange={(limit) => {
            return setRowsPerPage(limit);
          }}
        />
      )}
    </div>
  );
}

function AutomationDetailView({ entry }: { entry: CombinedEntry }) {
  const title = automationTitle(entry);
  const excerpt = automationTitleExcerpt(entry);
  const dimmed = entry.enabled === false;

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <AutomationBreadcrumbLink chatThreadId={entry.chatThreadId} />
        <span className="text-muted-foreground/40 select-none">/</span>
        <span
          className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate max-w-[36rem]"
          title={title}
        >
          {title}
        </span>
      </nav>

      <header
        className={cn(
          "shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3 transition-opacity",
          dimmed && "opacity-90",
        )}
      >
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-stretch gap-4">
            <div className="h-14 w-14 shrink-0 rounded-xl bg-muted/60 border border-border/70 flex items-center justify-center sm:h-16 sm:w-16">
              <IconRotateClockwise2
                size={24}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </div>
            <div className="min-w-0 flex-1 h-14 sm:h-16 flex flex-col justify-center">
              <h1 className="truncate text-xl font-semibold leading-tight tracking-tight text-foreground sm:text-2xl">
                {title}
              </h1>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {excerpt}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="shrink-0 flex-1 px-4 sm:px-6 pt-4 sm:pt-6 pb-16">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          <AutomationSummaryCard entry={entry} />
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              Run history
            </h2>
            <AutomationRunHistoryTab />
          </section>
        </div>
      </main>
    </div>
  );
}

export function ZeroAutomationDetailPage() {
  const params = useGet(pathParams$);
  const automationId =
    params && typeof params === "object" && "automationId" in params
      ? String(params.automationId)
      : null;
  const entriesLoadable = useLastLoadable(allOrgAutomationEntries$);
  const entries: OrgAutomationEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];
  const automationsLoaded = useGet(allOrgAutomationsLoaded$);
  const combinedAutomations = buildCombinedAutomations(entries);

  if (!automationId) {
    return <AutomationNotFound />;
  }

  if (!automationsLoaded || entriesLoadable.state !== "hasData") {
    return <AutomationDetailSkeleton />;
  }

  const entry = combinedAutomations.find((candidate) => {
    return candidate.id === automationId;
  });

  if (!entry) {
    return <AutomationNotFound />;
  }

  return <AutomationDetailView entry={entry} />;
}
