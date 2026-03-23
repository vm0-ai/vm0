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
  newSchedulePrompt$,
  setNewSchedulePrompt$,
  scheduleFreq$,
  setScheduleFreq$,
  scheduleDate$,
  setScheduleDate$,
  scheduleHour$,
  setScheduleHour$,
  scheduleMinute$,
  setScheduleMinute$,
  scheduleTimezone$,
  setScheduleTimezone$,
  scheduleIntervalStr$,
  setScheduleIntervalStr$,
  scheduleDayOfWeek$,
  setScheduleDayOfWeek$,
  scheduleDayOfMonth$,
  setScheduleDayOfMonth$,
  newScheduleDescription$,
  setNewScheduleDescription$,
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
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
import { throwIfAbort, detach, Reason } from "../../signals/utils.ts";
import emptyScheduleImg from "./assets/empty-schedule.webp";
import {
  COMMON_TIMEZONES,
  getTodayDateLocal,
  getBrowserTimezone,
} from "../../signals/zero-page/cron.ts";

export const SCHEDULE_FREQUENCY_OPTIONS = [
  { value: "now", label: "Now" },
  { value: "once", label: "Once" },
  { value: "every_weekday", label: "Every weekday" },
  { value: "every_day", label: "Every day" },
  { value: "every_week", label: "Every week" },
  { value: "every_month", label: "Every month" },
  { value: "every_n_minutes", label: "Loop" },
] as const;

export const SCHEDULE_LOOP_MINUTES = [5, 15, 30, 60] as const;
export const HOUR_OPTIONS: readonly number[] = Array.from(
  { length: 24 },
  (_, i) => i,
);
const MINUTE_OPTIONS: readonly number[] = Array.from(
  { length: 12 },
  (_, i) => i * 5,
);

/**
 * Build the minute dropdown options, inserting a non-standard value (e.g. an
 * existing schedule whose minute is not a multiple of 5) so the schedule
 * remains editable.
 */
export function getMinuteOptions(currentMinute?: number): readonly number[] {
  if (currentMinute === undefined || MINUTE_OPTIONS.includes(currentMinute)) {
    return MINUTE_OPTIONS;
  }
  return [...MINUTE_OPTIONS, currentMinute].sort((a, b) => a - b);
}

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
  onEdit,
}: {
  entry: ScheduleEntry;
  onEdit: (entry: ScheduleEntry) => void;
}) {
  const hoveredId = useGet(calendarPopoverEntryId$);
  const setHoveredId = useSet(setCalendarPopoverEntryId$);
  const open = hoveredId === entry.id;
  const setOpen = (v: boolean) => setHoveredId(v ? entry.id : null);

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
  const newSchedulePrompt = useGet(newSchedulePrompt$);
  const setNewSchedulePrompt = useSet(setNewSchedulePrompt$);
  const scheduleFreq = useGet(scheduleFreq$);
  const setScheduleFreq = useSet(setScheduleFreq$);
  const scheduleDate = useGet(scheduleDate$);
  const setScheduleDate = useSet(setScheduleDate$);
  const scheduleHour = useGet(scheduleHour$);
  const setScheduleHour = useSet(setScheduleHour$);
  const scheduleMinute = useGet(scheduleMinute$);
  const setScheduleMinute = useSet(setScheduleMinute$);
  const resolvedTimezone = defaultTimezone || getBrowserTimezone();
  const scheduleTimezone = useGet(scheduleTimezone$);
  const setScheduleTimezone = useSet(setScheduleTimezone$);
  const scheduleIntervalStr = useGet(scheduleIntervalStr$);
  const setScheduleIntervalStr = useSet(setScheduleIntervalStr$);
  const scheduleDayOfWeek = useGet(scheduleDayOfWeek$);
  const setScheduleDayOfWeek = useSet(setScheduleDayOfWeek$);
  const scheduleDayOfMonth = useGet(scheduleDayOfMonth$);
  const setScheduleDayOfMonth = useSet(setScheduleDayOfMonth$);
  const newScheduleDescription = useGet(newScheduleDescription$);
  const setNewScheduleDescription = useSet(setNewScheduleDescription$);
  const saveError = useGet(saveError$);
  const setSaveError = useSet(setSaveError$);
  const togglingIds = useGet(togglingIds$);
  const setTogglingIds = useSet(setTogglingIds$);

  const openAddSchedule = () => {
    setEditingScheduleId(null);
    setNewSchedulePrompt("");
    setNewScheduleDescription("");
    setScheduleFreq("every_day");
    setScheduleDate(new Date().toISOString().slice(0, 10));
    setScheduleHour(9);
    setScheduleMinute(0);
    setScheduleTimezone(resolvedTimezone);
    setScheduleIntervalStr("300");
    setScheduleDayOfWeek("1");
    setScheduleDayOfMonth("1");
    setSaveError(null);
    setAddScheduleOpen(true);
  };

  const openEditSchedule = (entry: ScheduleEntry) => {
    setEditingScheduleId(entry.id);
    setNewSchedulePrompt(entry.prompt);
    setNewScheduleDescription(entry.description ?? "");
    const parsed = parseScheduleTimeString(entry.time);
    setScheduleFreq(parsed.freq);
    setScheduleDate(parsed.date);
    setScheduleHour(parsed.hour);
    setScheduleMinute(parsed.minute);
    setScheduleTimezone(parsed.timezone);
    setScheduleIntervalStr(
      String(entry.intervalSeconds ?? (parsed.loopMinutes ?? 5) * 60),
    );
    setScheduleDayOfWeek(parsed.dayOfWeek ?? "1");
    setScheduleDayOfMonth(parsed.dayOfMonth ?? "1");
    setSaveError(null);
    setAddScheduleOpen(true);
  };

  const addScheduleEntry = async () => {
    if (!newSchedulePrompt.trim()) {
      return;
    }

    if (onSave) {
      // Find the editing entry's name for API update
      const editingEntry = editingScheduleId
        ? scheduleList.find((e) => e.id === editingScheduleId)
        : null;
      try {
        setSaveError(null);
        await onSave({
          prompt: newSchedulePrompt.trim(),
          description: newScheduleDescription.trim() || undefined,
          freq: scheduleFreq,
          date: scheduleDate,
          hour: scheduleHour,
          minute: scheduleMinute,
          timezone: scheduleTimezone,
          intervalSeconds: Number(scheduleIntervalStr) || 0,
          dayOfWeek:
            scheduleFreq === "every_week" ? scheduleDayOfWeek : undefined,
          dayOfMonth:
            scheduleFreq === "every_month" ? scheduleDayOfMonth : undefined,
          editName: editingEntry?.name,
        });
      } catch (error) {
        throwIfAbort(error);
        setSaveError(
          error instanceof Error ? error.message : "Failed to save schedule",
        );
        return;
      }
      setNewSchedulePrompt("");
      setEditingScheduleId(null);
      setAddScheduleOpen(false);
      return;
    }

    const timeStr = buildScheduleTimeString({
      freq: scheduleFreq,
      date: scheduleFreq === "once" ? scheduleDate : undefined,
      hour: scheduleHour,
      minute: scheduleMinute,
      timezone: scheduleTimezone,
      loopMinutes:
        scheduleFreq === "every_n_minutes"
          ? Math.round((Number(scheduleIntervalStr) || 0) / 60)
          : undefined,
    });
    if (editingScheduleId) {
      setScheduleList((prev) =>
        prev.map((e) =>
          e.id === editingScheduleId
            ? { ...e, time: timeStr, prompt: newSchedulePrompt.trim() }
            : e,
        ),
      );
      setEditingScheduleId(null);
    } else {
      setScheduleList((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          time: timeStr,
          prompt: newSchedulePrompt.trim(),
        },
      ]);
    }
    setNewSchedulePrompt("");
    setAddScheduleOpen(false);
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

      <Dialog
        open={addScheduleOpen}
        onOpenChange={(open) => {
          setAddScheduleOpen(open);
          if (!open) {
            setEditingScheduleId(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg gap-6">
          <DialogHeader>
            <DialogTitle>
              {editingScheduleId ? "Edit schedule" : "Add schedule"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label
                htmlFor="schedule-dialog-prompt"
                className="text-sm font-medium text-foreground"
              >
                Prompt
              </label>
              <textarea
                id="schedule-dialog-prompt"
                value={newSchedulePrompt}
                onChange={(e) => setNewSchedulePrompt(e.target.value)}
                placeholder="Describe your task and instruction"
                rows={5}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 resize-y min-h-[120px]"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="schedule-dialog-description"
                className="text-sm font-medium text-foreground"
              >
                Description
                <span className="text-muted-foreground font-normal ml-1">
                  (optional)
                </span>
              </label>
              <Input
                id="schedule-dialog-description"
                value={newScheduleDescription}
                onChange={(e) => setNewScheduleDescription(e.target.value)}
                placeholder="Leave blank to auto-generate"
                className="h-9"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label
                htmlFor="schedule-dialog-freq"
                className="text-sm font-medium text-foreground"
              >
                Time
              </label>
              <Select value={scheduleFreq} onValueChange={setScheduleFreq}>
                <SelectTrigger id="schedule-dialog-freq" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_FREQUENCY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {scheduleFreq === "every_n_minutes" && (
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="schedule-dialog-loop"
                  className="text-sm font-medium text-foreground"
                >
                  Interval (seconds)
                </label>
                <Input
                  id="schedule-dialog-loop"
                  type="number"
                  min={0}
                  value={scheduleIntervalStr}
                  onChange={(e) => setScheduleIntervalStr(e.target.value)}
                  placeholder="300"
                  className="h-9"
                />
                <p className="text-xs text-muted-foreground">
                  Time between the end of one run and the start of the next. Use
                  0 for immediate restart.
                </p>
              </div>
            )}
            {scheduleFreq === "once" && (
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
                  value={scheduleDate}
                  min={getTodayDateLocal()}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  className="h-9"
                />
              </div>
            )}
            {scheduleFreq === "every_week" && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  Day of week
                </label>
                <div className="flex gap-1">
                  {(
                    [
                      ["1", "Mon"],
                      ["2", "Tue"],
                      ["3", "Wed"],
                      ["4", "Thu"],
                      ["5", "Fri"],
                      ["6", "Sat"],
                      ["0", "Sun"],
                    ] as const
                  ).map(([value, label]) => {
                    const selected = scheduleDayOfWeek
                      .split(",")
                      .includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`h-8 min-w-[40px] rounded-lg border text-xs font-medium transition-colors ${
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input bg-background text-muted-foreground hover:bg-muted"
                        }`}
                        onClick={() => {
                          const current = scheduleDayOfWeek
                            .split(",")
                            .filter(Boolean);
                          if (selected) {
                            if (current.length > 1) {
                              setScheduleDayOfWeek(
                                current.filter((d) => d !== value).join(","),
                              );
                            }
                          } else {
                            setScheduleDayOfWeek([...current, value].join(","));
                          }
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {scheduleFreq === "every_month" && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  Day of month
                </label>
                <Select
                  value={scheduleDayOfMonth}
                  onValueChange={setScheduleDayOfMonth}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 31 }, (_, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>
                        {i + 1}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {scheduleFreq !== "now" && scheduleFreq !== "every_n_minutes" && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground">
                  Time
                </label>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(scheduleHour)}
                    onValueChange={(v) => setScheduleHour(Number(v))}
                  >
                    <SelectTrigger className="h-9 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOUR_OPTIONS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {h.toString().padStart(2, "0")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">:</span>
                  <Select
                    value={String(scheduleMinute)}
                    onValueChange={(v) => setScheduleMinute(Number(v))}
                  >
                    <SelectTrigger className="h-9 w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getMinuteOptions(scheduleMinute).map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m.toString().padStart(2, "0")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {scheduleFreq !== "now" && scheduleFreq !== "every_n_minutes" && (
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="schedule-dialog-tz"
                  className="text-sm font-medium text-foreground"
                >
                  Timezone
                </label>
                <Select
                  value={scheduleTimezone}
                  onValueChange={setScheduleTimezone}
                >
                  <SelectTrigger id="schedule-dialog-tz" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMON_TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="zero-btn-morandi"
              onClick={() => setAddScheduleOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void addScheduleEntry()}
              disabled={!newSchedulePrompt.trim() || saving}
            >
              {saving ? "Saving…" : editingScheduleId ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
