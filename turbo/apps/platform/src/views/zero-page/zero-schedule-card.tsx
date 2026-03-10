"use client";

import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";
import {
  IconPlus,
  IconList,
  IconLayoutGrid,
  IconPencil,
} from "@tabler/icons-react";
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

export const SCHEDULE_FREQUENCY_OPTIONS = [
  { value: "now", label: "Now" },
  { value: "once", label: "Once" },
  { value: "every_weekday", label: "Every weekday" },
  { value: "every_day", label: "Every day" },
  { value: "every_week", label: "Every week" },
  { value: "every_month", label: "Every month" },
  { value: "every_n_minutes", label: "Every N minutes" },
] as const;

export const SCHEDULE_LOOP_MINUTES = [5, 15, 30, 60] as const;
export const HOUR_OPTIONS: readonly number[] = Array.from(
  { length: 24 },
  (_, i) => i,
);
export const MINUTE_OPTIONS = [0, 15, 30, 45] as const;
export const TIMEZONE_OPTIONS = [
  "UTC",
  "Asia/Shanghai",
  "America/New_York",
  "Europe/London",
] as const;

export const WEEKDAY_LABELS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;
export const CALENDAR_TIME_SLOTS = [
  "6:00 AM",
  "9:00 AM",
  "12:00 PM",
  "6:00 PM",
] as const;

export interface ScheduleEntry {
  id: string;
  time: string;
  prompt: string;
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

export function buildScheduleTimeString(params: {
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

export function parseScheduleTimeString(timeStr: string): {
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes: number;
} {
  const today = new Date();
  const defaultDate = today.toISOString().slice(0, 10);
  if (timeStr === "Now") {
    return {
      freq: "now",
      date: defaultDate,
      hour: 9,
      minute: 0,
      timezone: "UTC",
      loopMinutes: 15,
    };
  }
  const loopMatch = timeStr.match(/Every (\d+) minutes?/);
  if (loopMatch) {
    return {
      freq: "every_n_minutes",
      date: defaultDate,
      hour: 9,
      minute: 0,
      timezone: "UTC",
      loopMinutes: Number(loopMatch[1]) || 15,
    };
  }
  const onceMatch = timeStr.match(
    /Once on (\d{4}-\d{2}-\d{2}) at (\d{1,2}):(\d{2}) (AM|PM)/,
  );
  if (onceMatch) {
    const [, date, h, m, ap] = onceMatch;
    let hour = Number.parseInt(h, 10);
    if (ap === "PM" && hour !== 12) {
      hour += 12;
    }
    if (ap === "AM" && hour === 12) {
      hour = 0;
    }
    return {
      freq: "once",
      date,
      hour,
      minute: Number.parseInt(m, 10),
      timezone: "UTC",
      loopMinutes: 15,
    };
  }
  const atMatch = timeStr.match(/at (\d{1,2}):(\d{2}) (AM|PM)/);
  let hour = 9;
  let minute = 0;
  if (atMatch) {
    const [, h, m, ap] = atMatch;
    hour = Number.parseInt(h, 10);
    minute = Number.parseInt(m, 10);
    if (ap === "PM" && hour !== 12) {
      hour += 12;
    }
    if (ap === "AM" && hour === 12) {
      hour = 0;
    }
  }
  if (timeStr.startsWith("Every weekday")) {
    return {
      freq: "every_weekday",
      date: defaultDate,
      hour,
      minute,
      timezone: "UTC",
      loopMinutes: 15,
    };
  }
  if (timeStr.startsWith("Every day")) {
    return {
      freq: "every_day",
      date: defaultDate,
      hour,
      minute,
      timezone: "UTC",
      loopMinutes: 15,
    };
  }
  if (timeStr.startsWith("Every week")) {
    return {
      freq: "every_week",
      date: defaultDate,
      hour,
      minute,
      timezone: "UTC",
      loopMinutes: 15,
    };
  }
  if (timeStr.startsWith("Every month")) {
    return {
      freq: "every_month",
      date: defaultDate,
      hour,
      minute,
      timezone: "UTC",
      loopMinutes: 15,
    };
  }
  return {
    freq: "every_day",
    date: defaultDate,
    hour,
    minute,
    timezone: "UTC",
    loopMinutes: 15,
  };
}

function parseScheduleTime(timeStr: string): {
  dayIndices: number[];
  timeLabel: string;
} {
  if (timeStr.match(/Every \d+ minutes?/) || timeStr === "Now") {
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
  const dayMatch = timeStr.match(
    /on (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/,
  );
  const dayMap: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  if (dayMatch) {
    return { dayIndices: [dayMap[dayMatch[1]] ?? 0], timeLabel };
  }
  if (timeStr.startsWith("Every week")) {
    return { dayIndices: [0, 1, 2, 3, 4, 5, 6], timeLabel };
  }
  if (timeStr.startsWith("Every month")) {
    return { dayIndices: [0, 1, 2, 3, 4, 5, 6], timeLabel };
  }
  return { dayIndices: [], timeLabel };
}

export function getEntriesInCell(
  scheduleList: ScheduleEntry[],
  dayIndex: number,
  timeLabel: string,
): ScheduleEntry[] {
  return scheduleList.filter((entry) => {
    const { dayIndices, timeLabel: t } = parseScheduleTime(entry.time);
    return t === timeLabel && dayIndices.includes(dayIndex);
  });
}

export const DEFAULT_SCHEDULE: readonly Readonly<ScheduleEntry>[] = [
  {
    id: "1",
    time: "Every weekday at 9:00 AM",
    prompt:
      "Summarize yesterday's Slack threads and flag anything that needs a response.",
  },
  {
    id: "2",
    time: "Every 15 minutes",
    prompt:
      "Check inbox and calendar; notify me if something is time-sensitive.",
  },
  {
    id: "3",
    time: "Once on 2026-03-15 at 2:00 PM",
    prompt: "Generate the Q1 review report and email the link to stakeholders.",
  },
];

/** Dummy schedule for sub-agent (job) detail page — one entry per sub-agent. */
const DUMMY_AGENT_SCHEDULE: readonly Readonly<ScheduleEntry>[] = [
  {
    id: "j1",
    time: "Every weekday at 9:00 AM",
    prompt: "Run the usual morning briefing and post a short summary.",
  },
];
export { DUMMY_AGENT_SCHEDULE };

interface ZeroScheduleCardProps {
  title: string;
  subtitle: string;
  initialSchedule: readonly Readonly<ScheduleEntry>[];
}

export function ZeroScheduleCard({
  title,
  subtitle,
  initialSchedule,
}: ZeroScheduleCardProps) {
  const scheduleViewMode$ = useCCState<"list" | "calendar">("list");
  const scheduleViewMode = useGet(scheduleViewMode$);
  const setScheduleViewMode = useSet(scheduleViewMode$);
  const scheduleList$ = useCCState<ScheduleEntry[]>([...initialSchedule]);
  const scheduleList = useGet(scheduleList$);
  const setScheduleList = useSet(scheduleList$);
  const addScheduleOpen$ = useCCState(false);
  const addScheduleOpen = useGet(addScheduleOpen$);
  const setAddScheduleOpen = useSet(addScheduleOpen$);
  const editingScheduleId$ = useCCState<string | null>(null);
  const editingScheduleId = useGet(editingScheduleId$);
  const setEditingScheduleId = useSet(editingScheduleId$);
  const newSchedulePrompt$ = useCCState("");
  const newSchedulePrompt = useGet(newSchedulePrompt$);
  const setNewSchedulePrompt = useSet(newSchedulePrompt$);
  const scheduleFreq$ = useCCState<string>("every_day");
  const scheduleFreq = useGet(scheduleFreq$);
  const setScheduleFreq = useSet(scheduleFreq$);
  const scheduleDate$ = useCCState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const scheduleDate = useGet(scheduleDate$);
  const setScheduleDate = useSet(scheduleDate$);
  const scheduleHour$ = useCCState(9);
  const scheduleHour = useGet(scheduleHour$);
  const setScheduleHour = useSet(scheduleHour$);
  const scheduleMinute$ = useCCState(0);
  const scheduleMinute = useGet(scheduleMinute$);
  const setScheduleMinute = useSet(scheduleMinute$);
  const scheduleTimezone$ = useCCState("UTC");
  const scheduleTimezone = useGet(scheduleTimezone$);
  const setScheduleTimezone = useSet(scheduleTimezone$);
  const scheduleLoopMinutes$ = useCCState(15);
  const scheduleLoopMinutes = useGet(scheduleLoopMinutes$);
  const setScheduleLoopMinutes = useSet(scheduleLoopMinutes$);

  const openAddSchedule = () => {
    setEditingScheduleId(null);
    setNewSchedulePrompt("");
    setScheduleFreq("every_day");
    setScheduleDate(new Date().toISOString().slice(0, 10));
    setScheduleHour(9);
    setScheduleMinute(0);
    setScheduleTimezone("UTC");
    setScheduleLoopMinutes(15);
    setAddScheduleOpen(true);
  };

  const openEditSchedule = (entry: ScheduleEntry) => {
    setEditingScheduleId(entry.id);
    setNewSchedulePrompt(entry.prompt);
    const parsed = parseScheduleTimeString(entry.time);
    setScheduleFreq(parsed.freq);
    setScheduleDate(parsed.date);
    setScheduleHour(parsed.hour);
    setScheduleMinute(parsed.minute);
    setScheduleTimezone(parsed.timezone);
    setScheduleLoopMinutes(parsed.loopMinutes);
    setAddScheduleOpen(true);
  };

  const addScheduleEntry = () => {
    if (!newSchedulePrompt.trim()) {
      return;
    }
    const timeStr = buildScheduleTimeString({
      freq: scheduleFreq,
      date: scheduleFreq === "once" ? scheduleDate : undefined,
      hour: scheduleHour,
      minute: scheduleMinute,
      timezone: scheduleTimezone,
      loopMinutes:
        scheduleFreq === "every_n_minutes" ? scheduleLoopMinutes : undefined,
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
              <p className="text-sm text-muted-foreground py-6 text-center">
                No entries yet. Add a time and prompt above.
              </p>
            ) : (
              <ul className="flex flex-col" role="list">
                {scheduleList.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0 text-sm text-foreground hover:bg-muted/30 -mx-1 px-1 rounded transition-colors"
                  >
                    <span className="min-w-0 shrink-0">{entry.time}</span>
                    <span className="min-w-0 flex-1 text-muted-foreground text-xs truncate">
                      {entry.prompt}
                    </span>
                    <button
                      type="button"
                      onClick={() => openEditSchedule(entry)}
                      className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                      aria-label={`Edit ${entry.time}`}
                    >
                      <IconPencil size={14} stroke={1.5} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {scheduleViewMode === "calendar" && (
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
                  {CALENDAR_TIME_SLOTS.map((timeLabel, timeIndex) => (
                    <div key={timeLabel} className="contents">
                      <div
                        className={cn(
                          "bg-muted/30 p-2 border-r border-border/60 text-muted-foreground text-xs flex items-center",
                          timeIndex < CALENDAR_TIME_SLOTS.length - 1 &&
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
                          timeIndex === CALENDAR_TIME_SLOTS.length - 1;
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
                                  <Popover key={entry.id}>
                                    <PopoverTrigger asChild>
                                      <button
                                        type="button"
                                        className="w-full min-h-0 rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border border-blue-700/40 bg-blue-700/15 text-blue-800 hover:bg-blue-700/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600/50 dark:text-blue-200 dark:border-blue-600/40 dark:bg-blue-900/25 dark:hover:bg-blue-900/35 text-left"
                                        aria-label={`${entry.time}: ${entry.prompt}`}
                                      >
                                        {entry.prompt}
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent
                                      align="start"
                                      className="w-80 p-3 flex flex-col gap-3"
                                    >
                                      <div className="relative flex flex-col gap-1.5 pr-8">
                                        <div className="absolute top-0 right-0">
                                          <button
                                            type="button"
                                            onClick={() =>
                                              openEditSchedule(entry)
                                            }
                                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                                            aria-label={`Edit ${entry.time}`}
                                          >
                                            <IconPencil
                                              size={14}
                                              stroke={1.5}
                                            />
                                          </button>
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                          {entry.time}
                                        </p>
                                        <p className="text-sm text-foreground leading-snug">
                                          {entry.prompt}
                                        </p>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
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
              const loopEntries = scheduleList.filter((e) =>
                e.time.match(/Every \d+ minutes?/),
              );
              const onceEntries = scheduleList.filter((e) =>
                e.time.startsWith("Once on"),
              );
              if (loopEntries.length === 0 && onceEntries.length === 0) {
                return null;
              }
              return (
                <div className="flex flex-col gap-8">
                  {loopEntries.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Loop
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {loopEntries.map((entry) => (
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
                  )}
                  {onceEntries.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Once
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {onceEntries.map((entry) => (
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
                  )}
                </div>
              );
            })()}
          </section>
        )}
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
        <DialogContent className="sm:max-w-md gap-6">
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
                rows={3}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 resize-y min-h-[72px]"
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
                  Every
                </label>
                <Select
                  value={String(scheduleLoopMinutes)}
                  onValueChange={(v) => setScheduleLoopMinutes(Number(v))}
                >
                  <SelectTrigger id="schedule-dialog-loop" className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_LOOP_MINUTES.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} minutes
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                  onChange={(e) => setScheduleDate(e.target.value)}
                  className="h-9"
                />
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
                      {MINUTE_OPTIONS.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m.toString().padStart(2, "0")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {(scheduleFreq === "once" ||
              scheduleFreq === "every_weekday" ||
              scheduleFreq === "every_day" ||
              scheduleFreq === "every_week" ||
              scheduleFreq === "every_month") && (
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
                    {TIMEZONE_OPTIONS.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddScheduleOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={addScheduleEntry}
              disabled={!newSchedulePrompt.trim()}
            >
              {editingScheduleId ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
