"use client";

import { useState } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  scheduleViewMode$,
  setScheduleViewMode$,
  internalScheduleList$,
  setScheduleList$,
  addScheduleOpen$,
  setAddScheduleOpen$,
  editingScheduleId$,
  setEditingScheduleId$,
  saveError$,
  setSaveError$,
  togglingIds$,
  setTogglingIds$,
  calendarPopoverEntryId$,
  setCalendarPopoverEntryId$,
} from "../../signals/zero-page/schedule-card.ts";
import {
  IconPlus,
  IconList,
  IconLayoutGrid,
  IconPencil,
  IconTrash,
} from "@tabler/icons-react";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import {
  Card,
  CardContent,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
} from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import { throwIfAbort, detach, Reason } from "../../signals/utils.ts";
import {
  ScheduleFormDialog,
  type ScheduleFormValues,
} from "./schedule-dialog.tsx";
import emptyScheduleImg from "./assets/empty-schedule.webp";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { getBrowserTimezone } from "../../signals/zero-page/cron.ts";

export const WEEKDAY_LABELS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;
const CALENDAR_TIME_SLOTS = [
  "6:00 AM",
  "9:00 AM",
  "12:00 PM",
  "6:00 PM",
] as const;

export interface ScheduleEntry {
  id: string;
  time: string;
  prompt: string;
  description?: string | null;
  /** Schedule name used for API operations (edit/delete). */
  name?: string;
  enabled?: boolean;
  notifyEmail?: boolean;
  notifySlack?: boolean;
  /** IANA timezone from the server (not derivable from `time` alone). */
  timezone?: string;
  slackChannelId?: string | null;
  /** Raw interval in seconds for loop schedules */
  intervalSeconds?: number | null;
}

function DeleteButton({
  name,
  label,
  onDelete,
}: {
  name: string;
  label: string;
  onDelete: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
        aria-label={`Delete ${label}`}
      >
        <IconTrash size={14} stroke={1.5} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule?</DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              This will permanently delete the schedule{" "}
              <span className="font-medium text-foreground">{name}</span>. This
              action cannot be undone.
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                detach(onDelete(name), Reason.DomCallback);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function formatTimeOfDay(hour: number, minute: number): string {
  if (hour === 0 && minute === 0) {
    return "12:00 AM";
  }
  if (hour < 12) {
    return `${hour}:${minute.toString().padStart(2, "0")} AM`;
  }
  if (hour === 12) {
    return `12:${minute.toString().padStart(2, "0")} PM`;
  }
  return `${hour - 12}:${minute.toString().padStart(2, "0")} PM`;
}

function buildScheduleTimeString(params: {
  freq: string;
  date?: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes?: number;
}): string {
  const { freq, date, hour, minute, loopMinutes } = params;
  const timeStr = formatTimeOfDay(hour, minute);
  if (freq === "now") {
    return "Now";
  }
  if (freq === "once" && date) {
    return `Once on ${date} at ${timeStr}`;
  }
  if (freq === "every_weekday") {
    return `Every weekday at ${timeStr}`;
  }
  if (freq === "every_day") {
    return `Every day at ${timeStr}`;
  }
  if (freq === "every_week") {
    return `Every week at ${timeStr}`;
  }
  if (freq === "every_month") {
    return `Every month at ${timeStr}`;
  }
  if (freq === "every_n_minutes" && loopMinutes) {
    return `Every ${loopMinutes} minutes`;
  }
  return `Every day at ${timeStr}`;
}

interface ParsedScheduleTime {
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes: number;
  dayOfWeek?: string;
  dayOfMonth?: string;
}

function parse12hTo24h(h: string, ampm: string): number {
  let hour = Number.parseInt(h, 10);
  if (ampm === "PM" && hour !== 12) {
    hour += 12;
  }
  if (ampm === "AM" && hour === 12) {
    hour = 0;
  }
  return hour;
}

function defaultParsed(
  overrides: Partial<ParsedScheduleTime>,
): ParsedScheduleTime {
  return {
    freq: "every_day",
    date: new Date().toISOString().slice(0, 10),
    hour: 9,
    minute: 0,
    timezone: "UTC",
    loopMinutes: 15,
    ...overrides,
  };
}

const DAY_NAME_TO_CRON: Readonly<Record<string, string>> = Object.freeze({
  Sunday: "0",
  Monday: "1",
  Tuesday: "2",
  Wednesday: "3",
  Thursday: "4",
  Friday: "5",
  Saturday: "6",
});

function parseWeeklyDays(timeStr: string): string {
  const weekDayMatch = timeStr.match(
    /on ((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:,\s*)?)+) at/,
  );
  if (!weekDayMatch) {
    return "1";
  }
  const names = weekDayMatch[1].split(/,\s*/);
  return names.map((n) => DAY_NAME_TO_CRON[n] ?? "1").join(",");
}

export function parseScheduleTimeString(timeStr: string): ParsedScheduleTime {
  if (timeStr === "Now") {
    return defaultParsed({ freq: "now" });
  }
  const loopMinMatch = timeStr.match(/Every (\d+) minutes?/);
  if (loopMinMatch) {
    return defaultParsed({
      freq: "every_n_minutes",
      loopMinutes: Number(loopMinMatch[1]) || 5,
    });
  }
  const loopSecMatch = timeStr.match(/Every (\d+) seconds?/);
  if (loopSecMatch) {
    return defaultParsed({
      freq: "every_n_minutes",
      loopMinutes: Math.round((Number(loopSecMatch[1]) || 300) / 60),
    });
  }
  const onceMatch = timeStr.match(
    /Once on (\d{4}-\d{2}-\d{2}) at (\d{1,2}):(\d{2}) (AM|PM)/,
  );
  if (onceMatch) {
    const [, date, h, m, ap] = onceMatch;
    return defaultParsed({
      freq: "once",
      date,
      hour: parse12hTo24h(h, ap),
      minute: Number.parseInt(m, 10),
    });
  }
  const atMatch = timeStr.match(/at (\d{1,2}):(\d{2}) (AM|PM)/);
  const hour = atMatch ? parse12hTo24h(atMatch[1], atMatch[3]) : 9;
  const minute = atMatch ? Number.parseInt(atMatch[2], 10) : 0;
  if (timeStr.startsWith("Every weekday")) {
    return defaultParsed({ freq: "every_weekday", hour, minute });
  }
  if (timeStr.startsWith("Every week")) {
    return defaultParsed({
      freq: "every_week",
      hour,
      minute,
      dayOfWeek: parseWeeklyDays(timeStr),
    });
  }
  if (timeStr.startsWith("Every month")) {
    const monthDayMatch = timeStr.match(/on day (\d+)/);
    return defaultParsed({
      freq: "every_month",
      hour,
      minute,
      dayOfMonth: monthDayMatch ? monthDayMatch[1] : "1",
    });
  }
  return defaultParsed({ hour, minute });
}

function parseScheduleTime(timeStr: string): {
  dayIndices: number[];
  timeLabel: string;
} {
  if (timeStr.match(/Every \d+ (minutes?|seconds?)/) || timeStr === "Now") {
    return { dayIndices: [], timeLabel: "" };
  }
  const match = timeStr.match(/at (\d{1,2}:\d{2} (?:AM|PM))$/);
  const timeLabel = match ? match[1] : "9:00 AM";
  if (timeStr.startsWith("Every day") && !timeStr.startsWith("Every weekday")) {
    return { dayIndices: [0, 1, 2, 3, 4, 5, 6], timeLabel };
  }
  if (timeStr.startsWith("Every weekday")) {
    return { dayIndices: [0, 1, 2, 3, 4], timeLabel };
  }
  const dayMap: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  const onMatch = timeStr.match(
    /on ((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:,\s*)?)+) at/,
  );
  if (onMatch) {
    const names = onMatch[1].split(/,\s*/);
    const indices = names.map((n) => dayMap[n] ?? -1).filter((i) => i >= 0);
    if (indices.length > 0) {
      return { dayIndices: indices, timeLabel };
    }
  }
  if (timeStr.startsWith("Every week")) {
    return { dayIndices: [0, 1, 2, 3, 4, 5, 6], timeLabel };
  }
  if (timeStr.startsWith("Every month")) {
    return { dayIndices: [], timeLabel: "" };
  }
  return { dayIndices: [], timeLabel };
}

/**
 * Convert a time label like "9:00 AM" to minutes since midnight.
 */
function timeLabelToMinutes(label: string): number {
  const match = label.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!match) {
    return 0;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3];
  if (ampm === "PM" && hour !== 12) {
    hour += 12;
  }
  if (ampm === "AM" && hour === 12) {
    hour = 0;
  }
  return hour * 60 + minute;
}

/**
 * Build the calendar time slots by merging default slots with entry-specific times,
 * sorted chronologically.
 */
export function buildCalendarTimeSlots(
  scheduleList: readonly Readonly<ScheduleEntry>[],
): string[] {
  const slotSet = new Set<string>(CALENDAR_TIME_SLOTS);
  for (const entry of scheduleList) {
    if (entry.enabled === false) {
      continue;
    }
    const { timeLabel } = parseScheduleTime(entry.time);
    if (timeLabel) {
      slotSet.add(timeLabel);
    }
  }
  return [...slotSet].sort(
    (a, b) => timeLabelToMinutes(a) - timeLabelToMinutes(b),
  );
}

export function getEntriesInCell(
  scheduleList: ScheduleEntry[],
  dayIndex: number,
  timeLabel: string,
): ScheduleEntry[] {
  return scheduleList.filter((entry) => {
    if (entry.enabled === false) {
      return false;
    }
    const { dayIndices, timeLabel: t } = parseScheduleTime(entry.time);
    return t === timeLabel && dayIndices.includes(dayIndex);
  });
}

function CalendarEntryPopover({
  entry,
  cellKey,
  onEdit,
}: {
  entry: ScheduleEntry;
  cellKey: string;
  onEdit: (entry: ScheduleEntry) => void;
}) {
  const hoveredId = useGet(calendarPopoverEntryId$);
  const setHoveredId = useSet(setCalendarPopoverEntryId$);
  const popoverId = `${entry.id}-${cellKey}`;
  const open = hoveredId === popoverId;
  const setOpen = (v: boolean) => setHoveredId(v ? popoverId : null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onDoubleClick={() => onEdit(entry)}
          className="w-full min-h-0 rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border border-blue-700/40 bg-blue-700/15 text-blue-800 hover:bg-blue-700/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/50 dark:text-blue-200 dark:border-blue-600/40 dark:bg-blue-900/25 dark:hover:bg-blue-900/35 text-left"
          aria-label={`${entry.time}: ${entry.description || entry.prompt}`}
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

interface ZeroScheduleCardProps {
  title: string;
  subtitle: string;
  initialSchedule: readonly Readonly<ScheduleEntry>[];
  /** When provided, called on save instead of local state mutation. */
  onSave?: (params: {
    prompt: string;
    description?: string;
    freq: string;
    date: string;
    hour: number;
    minute: number;
    timezone: string;
    intervalSeconds: number;
    dayOfWeek?: string;
    dayOfMonth?: string;
    editName?: string;
    notifyEmail?: boolean;
    notifySlack?: boolean;
    slackChannelId?: string | null;
  }) => Promise<void>;
  /** When provided, called to delete a schedule by name. */
  onDelete?: (name: string) => Promise<void>;
  /** When provided, called to toggle a schedule's enabled state. */
  onToggleEnabled?: (params: {
    name: string;
    enabled: boolean;
  }) => Promise<void>;
  /** When true, the save button shows a loading state. */
  saving?: boolean;
  /** Default timezone for new schedules. Falls back to browser timezone. */
  defaultTimezone?: string;
}

export function ZeroScheduleCard({
  title,
  subtitle,
  initialSchedule,
  onSave,
  onDelete,
  onToggleEnabled,
  saving,
  defaultTimezone,
}: ZeroScheduleCardProps) {
  const scheduleViewMode = useGet(scheduleViewMode$);
  const setScheduleViewMode = useSet(setScheduleViewMode$);
  const internalScheduleList = useGet(internalScheduleList$);
  const setScheduleList = useSet(setScheduleList$);
  // In API mode (onSave provided), use prop directly; otherwise use internal state
  const scheduleList = onSave ? [...initialSchedule] : internalScheduleList;
  const addScheduleOpen = useGet(addScheduleOpen$);
  const setAddScheduleOpen = useSet(setAddScheduleOpen$);
  const editingScheduleId = useGet(editingScheduleId$);
  const setEditingScheduleId = useSet(setEditingScheduleId$);
  const resolvedTimezone = defaultTimezone || getBrowserTimezone();
  const saveError = useGet(saveError$);
  const setSaveError = useSet(setSaveError$);
  const togglingIds = useGet(togglingIds$);
  const setTogglingIds = useSet(setTogglingIds$);

  const editingEntry = editingScheduleId
    ? (scheduleList.find((e) => e.id === editingScheduleId) ?? null)
    : null;

  const openAddSchedule = () => {
    setSaveError(null);
    setAddScheduleOpen(true);
  };

  const openEditSchedule = (entry: ScheduleEntry) => {
    setSaveError(null);
    setEditingScheduleId(entry.id);
  };

  const handleCreateSave = (values: ScheduleFormValues) => {
    if (onSave) {
      setSaveError(null);
      detach(
        onSave({
          prompt: values.prompt.trim(),
          description: values.description.trim() || undefined,
          freq: values.freq,
          date: values.date,
          hour: values.hour,
          minute: values.minute,
          timezone: values.timezone,
          intervalSeconds: values.loopMinutes * 60,
          dayOfWeek:
            values.freq === "every_week" ? values.dayOfWeek : undefined,
          dayOfMonth:
            values.freq === "every_month" ? values.dayOfMonth : undefined,
          notifyEmail: values.notifyEmail,
          notifySlack: values.notifySlack,
          slackChannelId: values.slackChannelId,
        })
          .then(() => {
            setAddScheduleOpen(false);
          })
          .catch((error: unknown) => {
            throwIfAbort(error);
            setSaveError(
              error instanceof Error
                ? error.message
                : "Failed to save schedule",
            );
          }),
        Reason.DomCallback,
      );
      return;
    }

    const timeStr = buildScheduleTimeString({
      freq: values.freq,
      date: values.freq === "once" ? values.date : undefined,
      hour: values.hour,
      minute: values.minute,
      timezone: values.timezone,
      loopMinutes:
        values.freq === "every_n_minutes" ? values.loopMinutes : undefined,
    });
    setScheduleList((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        time: timeStr,
        prompt: values.prompt.trim(),
      },
    ]);
    setAddScheduleOpen(false);
  };

  const handleEditSave = (values: ScheduleFormValues) => {
    if (onSave) {
      setSaveError(null);
      detach(
        onSave({
          prompt: values.prompt.trim(),
          description: values.description.trim() || undefined,
          freq: values.freq,
          date: values.date,
          hour: values.hour,
          minute: values.minute,
          timezone: values.timezone,
          intervalSeconds: values.loopMinutes * 60,
          dayOfWeek:
            values.freq === "every_week" ? values.dayOfWeek : undefined,
          dayOfMonth:
            values.freq === "every_month" ? values.dayOfMonth : undefined,
          editName: editingEntry?.name,
          notifyEmail: values.notifyEmail,
          notifySlack: values.notifySlack,
          slackChannelId: values.slackChannelId,
        })
          .then(() => {
            setEditingScheduleId(null);
          })
          .catch((error: unknown) => {
            throwIfAbort(error);
            setSaveError(
              error instanceof Error
                ? error.message
                : "Failed to save schedule",
            );
          }),
        Reason.DomCallback,
      );
      return;
    }

    if (editingScheduleId) {
      const timeStr = buildScheduleTimeString({
        freq: values.freq,
        date: values.freq === "once" ? values.date : undefined,
        hour: values.hour,
        minute: values.minute,
        timezone: values.timezone,
        loopMinutes:
          values.freq === "every_n_minutes" ? values.loopMinutes : undefined,
      });
      setScheduleList((prev) =>
        prev.map((e) =>
          e.id === editingScheduleId
            ? { ...e, time: timeStr, prompt: values.prompt.trim() }
            : e,
        ),
      );
      setEditingScheduleId(null);
    }
  };

  return (
    <Card className="zero-card">
      <CardContent className="py-5 flex flex-col gap-6">
        <header className="flex w-full flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="zero-btn-morandi h-9 gap-2 shrink-0 rounded-lg border"
            onClick={openAddSchedule}
          >
            <IconPlus size={14} stroke={2} />
            Add schedule
          </Button>
          <Tabs
            value={scheduleViewMode}
            onValueChange={(v) => setScheduleViewMode(v as "list" | "calendar")}
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
        </header>

        {scheduleViewMode === "list" && (
          <section className="flex flex-col">
            {scheduleList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <img
                  src={emptyScheduleImg}
                  alt="No entries"
                  loading="lazy"
                  className="h-20 w-20 object-contain opacity-80"
                />
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">
                    No runs scheduled
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Pick a time and tell your agent what to do.
                  </p>
                </div>
              </div>
            ) : (
              <ul className="flex flex-col" role="list">
                {scheduleList.map((entry) => {
                  const toggling = togglingIds.has(entry.id);
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0 text-sm text-foreground hover:bg-muted/30 -mx-1 px-1 rounded transition-colors"
                    >
                      {onToggleEnabled && entry.name !== undefined && (
                        <LoadingSwitch
                          checked={entry.enabled !== false}
                          loading={toggling}
                          onCheckedChange={(checked) => {
                            const id = entry.id;
                            const name = entry.name;
                            if (name === undefined) {
                              return;
                            }
                            setTogglingIds((prev) => new Set([...prev, id]));
                            detach(
                              onToggleEnabled({
                                name,
                                enabled: checked,
                              }).finally(() => {
                                setTogglingIds((prev) => {
                                  const next = new Set(prev);
                                  next.delete(id);
                                  return next;
                                });
                              }),
                              Reason.DomCallback,
                            );
                          }}
                          ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} ${entry.time}`}
                        />
                      )}
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
                        onClick={() => openEditSchedule(entry)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                        aria-label={`Edit ${entry.time}`}
                      >
                        <IconPencil size={14} stroke={1.5} />
                      </button>
                      {onDelete && entry.name !== undefined && (
                        <DeleteButton
                          name={entry.name}
                          label={entry.time}
                          onDelete={onDelete}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {scheduleViewMode === "calendar" &&
          (() => {
            const calendarSlots = buildCalendarTimeSlots(scheduleList);
            return (
              <section className="flex flex-col gap-8">
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Week view
                  </h3>
                  <div className="rounded-xl border border-border/70 bg-muted/20 overflow-hidden">
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
                            const entries = getEntriesInCell(
                              scheduleList,
                              dayIndex,
                              timeLabel,
                            );
                            const isEmpty = entries.length === 0;
                            const isLastRow =
                              timeIndex === calendarSlots.length - 1;
                            const isLastCol =
                              dayIndex === WEEKDAY_LABELS.length - 1;
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
                                    {entries.map((entry) => (
                                      <CalendarEntryPopover
                                        key={entry.id}
                                        entry={entry}
                                        cellKey={`${dayIndex}-${timeLabel}`}
                                        onEdit={openEditSchedule}
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
                {(() => {
                  const loopEntries = scheduleList.filter(
                    (e) =>
                      e.enabled !== false &&
                      e.time.match(/Every \d+ (minutes?|seconds?)/),
                  );
                  const onceEntries = scheduleList.filter(
                    (e) => e.enabled !== false && e.time.startsWith("Once on"),
                  );
                  const monthlyEntries = scheduleList.filter(
                    (e) =>
                      e.enabled !== false && e.time.startsWith("Every month"),
                  );
                  if (
                    loopEntries.length === 0 &&
                    onceEntries.length === 0 &&
                    monthlyEntries.length === 0
                  ) {
                    return null;
                  }
                  const sections: {
                    title: string;
                    entries: ScheduleEntry[];
                  }[] = [
                    { title: "Loop", entries: loopEntries },
                    { title: "Monthly", entries: monthlyEntries },
                    { title: "Once", entries: onceEntries },
                  ];
                  return (
                    <div className="flex flex-col gap-8">
                      {sections.map((section) =>
                        section.entries.length > 0 ? (
                          <div
                            key={section.title}
                            className="flex flex-col gap-1.5"
                          >
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {section.title}
                            </h3>
                            <div className="flex flex-wrap gap-2">
                              {section.entries.map((entry) => (
                                <div
                                  key={entry.id}
                                  className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm w-fit"
                                >
                                  <span className="text-foreground">
                                    {entry.time}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => openEditSchedule(entry)}
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
                  );
                })()}
              </section>
            );
          })()}
      </CardContent>

      {editingEntry &&
        (() => {
          const parsed = parseScheduleTimeString(editingEntry.time);
          return (
            <ScheduleFormDialog
              key={editingEntry.id}
              open
              mode="edit"
              onClose={() => setEditingScheduleId(null)}
              onSave={handleEditSave}
              saving={saving === true}
              saveError={saveError}
              initialValues={{
                prompt: editingEntry.prompt,
                description: editingEntry.description ?? "",
                freq: parsed.freq,
                date: parsed.date,
                hour: parsed.hour,
                minute: parsed.minute,
                timezone: editingEntry.timezone ?? parsed.timezone,
                loopMinutes:
                  editingEntry.intervalSeconds !== null &&
                  editingEntry.intervalSeconds !== undefined
                    ? Math.round(editingEntry.intervalSeconds / 60)
                    : parsed.loopMinutes,
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
        open={addScheduleOpen}
        mode="create"
        onClose={() => setAddScheduleOpen(false)}
        onSave={handleCreateSave}
        saving={saving === true}
        saveError={saveError}
        initialValues={{ timezone: resolvedTimezone }}
      />
    </Card>
  );
}
