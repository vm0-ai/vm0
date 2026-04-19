// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
"use client";

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
  openEditScheduleDialog$,
  togglingIds$,
  setTogglingIds$,
  runningIds$,
  setRunningIds$,
  pendingDeleteEntry$,
  setPendingDeleteEntry$,
  deletingSchedule$,
  setDeletingSchedule$,
} from "../../signals/zero-page/schedule-card.ts";
import { IconPlus, IconList, IconLayoutGrid } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  ScheduleFormDialog,
  type ScheduleFormValues,
} from "./schedule-dialog.tsx";
import { ScheduleCalendarView } from "./schedule-calendar-view.tsx";
import { ScheduleListView } from "./schedule-list-view.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";

import type { ScheduleEntry } from "./schedule-utils";

export { WEEKDAY_LABELS, type ScheduleEntry } from "./schedule-utils";

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
  return names
    .map((n) => {
      return DAY_NAME_TO_CRON[n] ?? "1";
    })
    .join(",");
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
    modelProviderId?: string | null;
    selectedModel?: string | null;
  }) => Promise<void>;
  /** When provided, called to delete a schedule by name. */
  onDelete?: (name: string) => Promise<void>;
  /** When provided, called to toggle a schedule's enabled state. */
  onToggleEnabled?: (params: {
    name: string;
    enabled: boolean;
  }) => Promise<void>;
  /** When provided, called to trigger an immediate run for a schedule. */
  onRunNow?: (entry: ScheduleEntry) => Promise<void>;
  /** When provided, row clicks navigate to the schedule detail. */
  onOpenDetails?: (entry: ScheduleEntry) => void;
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
  onRunNow,
  onOpenDetails,
  saving,
}: ZeroScheduleCardProps) {
  const signal = useGet(pageSignal$);
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
  const openEditDialog = useSet(openEditScheduleDialog$);
  const togglingIds = useGet(togglingIds$);
  const setTogglingIds = useSet(setTogglingIds$);

  const editingEntry = editingScheduleId
    ? (scheduleList.find((e) => {
        return e.id === editingScheduleId;
      }) ?? null)
    : null;

  const openAddSchedule = () => {
    detach(setAddScheduleOpen(true, signal), Reason.DomCallback);
  };

  const pendingDelete = useGet(pendingDeleteEntry$);
  const setPendingDelete = useSet(setPendingDeleteEntry$);
  const deleting = useGet(deletingSchedule$);
  const setDeleting = useSet(setDeletingSchedule$);

  const openEditSchedule = (entry: ScheduleEntry) => {
    const parsed = parseScheduleTimeString(entry.time);
    detach(
      openEditDialog(
        entry.id,
        {
          prompt: entry.prompt,
          description: entry.description ?? "",
          agentId: "",
          freq: parsed.freq,
          date: parsed.date,
          hour: parsed.hour,
          minute: parsed.minute,
          timezone: entry.timezone ?? parsed.timezone,
          loopMinutes: parsed.loopMinutes,
          dayOfWeek: "1",
          dayOfMonth: "1",
          modelProviderId: null,
          selectedModel: null,
        },
        signal,
      ),
      Reason.DomCallback,
    );
  };

  const handleToggle = onToggleEnabled
    ? (entry: ScheduleEntry, enabled: boolean) => {
        if (entry.name === undefined) {
          return;
        }
        const id = entry.id;
        setTogglingIds((prev) => {
          return new Set([...prev, id]);
        });
        detach(
          onToggleEnabled({ name: entry.name, enabled }).finally(() => {
            setTogglingIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }),
          Reason.DomCallback,
        );
      }
    : undefined;

  const handleDelete = onDelete
    ? (entry: ScheduleEntry) => {
        setPendingDelete(entry);
      }
    : undefined;

  const runningIds = useGet(runningIds$);
  const setRunningIds = useSet(setRunningIds$);

  const handleRunNow = onRunNow
    ? (entry: ScheduleEntry) => {
        const id = entry.id;
        setRunningIds((prev) => {
          return new Set([...prev, id]);
        });
        detach(
          onRunNow(entry).finally(() => {
            setRunningIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }),
          Reason.DomCallback,
        );
      }
    : undefined;

  const confirmDelete = () => {
    const entry = pendingDelete;
    if (!entry?.name || !onDelete) {
      return;
    }
    setDeleting(true);
    detach(
      onDelete(entry.name)
        .then(() => {
          setPendingDelete(null);
        })
        .finally(() => {
          setDeleting(false);
        }),
      Reason.DomCallback,
    );
  };

  const handleCreateSave = (values: ScheduleFormValues) => {
    if (onSave) {
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
          modelProviderId: values.modelProviderId,
          selectedModel: values.selectedModel,
        }).then(() => {
          return setAddScheduleOpen(false, signal);
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
    setScheduleList((prev) => {
      return [
        ...prev,
        {
          id: String(Date.now()),
          time: timeStr,
          prompt: values.prompt.trim(),
        },
      ];
    });
    detach(setAddScheduleOpen(false, signal), Reason.DomCallback);
  };

  const handleEditSave = (values: ScheduleFormValues) => {
    if (onSave) {
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
          modelProviderId: values.modelProviderId,
          selectedModel: values.selectedModel,
        }).then(() => {
          return setEditingScheduleId(null, signal);
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
      setScheduleList((prev) => {
        return prev.map((e) => {
          return e.id === editingScheduleId
            ? { ...e, time: timeStr, prompt: values.prompt.trim() }
            : e;
        });
      });
      detach(setEditingScheduleId(null, signal), Reason.DomCallback);
    }
  };

  return (
    <Card className="zero-card">
      <CardContent className="p-0 flex flex-col">
        <header className="flex flex-wrap items-end justify-between gap-4 px-5 pt-5 pb-4 border-b border-border/50">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
              onValueChange={(v) => {
                return setScheduleViewMode(v as "list" | "calendar");
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
              </TabsList>
            </Tabs>
          </div>
        </header>
        {scheduleViewMode === "list" && (
          <ScheduleListView
            entries={scheduleList}
            togglingIds={togglingIds}
            runningIds={runningIds}
            onEdit={openEditSchedule}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onRunNow={
              handleRunNow
                ? (entry) => {
                    detach(handleRunNow(entry), Reason.DomCallback);
                  }
                : undefined
            }
            onOpenDetails={onOpenDetails}
          />
        )}

        {scheduleViewMode === "calendar" && (
          <ScheduleCalendarView
            entries={scheduleList}
            onEdit={openEditSchedule}
          />
        )}
        <ScheduleFormDialog
          open={addScheduleOpen}
          onClose={() => {
            return detach(
              setAddScheduleOpen(false, signal),
              Reason.DomCallback,
            );
          }}
          onSave={handleCreateSave}
          saving={!!saving}
          mode="create"
        />
        <ScheduleFormDialog
          open={editingScheduleId !== null}
          onClose={() => {
            return detach(
              setEditingScheduleId(null, signal),
              Reason.DomCallback,
            );
          }}
          onSave={handleEditSave}
          saving={!!saving}
          mode="edit"
          initialValues={
            editingEntry
              ? {
                  prompt: editingEntry.prompt,
                  description: editingEntry.description ?? "",
                  freq: parseScheduleTimeString(editingEntry.time).freq,
                  date: parseScheduleTimeString(editingEntry.time).date,
                  hour: parseScheduleTimeString(editingEntry.time).hour,
                  minute: parseScheduleTimeString(editingEntry.time).minute,
                  timezone:
                    editingEntry.timezone ??
                    parseScheduleTimeString(editingEntry.time).timezone,
                  loopMinutes: parseScheduleTimeString(editingEntry.time)
                    .loopMinutes,
                }
              : undefined
          }
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
      </CardContent>
    </Card>
  );
}
