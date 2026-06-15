// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
"use client";

import { useGet, useSet } from "ccstate-react";
import {
  automationViewMode$,
  setAutomationViewMode$,
  addAutomationOpen$,
  setAddAutomationOpen$,
  editingAutomationId$,
  setEditingAutomationId$,
  openEditAutomationDialog$,
  togglingIds$,
  toggleAutomationCardEnabled$,
  runningIds$,
  setRunningIds$,
  pendingDeleteEntry$,
  setPendingDeleteEntry$,
  deletingAutomation$,
  setDeletingAutomation$,
} from "../../signals/zero-page/automation-card.ts";
import { IconPlus, IconList, IconLayoutGrid } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
import { nowDate } from "../../lib/time.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  AutomationFormDialog,
  type AutomationFormValues,
} from "./automation-dialog.tsx";
import { AutomationCalendarView } from "./automation-calendar-view.tsx";
import { AutomationListView } from "./automation-list-view.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";

import type { AutomationEntry } from "./automation-utils";

export { WEEKDAY_LABELS, type AutomationEntry } from "./automation-utils";

interface ParsedAutomationTime {
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
  overrides: Partial<ParsedAutomationTime>,
): ParsedAutomationTime {
  return {
    freq: "every_day",
    date: nowDate().toISOString().slice(0, 10),
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

export function parseAutomationTimeString(
  timeStr: string,
): ParsedAutomationTime {
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

interface ZeroAutomationCardProps {
  title: string;
  subtitle: string;
  initialAutomations: readonly Readonly<AutomationEntry>[];
  onSave: (params: {
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
  /** When provided, called to delete an automation by name. */
  onDelete?: (name: string) => Promise<void>;
  /** When provided, called to toggle an automation's enabled state. */
  onToggleEnabled?: (params: {
    name: string;
    enabled: boolean;
  }) => Promise<void>;
  /** When provided, called to trigger an immediate run for an automation. */
  onRunNow?: (entry: AutomationEntry) => Promise<void>;
  /** When provided, row clicks navigate to the automation detail. */
  onOpenDetails?: (entry: AutomationEntry) => void;
  /** When true, the save button shows a loading state. */
  saving?: boolean;
  /** Default timezone for new automations. Falls back to browser timezone. */
  defaultTimezone?: string;
}

export function ZeroAutomationCard({
  title,
  subtitle,
  initialAutomations,
  onSave,
  onDelete,
  onToggleEnabled,
  onRunNow,
  onOpenDetails,
  saving,
}: ZeroAutomationCardProps) {
  const signal = useGet(pageSignal$);
  const automationViewMode = useGet(automationViewMode$);
  const setAutomationViewMode = useSet(setAutomationViewMode$);
  const automationList = [...initialAutomations];
  const addAutomationOpen = useGet(addAutomationOpen$);
  const setAddAutomationOpen = useSet(setAddAutomationOpen$);
  const editingAutomationId = useGet(editingAutomationId$);
  const setEditingAutomationId = useSet(setEditingAutomationId$);
  const openEditDialog = useSet(openEditAutomationDialog$);
  const togglingIds = useGet(togglingIds$);
  const toggleAutomationCardEnabled = useSet(toggleAutomationCardEnabled$);

  const editingEntry = editingAutomationId
    ? (automationList.find((e) => {
        return e.id === editingAutomationId;
      }) ?? null)
    : null;

  const openAddAutomation = () => {
    detach(setAddAutomationOpen(true, signal), Reason.DomCallback);
  };

  const pendingDelete = useGet(pendingDeleteEntry$);
  const setPendingDelete = useSet(setPendingDeleteEntry$);
  const deleting = useGet(deletingAutomation$);
  const setDeleting = useSet(setDeletingAutomation$);

  const openEditAutomation = (entry: AutomationEntry) => {
    const parsed = parseAutomationTimeString(entry.time);
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
        },
        signal,
      ),
      Reason.DomCallback,
    );
  };

  const handleToggle = onToggleEnabled
    ? (entry: AutomationEntry, enabled: boolean) => {
        if (entry.name === undefined) {
          return;
        }
        detach(
          toggleAutomationCardEnabled(
            {
              id: entry.id,
              name: entry.name,
              enabled,
              onToggleEnabled,
            },
            signal,
          ),
          Reason.DomCallback,
        );
      }
    : undefined;

  const handleDelete = onDelete
    ? (entry: AutomationEntry) => {
        setPendingDelete(entry);
      }
    : undefined;

  const runningIds = useGet(runningIds$);
  const setRunningIds = useSet(setRunningIds$);

  const handleRunNow = onRunNow
    ? onDomEventFn(async (entry: AutomationEntry) => {
        const id = entry.id;
        setRunningIds((prev) => {
          return new Set([...prev, id]);
        });
        await bestEffort(onRunNow(entry));
        setRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      })
    : undefined;

  const confirmDelete = onDomEventFn(async () => {
    const entry = pendingDelete;
    if (!entry?.name || !onDelete) {
      return;
    }
    const name = entry.name;
    setDeleting(true);
    await bestEffort(
      (async () => {
        await onDelete(name);
        setPendingDelete(null);
      })(),
    );
    setDeleting(false);
  });

  const handleCreateSave = (values: AutomationFormValues) => {
    detach(
      (async () => {
        await onSave({
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
        });
        await setAddAutomationOpen(false, signal);
      })(),
      Reason.DomCallback,
    );
  };

  const handleEditSave = (values: AutomationFormValues) => {
    detach(
      (async () => {
        await onSave({
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
        });
        await setEditingAutomationId(null, signal);
      })(),
      Reason.DomCallback,
    );
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
              onClick={openAddAutomation}
            >
              <IconPlus size={14} stroke={2} />
              Add automation
            </Button>
            <Tabs
              value={automationViewMode}
              onValueChange={(v) => {
                return setAutomationViewMode(v as "list" | "calendar");
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
        {automationViewMode === "list" && (
          <AutomationListView
            entries={automationList}
            togglingIds={togglingIds}
            runningIds={runningIds}
            onEdit={openEditAutomation}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onRunNow={handleRunNow}
            onOpenDetails={onOpenDetails}
          />
        )}

        {automationViewMode === "calendar" && (
          <AutomationCalendarView
            entries={automationList}
            onEdit={openEditAutomation}
          />
        )}
        <AutomationFormDialog
          open={addAutomationOpen}
          onClose={() => {
            return detach(
              setAddAutomationOpen(false, signal),
              Reason.DomCallback,
            );
          }}
          onSave={handleCreateSave}
          saving={!!saving}
          mode="create"
        />
        <AutomationFormDialog
          open={editingAutomationId !== null}
          onClose={() => {
            return detach(
              setEditingAutomationId(null, signal),
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
                  freq: parseAutomationTimeString(editingEntry.time).freq,
                  date: parseAutomationTimeString(editingEntry.time).date,
                  hour: parseAutomationTimeString(editingEntry.time).hour,
                  minute: parseAutomationTimeString(editingEntry.time).minute,
                  timezone:
                    editingEntry.timezone ??
                    parseAutomationTimeString(editingEntry.time).timezone,
                  loopMinutes: parseAutomationTimeString(editingEntry.time)
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
              <DialogTitle>Delete automation?</DialogTitle>
              <DialogDescription>
                This will permanently delete the automation{" "}
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
