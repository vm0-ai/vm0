// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCircleDot,
  IconList,
  IconLayoutGrid,
  IconPlus,
  IconRotateClockwise2,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Tabs,
  TabsList,
  TabsTrigger,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { WEEKDAY_LABELS, type ScheduleEntry } from "./zero-schedule-card";
import {
  ScheduleFormDialog,
  type ScheduleFormValues,
} from "./schedule-dialog.tsx";
import { ScheduleCalendarView } from "./schedule-calendar-view.tsx";
import { ScheduleListView } from "./schedule-list-view.tsx";
import { agents$ } from "../../signals/agent.ts";
import {
  COMMON_TIMEZONES,
  getTimezoneLabel,
} from "../../signals/zero-page/cron.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  allOrgScheduleEntries$,
  allOrgSchedulesLoaded$,
  saveOrgSchedule$,
  toggleOrgScheduleEnabled$,
  deleteOrgSchedule$,
  runScheduleNow$,
  type OrgScheduleEntry,
} from "../../signals/zero-page/zero-schedule.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import {
  createDialogOpen$,
  setCreateDialogOpen$,
  pageTogglingIds$,
  setPageTogglingIds$,
  pageRunningIds$,
  setPageRunningIds$,
  pagePendingDelete$,
  setPagePendingDelete$,
} from "../../signals/schedule-page/schedule-page-ui.ts";
import {
  scheduleListTab$,
  setScheduleListTab$,
} from "../../signals/schedule-page/schedule-list-tab.ts";
import {
  allScheduleRunData$,
  allScheduleRunLimit$,
  allScheduleRunHasPrev$,
  allScheduleRunCurrentPage$,
  goToNextAllScheduleRunPage$,
  goToPrevAllScheduleRunPage$,
  goForwardTwoAllScheduleRunPages$,
  goBackTwoAllScheduleRunPages$,
  setAllScheduleRunRowsPerPage$,
  allScheduleRunStatusFilter$,
  setAllScheduleRunStatusFilter$,
  allScheduleRunAvailableStatuses$,
} from "../../signals/schedule-page/all-schedule-run-history.ts";
import { LogTable, STATUS_LABELS } from "./components/log-views/log-table.tsx";
import { Pagination } from "../components/pagination.tsx";

export type CombinedEntry = ScheduleEntry & {
  agentLabel: string;
  agentId: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

export function buildCombinedSchedule(
  entries: OrgScheduleEntry[],
): CombinedEntry[] {
  return entries.map((e) => {
    return {
      id: e.id,
      time: e.time,
      prompt: e.prompt,
      description: e.description,
      enabled: e.enabled,
      name: e.name,
      intervalSeconds: e.intervalSeconds,
      agentLabel: e.displayName ?? e.agentId,
      agentId: e.agentId,
      timezone: e.timezone,
      nextRunAt: e.nextRunAt,
      lastRunAt: e.lastRunAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Edit fields
// ---------------------------------------------------------------------------

const SCHEDULE_FREQUENCY_OPTIONS = [
  { value: "now", label: "Now" },
  { value: "once", label: "Once" },
  { value: "every_weekday", label: "Every weekday" },
  { value: "every_day", label: "Every day" },
  { value: "every_week", label: "Every week" },
  { value: "every_month", label: "Every month" },
  { value: "every_n_minutes", label: "Loop" },
] as const;

const SCHEDULE_LOOP_MINUTES = [5, 15, 30, 60] as const;

const HOUR_OPTIONS: readonly number[] = Array.from({ length: 24 }, (_, i) => {
  return i;
});

const MINUTE_OPTIONS: readonly number[] = Array.from({ length: 12 }, (_, i) => {
  return i * 5;
});

function getMinuteOptions(currentMinute?: number): readonly number[] {
  if (currentMinute === undefined || MINUTE_OPTIONS.includes(currentMinute)) {
    return MINUTE_OPTIONS;
  }
  return [...MINUTE_OPTIONS, currentMinute].sort((a, b) => {
    return a - b;
  });
}

function isCronFreq(f: string): boolean {
  return (
    f === "once" ||
    f === "every_weekday" ||
    f === "every_day" ||
    f === "every_week" ||
    f === "every_month"
  );
}

export function ScheduleEditFields({
  freq,
  setFreq,
  loopMinutes,
  setLoopMinutes,
  date,
  setDate,
  hour,
  setHour,
  minute,
  setMinute,
  timezone,
  setTimezone,
}: {
  freq: string;
  setFreq: (v: string) => void;
  loopMinutes: number;
  setLoopMinutes: (v: number) => void;
  date: string;
  setDate: (v: string) => void;
  hour: number;
  setHour: (v: number) => void;
  minute: number;
  setMinute: (v: number) => void;
  timezone: string;
  setTimezone: (v: string) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="schedule-dialog-freq"
          className="text-sm font-medium text-foreground"
        >
          Time
        </label>
        <Select value={freq} onValueChange={setFreq}>
          <SelectTrigger id="schedule-dialog-freq" className="h-9 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_FREQUENCY_OPTIONS.map((opt) => {
              return (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      {freq === "every_n_minutes" && (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="schedule-dialog-loop"
            className="text-sm font-medium text-foreground"
          >
            Every
          </label>
          <Select
            value={String(loopMinutes)}
            onValueChange={(v) => {
              return setLoopMinutes(Number(v));
            }}
          >
            <SelectTrigger id="schedule-dialog-loop" className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_LOOP_MINUTES.map((m) => {
                return (
                  <SelectItem key={m} value={String(m)}>
                    {m} minutes
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
      {freq === "once" && (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="schedule-dialog-date"
            className="text-sm font-medium text-foreground"
          >
            Date
          </label>
          <Input
            id="schedule-dialog-date"
            type="date"
            value={date}
            onChange={(e) => {
              return setDate(e.target.value);
            }}
            className="h-9 w-full"
          />
        </div>
      )}
      {freq !== "now" && freq !== "every_n_minutes" && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">Time</label>
          <div className="flex w-full min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={String(hour)}
                onValueChange={(v) => {
                  return setHour(Number(v));
                }}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOUR_OPTIONS.map((h) => {
                    return (
                      <SelectItem key={h} value={String(h)}>
                        {h.toString().padStart(2, "0")}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <span className="shrink-0 text-muted-foreground">:</span>
            <div className="min-w-0 flex-1">
              <Select
                value={String(minute)}
                onValueChange={(v) => {
                  return setMinute(Number(v));
                }}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getMinuteOptions(minute).map((m) => {
                    return (
                      <SelectItem key={m} value={String(m)}>
                        {m.toString().padStart(2, "0")}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}
      {isCronFreq(freq) && (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="schedule-dialog-tz"
            className="text-sm font-medium text-foreground"
          >
            Timezone
          </label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="schedule-dialog-tz" className="h-9 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMON_TIMEZONES.map((tz) => {
                return (
                  <SelectItem key={tz} value={tz}>
                    {getTimezoneLabel(tz)}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const SKELETON_LIST_KEYS = ["s-0", "s-1", "s-2", "s-3", "s-4"] as const;
const SKELETON_ROW_KEYS = ["r-0", "r-1", "r-2", "r-3"] as const;

function ScheduleListSkeleton() {
  return (
    <div
      className="w-full overflow-x-auto"
      data-testid="schedule-list-skeleton"
    >
      <table className="w-full text-sm border-collapse [&_tr>:first-child]:pl-5 [&_tr>:last-child]:pr-5">
        <thead>
          <tr className="border-b border-border/40 bg-card text-left text-sm text-muted-foreground">
            <th
              className="py-3 pr-2 w-[5rem] align-middle font-medium"
              scope="col"
            >
              Agent
            </th>
            <th
              className="py-3 pr-4 min-w-0 align-middle font-medium"
              scope="col"
            >
              Instruction
            </th>
            <th
              className="py-3 px-2 min-w-[6.5rem] max-w-[9rem] align-middle font-medium"
              scope="col"
            >
              Schedule at
            </th>
            <th
              className="py-3 px-3 w-16 text-center align-middle font-medium"
              scope="col"
            >
              Status
            </th>
            <th className="w-10 py-3 pl-2 align-middle" scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {SKELETON_LIST_KEYS.map((key) => {
            return (
              <tr key={key} className="border-b border-border/50 last:border-0">
                <td className="py-2.5 pr-2 align-middle w-[5rem]">
                  <Skeleton className="h-4 w-14 rounded-md" />
                </td>
                <td className="py-2.5 pr-4 align-middle min-w-0 max-w-[1px]">
                  <Skeleton className="h-4 w-full max-w-md" />
                </td>
                <td className="py-2.5 px-2 align-middle min-w-[6.5rem] max-w-[9rem] overflow-hidden">
                  <Skeleton className="h-4 w-full max-w-[8rem] rounded-md" />
                </td>
                <td className="py-2.5 px-3 align-middle w-16">
                  <div className="flex justify-center">
                    <Skeleton className="h-5 w-9 rounded-full" />
                  </div>
                </td>
                <td className="py-2.5 pl-2 align-middle text-right w-10">
                  <div className="flex justify-end">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleCalendarSkeleton() {
  return (
    <section className="flex flex-col gap-2 p-5">
      <Skeleton className="h-4 w-20" />
      <div className="rounded-xl zero-border bg-muted/20 overflow-hidden">
        <div className="grid grid-cols-8">
          <div className="bg-muted/50 p-2 border-b border-r border-border/60 h-9" />
          {WEEKDAY_LABELS.map((d) => {
            return (
              <div
                key={d}
                className="bg-muted/50 p-2 border-b border-border/60 flex justify-center"
              >
                <Skeleton className="h-4 w-8" />
              </div>
            );
          })}
          {SKELETON_ROW_KEYS.map((rowKey, row) => {
            return (
              <div key={rowKey} className="contents">
                <div className="bg-muted/30 p-2 border-r border-b border-border/60 flex items-center">
                  <Skeleton className="h-3 w-12" />
                </div>
                {WEEKDAY_LABELS.map((day, col) => {
                  return (
                    <div
                      key={`${rowKey}-${day}`}
                      className="min-h-[52px] p-1.5 border-r border-b border-border/60 flex items-center justify-center"
                    >
                      {(row + col) % 3 === 0 && (
                        <Skeleton className="h-6 w-full rounded" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ZeroSchedulePage() {
  const statusLoadable = useLoadable(zeroOnboardingStatus$);
  const defaultComposeId =
    statusLoadable.state === "hasData"
      ? statusLoadable.data.defaultAgentId
      : null;

  const entriesLoadable = useLastLoadable(allOrgScheduleEntries$);
  const entries: OrgScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const agentsLoadable = useLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const loaded = useGet(allOrgSchedulesLoaded$);
  const isInitialLoading = !loaded;

  const toggleEnabled = useSet(toggleOrgScheduleEnabled$);
  const [deleteLoadable, deleteSchedule] = useLoadableSet(deleteOrgSchedule$);
  const deleting = deleteLoadable.state === "loading";
  const runScheduleNow = useSet(runScheduleNow$);
  const pageSignal = useGet(pageSignal$);
  const navigate = useSet(detachedNavigateTo$);

  const features = useLastResolved(featureSwitch$);
  const showRunHistoryTab =
    features?.[FeatureSwitchKey.ScheduleRunHistory] ?? false;
  const rawActiveListTab = useGet(scheduleListTab$);
  const setActiveListTab = useSet(setScheduleListTab$);
  // When the feature switch is off, collapse "history" back to the default list
  // view so the page doesn't render an empty state for a hidden tab.
  const activeListTab =
    !showRunHistoryTab && rawActiveListTab === "history"
      ? "list"
      : rawActiveListTab;
  const createOpen = useGet(createDialogOpen$);
  const setCreateOpen = useSet(setCreateDialogOpen$);
  const togglingIds = useGet(pageTogglingIds$);
  const setTogglingIds = useSet(setPageTogglingIds$);
  const runningIds = useGet(pageRunningIds$);
  const setRunningIds = useSet(setPageRunningIds$);
  const pendingDelete = useGet(pagePendingDelete$);
  const setPendingDelete = useSet(setPagePendingDelete$);

  const [saveLoadable, saveScheduleTracked] = useLoadableSet(saveOrgSchedule$);
  const saving = saveLoadable.state === "loading";
  const saveError =
    saveLoadable.state === "hasError" ? String(saveLoadable.error) : null;

  const combinedSchedule = buildCombinedSchedule(entries);

  const agentOrder = [
    ...new Set(
      combinedSchedule.map((e) => {
        return e.agentLabel;
      }),
    ),
  ] as const;

  const openScheduleDetail = (entry: CombinedEntry) => {
    navigate("/schedules/:scheduleId", {
      pathParams: { scheduleId: entry.id },
    });
  };

  const handleCreateSave = (values: ScheduleFormValues) => {
    detach(
      // eslint-disable-next-line ccstate/no-abort-swallower -- known debt: useLoadableSet's setter both sets saveError state AND rethrows; the empty .then reject handler silences the rethrow so detach does not double-log a rejection the dialog already shows. Tracked for follow-up.
      saveScheduleTracked(
        {
          prompt: values.prompt.trim(),
          description: values.description.trim() || undefined,
          freq: values.freq,
          date: values.date,
          hour: values.hour,
          minute: values.minute,
          timezone: values.timezone,
          intervalSeconds: values.loopMinutes * 60,
          agentId: values.agentId,
          ...(values.freq === "every_week"
            ? { dayOfWeek: values.dayOfWeek }
            : {}),
          ...(values.freq === "every_month"
            ? { dayOfMonth: values.dayOfMonth }
            : {}),
        },
        pageSignal,
      ).then(
        (scheduleId) => {
          setCreateOpen(false);
          navigate("/schedules/:scheduleId", {
            pathParams: { scheduleId: scheduleId },
          });
        },
        (_error: unknown) => {
          // error is already captured by useLoadableSet and displayed in the dialog via saveError
        },
      ),
      Reason.DomCallback,
    );
  };

  const handleToggle = (entry: CombinedEntry, enabled: boolean) => {
    if (entry.name === undefined) {
      return;
    }
    const id = entry.id;
    const name = entry.name;
    setTogglingIds((prev) => {
      return new Set([...prev, id]);
    });
    detach(
      toggleEnabled(
        { name, enabled, agentId: entry.agentId },
        pageSignal,
      ).finally(() => {
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }),
      Reason.DomCallback,
    );
  };

  const handleRunNow = (entry: CombinedEntry) => {
    const id = entry.id;
    setRunningIds((prev) => {
      return new Set([...prev, id]);
    });
    detach(
      runScheduleNow(entry.id, pageSignal).finally(() => {
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }),
      Reason.DomCallback,
    );
  };

  const handleDelete = (entry: CombinedEntry) => {
    setPendingDelete(entry);
  };

  const confirmDelete = () => {
    const entry = pendingDelete;
    if (entry?.name === undefined) {
      return;
    }
    detach(
      deleteSchedule(
        { name: entry.name, agentId: entry.agentId },
        pageSignal,
      ).then(() => {
        setPendingDelete(null);
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 hidden md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Scheduled tasks
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Automated tasks scheduled across all agents in your workspace.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
              disabled={agents.length === 0}
              onClick={() => {
                return setCreateOpen(true);
              }}
            >
              <IconPlus size={14} stroke={2} />
              Add schedule
            </Button>
            <Tabs
              value={activeListTab}
              onValueChange={(v) => {
                if (v === "list" || v === "calendar" || v === "history") {
                  setActiveListTab(v);
                }
              }}
              className="shrink-0"
            >
              <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
                <TabsTrigger
                  value="list"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconList size={14} stroke={1.5} />
                  List
                </TabsTrigger>
                <TabsTrigger
                  value="calendar"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconLayoutGrid size={14} stroke={1.5} />
                  Calendar
                </TabsTrigger>
                {showRunHistoryTab && (
                  <TabsTrigger
                    value="history"
                    className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                  >
                    <IconRotateClockwise2 size={14} stroke={1.5} />
                    Run History
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px]">
          {activeListTab !== "history" ? (
            <div className="zero-card overflow-hidden pb-3">
              {isInitialLoading ? (
                activeListTab === "calendar" ? (
                  <ScheduleCalendarSkeleton />
                ) : (
                  <ScheduleListSkeleton />
                )
              ) : activeListTab === "list" ? (
                <ScheduleListView
                  entries={combinedSchedule}
                  togglingIds={togglingIds}
                  runningIds={runningIds}
                  getAgentLabel={(e) => {
                    return e.agentLabel;
                  }}
                  onEdit={openScheduleDetail}
                  onToggle={(entry, enabled) => {
                    handleToggle(entry, enabled);
                  }}
                  onDelete={handleDelete}
                  onNew={() => {
                    return setCreateOpen(true);
                  }}
                  onRunNow={(entry) => {
                    handleRunNow(entry);
                  }}
                  onOpenDetails={openScheduleDetail}
                />
              ) : (
                <ScheduleCalendarView
                  entries={combinedSchedule}
                  agentOrder={agentOrder}
                  getAgentLabel={(e) => {
                    return e.agentLabel;
                  }}
                  onEdit={openScheduleDetail}
                />
              )}
            </div>
          ) : (
            <AllScheduleRunHistoryTab />
          )}
        </div>
      </main>

      <ScheduleFormDialog
        open={createOpen}
        onClose={() => {
          return setCreateOpen(false);
        }}
        onSave={handleCreateSave}
        saving={saving}
        saveError={saveError}
        mode="create"
        agents={agents}
        initialValues={{
          agentId: defaultComposeId ?? agents[0]?.id ?? "",
        }}
      />
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setPendingDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule?</DialogTitle>
            <DialogDescription>
              This will permanently delete the schedule{" "}
              <span className="font-medium text-foreground">
                {pendingDelete?.name}
              </span>
              . This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => {
                return setPendingDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run History tab
// ---------------------------------------------------------------------------
// Cross-schedule run history for the current user in the active org.
// Mirrors the single-schedule Run History tab on /schedules/:id, but sources
// from /api/zero/logs?triggerSource=schedule (no scheduleId constraint).

function AllScheduleRunHistoryTab() {
  const pageSignal = useGet(pageSignal$);
  const dataLoadable = useLoadable(allScheduleRunData$);
  const hasPrev = useGet(allScheduleRunHasPrev$);
  const currentPage = useGet(allScheduleRunCurrentPage$);
  const rowsPerPage = useGet(allScheduleRunLimit$);
  const goToNext = useSet(goToNextAllScheduleRunPage$);
  const goToPrev = useSet(goToPrevAllScheduleRunPage$);
  const goForwardTwo = useSet(goForwardTwoAllScheduleRunPages$);
  const goBackTwo = useSet(goBackTwoAllScheduleRunPages$);
  const setRowsPerPage = useSet(setAllScheduleRunRowsPerPage$);

  const statusFilter = useGet(allScheduleRunStatusFilter$);
  const setStatusFilter = useSet(setAllScheduleRunStatusFilter$);
  const availableStatusesLoadable = useLoadable(
    allScheduleRunAvailableStatuses$,
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
      ? availableStatusesLoadable.data.map((s) => {
          return {
            value: s,
            label: STATUS_LABELS[s],
          };
        })
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            return setStatusFilter(v);
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
            {statusOptions.map((opt) => {
              return (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
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
            showDescription
            emptyTitle="No scheduled runs yet"
            emptyDescription="When any of your schedules runs, its history will show up here."
            filteredEmptyTitle="Nothing matches that filter"
            filteredEmptyDescription="Try a different status filter."
            hasActiveFilter={statusFilter !== "all"}
            minWidth="640px"
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
