import { useState } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  addScheduleOpen$,
  setAddScheduleOpen$,
  editingScheduleId$,
  setEditingScheduleId$,
} from "../../signals/zero-page/schedule-card.ts";
import {
  IconPencil,
  IconList,
  IconLayoutGrid,
  IconTrash,
  IconPlus,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import {
  Card,
  CardContent,
  Tabs,
  TabsList,
  TabsTrigger,
  Button,
  cn,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import {
  getEntriesInCell,
  buildCalendarTimeSlots,
  WEEKDAY_LABELS,
  parseScheduleTimeString,
  type ScheduleEntry,
} from "./zero-schedule-card";
import {
  ScheduleFormDialog,
  type ScheduleFormValues,
} from "./schedule-dialog.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { agentsList$ } from "../../signals/zero-page/agents-list.ts";
import { detach, throwIfAbort, Reason } from "../../signals/utils.ts";
import {
  allOrgScheduleEntries$,
  allOrgSchedulesLoaded$,
  saveOrgSchedule$,
  toggleOrgScheduleEnabled$,
  deleteOrgSchedule$,
  type OrgScheduleEntry,
} from "../../signals/zero-page/zero-schedule.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import emptyScheduleImg from "./assets/empty-schedule.webp";

type CombinedEntry = ScheduleEntry & {
  agentLabel: string;
  agentId: string;
  timezone: string;
};

function buildCombinedSchedule(
  entries: OrgScheduleEntry[],
  agentName: string,
  defaultComposeId: string | null,
  nameToDisplay: Map<string, string>,
): CombinedEntry[] {
  return entries.map((e) => ({
    id: e.id,
    time: e.time,
    prompt: e.prompt,
    description: e.description,
    enabled: e.enabled,
    notifyEmail: e.notifyEmail,
    notifySlack: e.notifySlack,
    slackChannelId: e.slackChannelId,
    name: e.name,
    intervalSeconds: e.intervalSeconds,
    agentLabel:
      e.agentId === defaultComposeId
        ? agentName
        : (nameToDisplay.get(e.agentName) ?? e.agentName),
    agentId: e.agentId,
    timezone: e.timezone,
  }));
}

const AGENT_CELL_CLASSES = [
  "bg-blue-700/15 border-blue-700/40 text-blue-800 dark:text-blue-200 dark:border-blue-600/40 dark:bg-blue-900/25",
  "bg-emerald-700/15 border-emerald-700/40 text-emerald-800 dark:text-emerald-200 dark:border-emerald-600/40 dark:bg-emerald-900/25",
  "bg-amber-700/15 border-amber-700/40 text-amber-800 dark:text-amber-200 dark:border-amber-600/40 dark:bg-amber-900/25",
  "bg-violet-700/15 border-violet-700/40 text-violet-800 dark:text-violet-200 dark:border-violet-600/40 dark:bg-violet-900/25",
  "bg-teal-700/15 border-teal-700/40 text-teal-800 dark:text-teal-200 dark:border-teal-600/40 dark:bg-teal-900/25",
] as const;

function getAgentCellClasses(
  agentLabel: string,
  agentOrder: readonly string[],
): string {
  const i = agentOrder.indexOf(agentLabel);
  return AGENT_CELL_CLASSES[i !== -1 ? i % AGENT_CELL_CLASSES.length : 0];
}

// ---------------------------------------------------------------------------
// Calendar entry popover (hover to show, double-click to edit)
// ---------------------------------------------------------------------------

function CalendarEntryPopover({
  entry,
  cellKey,
  agentOrder,
  onEdit,
  hoveredId,
  setHoveredId,
}: {
  entry: CombinedEntry;
  cellKey: string;
  agentOrder: readonly string[];
  onEdit: (entry: CombinedEntry) => void;
  hoveredId: string | null;
  setHoveredId: (id: string | null) => void;
}) {
  const popoverId = `${entry.id}-${cellKey}`;
  const open = hoveredId === popoverId;
  const setOpen = (v: boolean) => setHoveredId(v ? popoverId : null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setHoveredId(popoverId)}
          onMouseLeave={() => setHoveredId(null)}
          onDoubleClick={() => onEdit(entry)}
          className={cn(
            "w-full min-h-0 rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            getAgentCellClasses(entry.agentLabel, agentOrder),
          )}
          aria-label={`${entry.agentLabel}: ${entry.description || entry.prompt}`}
        >
          {entry.description || entry.prompt}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={0}
        className="w-80 p-3 flex flex-col gap-3"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="relative flex flex-col gap-1.5 pr-8">
          <div className="absolute top-0 right-0">
            <button
              type="button"
              onClick={() => onEdit(entry)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label={`Edit ${entry.time}`}
            >
              <IconPencil size={14} stroke={1.5} />
            </button>
          </div>
          <p className="text-xs text-muted-foreground font-medium">
            {entry.agentLabel}
          </p>
          <p className="text-xs text-muted-foreground">{entry.time}</p>
          {entry.description && (
            <p className="text-sm font-medium text-foreground leading-snug">
              {entry.description}
            </p>
          )}
          <p className="text-sm text-foreground leading-snug">{entry.prompt}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Calendar view
// ---------------------------------------------------------------------------

function ScheduleCalendarView({
  combinedSchedule,
  agentOrder,
  onEdit,
}: {
  combinedSchedule: CombinedEntry[];
  agentOrder: readonly string[];
  onEdit: (entry: CombinedEntry) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const enabledEntries = combinedSchedule.filter((e) => e.enabled !== false);
  const calendarSlots = buildCalendarTimeSlots(enabledEntries);
  const [selectedDay, setSelectedDay] = useState(
    new Date().getDay() === 0 ? 6 : new Date().getDay() - 1,
  );

  const loopEntries = enabledEntries.filter((e) =>
    e.time.match(/Every \d+ (minutes?|seconds?)/),
  );
  const onceEntries = enabledEntries.filter((e) =>
    e.time.startsWith("Once on"),
  );
  const monthlyEntries = enabledEntries.filter((e) =>
    e.time.startsWith("Every month"),
  );

  const sections: { title: string; entries: CombinedEntry[] }[] = [
    { title: "Loop", entries: loopEntries },
    { title: "Monthly", entries: monthlyEntries },
    { title: "Once", entries: onceEntries },
  ];

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Week view
        </h3>
        <div className="rounded-xl border border-border/70 bg-muted/20 overflow-hidden">
          {/* Mobile: single-day view */}
          <div className="md:hidden">
            <div className="flex items-center justify-between bg-muted/50 px-3 py-2 border-b border-border/60">
              <button
                type="button"
                onClick={() =>
                  setSelectedDay(
                    (selectedDay - 1 + WEEKDAY_LABELS.length) %
                      WEEKDAY_LABELS.length,
                  )
                }
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Previous day"
              >
                <IconChevronLeft size={16} stroke={1.5} />
              </button>
              <span className="text-sm font-medium text-muted-foreground">
                {WEEKDAY_LABELS[selectedDay]}
              </span>
              <button
                type="button"
                onClick={() =>
                  setSelectedDay((selectedDay + 1) % WEEKDAY_LABELS.length)
                }
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Next day"
              >
                <IconChevronRight size={16} stroke={1.5} />
              </button>
            </div>
            {calendarSlots.map((timeLabel, timeIndex) => {
              const cellEntries = getEntriesInCell(
                enabledEntries,
                selectedDay,
                timeLabel,
              ) as CombinedEntry[];
              const isEmpty = cellEntries.length === 0;
              const isLastRow = timeIndex === calendarSlots.length - 1;
              return (
                <div
                  key={timeLabel}
                  className={cn(
                    "flex",
                    !isLastRow && "border-b border-border/60",
                  )}
                >
                  <div className="w-16 shrink-0 bg-muted/30 p-2 border-r border-border/60 text-muted-foreground text-xs flex items-center">
                    {timeLabel}
                  </div>
                  <div
                    className={cn(
                      "flex-1 min-h-[52px] p-1.5 flex items-center justify-center",
                      isEmpty && "bg-background/50",
                    )}
                  >
                    {isEmpty ? (
                      <span className="text-muted-foreground/40 text-xs">
                        —
                      </span>
                    ) : (
                      <div className="w-full min-h-[44px] rounded-lg p-1.5 flex flex-col gap-0.5 text-left">
                        {cellEntries.map((entry) => (
                          <CalendarEntryPopover
                            key={entry.id}
                            entry={entry}
                            cellKey={`${selectedDay}-${timeLabel}`}
                            agentOrder={agentOrder}
                            onEdit={onEdit}
                            hoveredId={hoveredId}
                            setHoveredId={setHoveredId}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* Desktop: full week grid */}
          <div className="hidden md:block">
            <div className="grid grid-cols-8 text-sm">
              <div className="bg-muted/50 p-2 border-b border-r border-border/60 font-medium text-muted-foreground text-xs uppercase tracking-wider" />
              {WEEKDAY_LABELS.map((d, dayIndex) => (
                <div
                  key={d}
                  className={cn(
                    "bg-muted/50 p-2 border-b border-border/60 font-medium text-muted-foreground text-center",
                    dayIndex < WEEKDAY_LABELS.length - 1 &&
                      "border-r border-border/60",
                  )}
                >
                  {d}
                </div>
              ))}
              {calendarSlots.map((timeLabel, timeIndex) => (
                <div key={timeLabel} className="contents">
                  <div
                    className={cn(
                      "bg-muted/30 p-2 border-r border-border/60 text-muted-foreground text-xs flex items-center",
                      timeIndex < calendarSlots.length - 1 &&
                        "border-b border-border/60",
                    )}
                  >
                    {timeLabel}
                  </div>
                  {WEEKDAY_LABELS.map((_, dayIndex) => {
                    const cellEntries = getEntriesInCell(
                      enabledEntries,
                      dayIndex,
                      timeLabel,
                    ) as CombinedEntry[];
                    const isEmpty = cellEntries.length === 0;
                    const isLastRow = timeIndex === calendarSlots.length - 1;
                    const isLastCol = dayIndex === WEEKDAY_LABELS.length - 1;
                    return (
                      <div
                        key={`${timeLabel}-${dayIndex}`}
                        className={cn(
                          "min-h-[52px] p-1.5 border-border/60 flex items-center justify-center",
                          !isLastCol && "border-r border-border/60",
                          !isLastRow && "border-b border-border/60",
                          isEmpty && "bg-background/50",
                        )}
                      >
                        {isEmpty ? (
                          <span className="text-muted-foreground/40 text-xs">
                            —
                          </span>
                        ) : (
                          <div className="w-full h-full min-h-[44px] rounded-lg p-1.5 flex flex-col gap-0.5 text-left">
                            {cellEntries.map((entry) => (
                              <CalendarEntryPopover
                                key={entry.id}
                                entry={entry}
                                cellKey={`${dayIndex}-${timeLabel}`}
                                agentOrder={agentOrder}
                                onEdit={onEdit}
                                hoveredId={hoveredId}
                                setHoveredId={setHoveredId}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {sections.some((s) => s.entries.length > 0) && (
        <div className="flex flex-col gap-8">
          {sections.map((section) =>
            section.entries.length > 0 ? (
              <div key={section.title} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.title}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {section.entries.map((entry) => (
                    <div
                      key={entry.id}
                      className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm w-fit"
                    >
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {entry.agentLabel}
                      </span>
                      <span className="text-foreground">{entry.time}</span>
                      <button
                        type="button"
                        onClick={() => onEdit(entry)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`Edit ${entry.time}`}
                      >
                        <IconPencil size={12} stroke={1.5} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null,
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const SKELETON_LIST_KEYS = ["s-0", "s-1", "s-2", "s-3", "s-4"] as const;
const SKELETON_ROW_KEYS = ["r-0", "r-1", "r-2", "r-3"] as const;

function ScheduleListSkeleton() {
  return (
    <ul className="flex flex-col" role="list">
      {SKELETON_LIST_KEYS.map((key) => (
        <li
          key={key}
          className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0 -mx-1 px-1"
        >
          <Skeleton className="h-5 w-9 rounded-full shrink-0" />
          <Skeleton className="h-3.5 w-[100px] shrink-0" />
          <Skeleton className="h-3.5 w-[120px] shrink-0" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-6 w-6 rounded shrink-0" />
        </li>
      ))}
    </ul>
  );
}

function ScheduleCalendarSkeleton() {
  return (
    <section className="flex flex-col gap-2">
      <Skeleton className="h-4 w-20" />
      <div className="rounded-xl border border-border/70 bg-muted/20 overflow-hidden">
        <div className="grid grid-cols-8">
          <div className="bg-muted/50 p-2 border-b border-r border-border/60 h-9" />
          {WEEKDAY_LABELS.map((d) => (
            <div
              key={d}
              className="bg-muted/50 p-2 border-b border-border/60 flex justify-center"
            >
              <Skeleton className="h-4 w-8" />
            </div>
          ))}
          {SKELETON_ROW_KEYS.map((rowKey, row) => (
            <div key={rowKey} className="contents">
              <div className="bg-muted/30 p-2 border-r border-b border-border/60 flex items-center">
                <Skeleton className="h-3 w-12" />
              </div>
              {WEEKDAY_LABELS.map((day, col) => (
                <div
                  key={`${rowKey}-${day}`}
                  className="min-h-[52px] p-1.5 border-r border-b border-border/60 flex items-center justify-center"
                >
                  {(row + col) % 3 === 0 && (
                    <Skeleton className="h-6 w-full rounded" />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ScheduleListView({
  combinedSchedule,
  onEdit,
  onToggle,
  onDelete,
  onNew,
}: {
  combinedSchedule: CombinedEntry[];
  onEdit: (entry: CombinedEntry) => void;
  onToggle: (entry: CombinedEntry, enabled: boolean) => Promise<void>;
  onDelete: (entry: CombinedEntry) => void;
  onNew?: () => void;
}) {
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  if (combinedSchedule.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <img
          src={emptyScheduleImg}
          alt="No schedules"
          loading="lazy"
          className="h-20 w-20 object-contain opacity-80"
        />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            Nothing on the calendar
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Set up a schedule and your agents will handle the rest.
          </p>
        </div>
        {onNew && (
          <Button
            variant="outline"
            size="sm"
            className="zero-btn-morandi mt-2 h-9 gap-2 rounded-lg border"
            onClick={onNew}
          >
            <IconPlus size={14} stroke={2} />
            Add schedule
          </Button>
        )}
      </div>
    );
  }

  return (
    <ul className="flex flex-col" role="list">
      {combinedSchedule.map((entry) => {
        const toggling = togglingIds.has(entry.id);
        return (
          <li
            key={entry.id}
            className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0 text-sm text-foreground hover:bg-muted/30 -mx-1 px-1 rounded transition-colors"
          >
            <LoadingSwitch
              checked={entry.enabled !== false}
              loading={toggling}
              onCheckedChange={(checked) => {
                const id = entry.id;
                setTogglingIds((prev) => new Set([...prev, id]));
                onToggle(entry, checked)
                  .finally(() => {
                    setTogglingIds((prev) => {
                      const next = new Set(prev);
                      next.delete(id);
                      return next;
                    });
                  })
                  .catch(() => {});
              }}
              ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} ${entry.time}`}
            />
            <span className="w-[100px] sm:w-[140px] shrink-0 text-muted-foreground text-xs truncate">
              {entry.agentLabel}
            </span>
            <span
              className={cn(
                "min-w-0 shrink-0",
                entry.enabled === false && "text-muted-foreground",
              )}
            >
              {entry.time}
            </span>
            <span className="min-w-0 flex-1 text-muted-foreground text-xs truncate">
              {entry.description || entry.prompt}
            </span>
            <button
              type="button"
              onClick={() => onEdit(entry)}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
              aria-label={`Edit ${entry.time}`}
            >
              <IconPencil size={14} stroke={1.5} />
            </button>
            {entry.name !== undefined && (
              <button
                type="button"
                onClick={() => onDelete(entry)}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label={`Delete ${entry.time}`}
              >
                <IconTrash size={14} stroke={1.5} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ZeroSchedulePage() {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";

  const statusLoadable = useLoadable(zeroOnboardingStatus$);
  const defaultComposeId =
    statusLoadable.state === "hasData"
      ? statusLoadable.data.defaultAgentComposeId
      : null;

  const entriesLoadable = useLastLoadable(allOrgScheduleEntries$);
  const entries: OrgScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const agentsLoadable = useLoadable(agentsList$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const nameToDisplay = new Map(
    agents.filter((a) => a.displayName).map((a) => [a.name, a.displayName!]),
  );
  const loaded = useGet(allOrgSchedulesLoaded$);
  const isInitialLoading = !loaded;

  const saveSchedule = useSet(saveOrgSchedule$);
  const toggleEnabled = useSet(toggleOrgScheduleEnabled$);
  const deleteSchedule = useSet(deleteOrgSchedule$);

  const [scheduleViewMode, setScheduleViewMode] = useState<"list" | "calendar">(
    "list",
  );
  const createOpen = useGet(addScheduleOpen$);
  const setCreateOpen = useSet(setAddScheduleOpen$);
  const editingScheduleId = useGet(editingScheduleId$);
  const setEditingId = useSet(setEditingScheduleId$);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CombinedEntry | null>(
    null,
  );

  const combinedSchedule = buildCombinedSchedule(
    entries,
    agentName,
    defaultComposeId,
    nameToDisplay,
  );

  const editingEntry =
    combinedSchedule.find((e) => e.id === editingScheduleId) ?? null;

  const agentOrder = [
    ...new Set(combinedSchedule.map((e) => e.agentLabel)),
  ] as const;

  const openEditSchedule = (entry: CombinedEntry) => {
    setEditingId(entry.id);
  };

  const handleCreateSave = (values: ScheduleFormValues) => {
    setSaving(true);
    setSaveError(null);
    detach(
      saveSchedule({
        prompt: values.prompt.trim(),
        description: values.description.trim() || undefined,
        freq: values.freq,
        date: values.date,
        hour: values.hour,
        minute: values.minute,
        timezone: values.timezone,
        intervalSeconds: values.loopMinutes * 60,
        agentId: values.composeId,
        notifyEmail: values.notifyEmail,
        notifySlack: values.notifySlack,
        slackChannelId: values.slackChannelId,
      })
        .then(() => {
          setCreateOpen(false);
        })
        .catch((error: unknown) => {
          throwIfAbort(error);
          setSaveError(
            error instanceof Error ? error.message : "Failed to save schedule",
          );
        })
        .finally(() => {
          setSaving(false);
        }),
      Reason.DomCallback,
    );
  };

  const handleEditSave = (values: ScheduleFormValues) => {
    if (!editingEntry) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    detach(
      saveSchedule({
        prompt: values.prompt.trim(),
        description: values.description.trim() || undefined,
        freq: values.freq,
        date: values.date,
        hour: values.hour,
        minute: values.minute,
        timezone: values.timezone,
        intervalSeconds: values.loopMinutes * 60,
        editName: editingEntry.name,
        agentId: editingEntry.agentId,
        notifyEmail: values.notifyEmail,
        notifySlack: values.notifySlack,
        slackChannelId: values.slackChannelId,
      })
        .then(() => {
          setEditingId(null);
        })
        .catch((error: unknown) => {
          throwIfAbort(error);
          setSaveError(
            error instanceof Error ? error.message : "Failed to save schedule",
          );
        })
        .finally(() => {
          setSaving(false);
        }),
      Reason.DomCallback,
    );
  };

  const handleToggle = async (entry: CombinedEntry, enabled: boolean) => {
    if (entry.name === undefined) {
      return;
    }
    await toggleEnabled({
      name: entry.name,
      enabled,
      agentId: entry.agentId,
    });
  };

  const handleDelete = (entry: CombinedEntry) => {
    if (entry.name === undefined) {
      return;
    }
    setPendingDelete(entry);
  };

  const confirmDelete = () => {
    if (pendingDelete?.name === undefined) {
      return;
    }
    detach(
      deleteSchedule({
        name: pendingDelete.name,
        agentId: pendingDelete.agentId,
      }),
      Reason.DomCallback,
    );
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
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
              onClick={() => setCreateOpen(true)}
            >
              <IconPlus size={14} stroke={2} />
              Add schedule
            </Button>
            <Tabs
              value={scheduleViewMode}
              onValueChange={(v) =>
                setScheduleViewMode(v as "list" | "calendar")
              }
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
              </TabsList>
            </Tabs>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="py-5 flex flex-col gap-6">
              {isInitialLoading ? (
                scheduleViewMode === "calendar" ? (
                  <ScheduleCalendarSkeleton />
                ) : (
                  <ScheduleListSkeleton />
                )
              ) : scheduleViewMode === "list" ? (
                <ScheduleListView
                  combinedSchedule={combinedSchedule}
                  onEdit={openEditSchedule}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onNew={() => setCreateOpen(true)}
                />
              ) : (
                <ScheduleCalendarView
                  combinedSchedule={combinedSchedule}
                  agentOrder={agentOrder}
                  onEdit={openEditSchedule}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {editingEntry &&
        (() => {
          const parsed = parseScheduleTimeString(editingEntry.time);
          return (
            <ScheduleFormDialog
              key={editingEntry.id}
              open
              mode="edit"
              onClose={() => setEditingId(null)}
              onSave={handleEditSave}
              saving={saving}
              saveError={saveError}
              initialValues={{
                prompt: editingEntry.prompt,
                description: editingEntry.description ?? "",
                freq: parsed.freq,
                date: parsed.date,
                hour: parsed.hour,
                minute: parsed.minute,
                timezone: editingEntry.timezone ?? parsed.timezone,
                loopMinutes: parsed.loopMinutes,
                dayOfWeek: parsed.dayOfWeek ?? "1",
                dayOfMonth: parsed.dayOfMonth ?? "1",
                notifyEmail: editingEntry.notifyEmail ?? false,
                notifySlack: editingEntry.notifySlack ?? false,
                slackChannelId: editingEntry.slackChannelId ?? null,
              }}
            />
          );
        })()}
      <ScheduleFormDialog
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onSave={handleCreateSave}
        saving={saving}
        saveError={saveError}
        agents={agents}
        initialValues={{
          composeId: defaultComposeId ?? agents[0]?.id ?? "",
        }}
      />
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule?</DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              This will permanently delete the schedule{" "}
              <span className="font-medium text-foreground">
                {pendingDelete?.name}
              </span>
              . This action cannot be undone.
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
