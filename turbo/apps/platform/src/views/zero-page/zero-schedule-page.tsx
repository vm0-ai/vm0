import { useState } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  IconPencil,
  IconList,
  IconLayoutGrid,
  IconTrash,
  IconPlus,
  IconChevronLeft,
  IconChevronRight,
  IconPlayerPlay,
  IconDotsVertical,
} from "@tabler/icons-react";
import { LoadingSwitch } from "../components/loading-switch.tsx";
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
  cn,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import {
  getEntriesInCell,
  buildCalendarTimeSlots,
  WEEKDAY_LABELS,
  type ScheduleEntry,
} from "./zero-schedule-card";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { agentsList$ } from "../../signals/zero-page/agents-list.ts";
import { COMMON_TIMEZONES } from "../../signals/zero-page/cron.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  allOrgScheduleEntries$,
  allOrgSchedulesLoaded$,
  saveOrgSchedule$,
  toggleOrgScheduleEnabled$,
  deleteOrgSchedule$,
  runScheduleNow$,
  type OrgScheduleEntry,
  type ZeroScheduleSaveParams,
} from "../../signals/zero-page/zero-schedule.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import {
  agentsError$,
  agentsLoading$,
} from "../../signals/zero-page/zero-agents.ts";
import emptyScheduleImg from "./assets/empty-schedule.webp";
import { navigateTo$ } from "../../signals/route.ts";

export type CombinedEntry = ScheduleEntry & {
  agentLabel: string;
  agentName: string;
  agentId: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

export function buildCombinedSchedule(
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
    agentName: e.agentName,
    agentId: e.agentId,
    timezone: e.timezone,
    nextRunAt: e.nextRunAt,
    lastRunAt: e.lastRunAt,
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
  agentOrder,
  onEdit,
}: {
  entry: CombinedEntry;
  agentOrder: readonly string[];
  onEdit: (entry: CombinedEntry) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onDoubleClick={() => onEdit(entry)}
          className={cn(
            "w-full min-h-0 rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            getAgentCellClasses(entry.agentLabel, agentOrder),
          )}
          aria-label={`${entry.agentLabel}: ${entry.prompt}`}
        >
          {entry.prompt}
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
                            agentOrder={agentOrder}
                            onEdit={onEdit}
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
                                agentOrder={agentOrder}
                                onEdit={onEdit}
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

const HOUR_OPTIONS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

const MINUTE_OPTIONS: readonly number[] = Array.from(
  { length: 12 },
  (_, i) => i * 5,
);

function getMinuteOptions(currentMinute?: number): readonly number[] {
  if (currentMinute === undefined || MINUTE_OPTIONS.includes(currentMinute)) {
    return MINUTE_OPTIONS;
  }
  return [...MINUTE_OPTIONS, currentMinute].sort((a, b) => a - b);
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
            {SCHEDULE_FREQUENCY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
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
            onValueChange={(v) => setLoopMinutes(Number(v))}
          >
            <SelectTrigger id="schedule-dialog-loop" className="h-9 w-full">
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
            onChange={(e) => setDate(e.target.value)}
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
                onValueChange={(v) => setHour(Number(v))}
              >
                <SelectTrigger className="h-9 w-full">
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
            </div>
            <span className="shrink-0 text-muted-foreground">:</span>
            <div className="min-w-0 flex-1">
              <Select
                value={String(minute)}
                onValueChange={(v) => setMinute(Number(v))}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getMinuteOptions(minute).map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {m.toString().padStart(2, "0")}
                    </SelectItem>
                  ))}
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
              {COMMON_TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

interface ScheduleCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (params: ZeroScheduleSaveParams & { agentId: string }) => void;
  saving: boolean;
  agents: { id: string; name: string; displayName?: string | null }[];
  defaultComposeId: string | null;
  agentsLoading: boolean;
  agentsError: string | null;
}

function ScheduleCreateDialogInner({
  onClose,
  onSave,
  saving,
  agents,
  defaultComposeId,
  agentsLoading,
  agentsError,
}: Omit<ScheduleCreateDialogProps, "open">) {
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState(
    defaultComposeId ?? agents[0]?.id ?? "",
  );
  const [freq, setFreq] = useState("every_day");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [timezone, setTimezone] = useState(
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [loopMinutes, setLoopMinutes] = useState(15);

  const handleSave = () => {
    if (!prompt.trim() || !agentId || agents.length === 0) {
      return;
    }
    onSave({
      prompt: prompt.trim(),
      freq,
      date,
      hour,
      minute,
      timezone,
      intervalSeconds: loopMinutes * 60,
      agentId,
    });
  };

  const canPickAgent = !agentsLoading && agents.length > 0 && !agentsError;
  const createDisabled = !prompt.trim() || !agentId || !canPickAgent || saving;

  return (
    <DialogContent className="sm:max-w-lg gap-6">
      <DialogHeader>
        <DialogTitle>New schedule</DialogTitle>
        <DialogDescription>
          Choose an agent, describe the task, and set when it should run.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="schedule-create-agent"
            className="text-sm font-medium text-foreground"
          >
            Agent
          </label>
          {agentsLoading ? (
            <p className="text-sm text-muted-foreground">Loading agents…</p>
          ) : agentsError ? (
            <p className="text-sm text-destructive">{agentsError}</p>
          ) : agents.length === 0 ? (
            <p className="text-sm text-muted-foreground leading-relaxed">
              No agents in this workspace yet. Create an agent from Team before
              adding a schedule.
            </p>
          ) : (
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger id="schedule-create-agent" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.displayName ?? a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <label
            htmlFor="schedule-create-prompt"
            className="text-sm font-medium text-foreground"
          >
            Prompt
          </label>
          <textarea
            id="schedule-create-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe your task and instruction"
            rows={5}
            className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20 resize-y min-h-[120px]"
          />
        </div>
        <ScheduleEditFields
          freq={freq}
          setFreq={setFreq}
          loopMinutes={loopMinutes}
          setLoopMinutes={setLoopMinutes}
          date={date}
          setDate={setDate}
          hour={hour}
          setHour={setHour}
          minute={minute}
          setMinute={setMinute}
          timezone={timezone}
          setTimezone={setTimezone}
        />
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          className="zero-btn-morandi"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={createDisabled}>
          {saving ? "Creating\u2026" : "Create"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ScheduleCreateDialog({
  open,
  onClose,
  ...rest
}: ScheduleCreateDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
    >
      {open && <ScheduleCreateDialogInner onClose={onClose} {...rest} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const SKELETON_LIST_KEYS = ["s-0", "s-1", "s-2", "s-3", "s-4"] as const;
const SKELETON_ROW_KEYS = ["r-0", "r-1", "r-2", "r-3"] as const;

function ScheduleListSkeleton() {
  return (
    <div className="w-full overflow-x-auto -mx-1">
      <table className="w-full text-sm border-collapse">
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
          {SKELETON_LIST_KEYS.map((key) => (
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
          ))}
        </tbody>
      </table>
    </div>
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

function ScheduleListAgentCell({ agentLabel }: { agentLabel: string }) {
  return (
    <span className="block min-w-0 truncate text-sm font-medium text-foreground">
      {agentLabel}
    </span>
  );
}

function ScheduleListView({
  combinedSchedule,
  togglingIds,
  runningIds,
  onEdit,
  onToggle,
  onDelete,
  onNew,
  onRunNow,
  onOpenDetails,
}: {
  combinedSchedule: CombinedEntry[];
  togglingIds: Set<string>;
  runningIds: Set<string>;
  onEdit: (entry: CombinedEntry) => void;
  onToggle: (entry: CombinedEntry, enabled: boolean) => Promise<void>;
  onDelete: (entry: CombinedEntry) => void;
  onNew?: () => void;
  onRunNow: (entry: CombinedEntry) => Promise<void>;
  onOpenDetails: (entry: CombinedEntry) => void;
}) {
  if (combinedSchedule.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <img
          src={emptyScheduleImg}
          alt="No schedules"
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
    <div className="w-full overflow-x-auto -mx-1">
      <table className="w-full text-sm border-collapse">
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
          {combinedSchedule.map((entry) => {
            const toggling = togglingIds.has(entry.id);
            const running = runningIds.has(entry.id);
            const dimmed = entry.enabled === false;
            return (
              <tr
                key={entry.id}
                className={cn(
                  "border-b border-border/50 last:border-0 transition-colors hover:bg-muted/25 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                  dimmed && "opacity-75",
                )}
                role="link"
                tabIndex={0}
                aria-label={`Open schedule ${entry.prompt}`}
                onClick={() => onOpenDetails(entry)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenDetails(entry);
                  }
                }}
              >
                <td className="py-2.5 pr-2 align-middle w-[5rem]">
                  <ScheduleListAgentCell agentLabel={entry.agentLabel} />
                </td>
                <td className="py-2.5 pr-4 align-middle min-w-0 max-w-[1px]">
                  <span
                    className={cn(
                      "text-sm text-foreground leading-snug block truncate whitespace-nowrap",
                      dimmed && "text-muted-foreground",
                    )}
                  >
                    {entry.prompt}
                  </span>
                </td>
                <td
                  className={cn(
                    "py-2.5 px-2 align-middle text-sm text-muted-foreground min-w-[6.5rem] max-w-[9rem] overflow-hidden",
                    dimmed && "text-muted-foreground/80",
                  )}
                >
                  <span className="block min-w-0 truncate whitespace-nowrap leading-snug tabular-nums">
                    {entry.time}
                    <span className="text-muted-foreground/70">
                      {" "}
                      · {entry.timezone.replace(/_/g, " ")}
                    </span>
                  </span>
                </td>
                <td
                  className="py-2.5 px-3 align-middle w-16"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex justify-center">
                    <LoadingSwitch
                      checked={entry.enabled !== false}
                      loading={toggling}
                      onCheckedChange={(checked) => {
                        onToggle(entry, checked).catch(() => {});
                      }}
                      ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} ${entry.time}`}
                    />
                  </div>
                </td>
                <td
                  className="py-2.5 pl-2 align-middle text-right w-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="inline-flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                          aria-label={`More actions for ${entry.time}`}
                        >
                          <IconDotsVertical size={14} stroke={1.5} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          disabled={running || !entry.prompt.trim()}
                          className="gap-2"
                          onClick={() => {
                            onRunNow(entry).catch(() => {});
                          }}
                        >
                          <IconPlayerPlay size={14} stroke={1.5} />
                          {running ? "Starting…" : "Run now"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="gap-2"
                          onClick={() => onEdit(entry)}
                        >
                          <IconPencil size={14} stroke={1.5} />
                          Edit
                        </DropdownMenuItem>
                        {entry.name !== undefined && (
                          <DropdownMenuItem
                            className="gap-2 text-destructive focus:text-destructive"
                            onClick={() => onDelete(entry)}
                          >
                            <IconTrash size={14} stroke={1.5} />
                            Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
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
      ? statusLoadable.data.defaultAgentId
      : null;

  const entriesLoadable = useLastLoadable(allOrgScheduleEntries$);
  const entries: OrgScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const agentsLoadable = useLoadable(agentsList$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const agentsLoading = useGet(agentsLoading$);
  const agentsError = useGet(agentsError$);
  const nameToDisplay = new Map(
    agents.filter((a) => a.displayName).map((a) => [a.id, a.displayName!]),
  );
  const loaded = useGet(allOrgSchedulesLoaded$);
  const isInitialLoading = !loaded;

  const saveSchedule = useSet(saveOrgSchedule$);
  const toggleEnabled = useSet(toggleOrgScheduleEnabled$);
  const deleteSchedule = useSet(deleteOrgSchedule$);
  const runScheduleNow = useSet(runScheduleNow$);
  const navigate = useSet(navigateTo$);

  const [scheduleViewMode, setScheduleViewMode] = useState<"list" | "calendar">(
    "list",
  );
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<CombinedEntry | null>(
    null,
  );

  const combinedSchedule = buildCombinedSchedule(
    entries,
    agentName,
    defaultComposeId,
    nameToDisplay,
  );

  const agentOrder = [
    ...new Set(combinedSchedule.map((e) => e.agentLabel)),
  ] as const;

  const openScheduleDetail = (entry: CombinedEntry) => {
    navigate("/schedule/:scheduleId", {
      pathParams: { scheduleId: entry.id },
    });
  };

  const handleCreateSave = (
    params: ZeroScheduleSaveParams & { agentId: string },
  ) => {
    setSaving(true);
    detach(
      saveSchedule(params)
        .then(() => {
          setCreateOpen(false);
        })
        .catch(() => {
          /* Error surfaced via toast in saveOrgSchedule$ */
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
    const id = entry.id;
    setTogglingIds((prev) => new Set([...prev, id]));
    try {
      await toggleEnabled({
        name: entry.name,
        enabled,
        agentId: entry.agentId,
      });
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleRunNow = async (entry: CombinedEntry) => {
    const id = entry.id;
    setRunningIds((prev) => new Set([...prev, id]));
    try {
      await runScheduleNow({
        composeId: entry.agentId,
        prompt: entry.prompt,
      });
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDelete = (entry: CombinedEntry) => {
    setPendingDelete(entry);
  };

  const confirmDelete = () => {
    const entry = pendingDelete;
    if (entry?.name === undefined) {
      return;
    }
    setPendingDelete(null);
    detach(
      deleteSchedule({ name: entry.name, agentId: entry.agentId }),
      Reason.DomCallback,
    );
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
              disabled={agents.length === 0}
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
            <CardContent className="pb-5 flex flex-col gap-6">
              {isInitialLoading ? (
                scheduleViewMode === "calendar" ? (
                  <ScheduleCalendarSkeleton />
                ) : (
                  <ScheduleListSkeleton />
                )
              ) : scheduleViewMode === "list" ? (
                <ScheduleListView
                  combinedSchedule={combinedSchedule}
                  togglingIds={togglingIds}
                  runningIds={runningIds}
                  onEdit={openScheduleDetail}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onNew={() => setCreateOpen(true)}
                  onRunNow={handleRunNow}
                  onOpenDetails={openScheduleDetail}
                />
              ) : (
                <ScheduleCalendarView
                  combinedSchedule={combinedSchedule}
                  agentOrder={agentOrder}
                  onEdit={openScheduleDetail}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      <ScheduleCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSave={handleCreateSave}
        saving={saving}
        agents={agents}
        defaultComposeId={defaultComposeId}
        agentsLoading={agentsLoading}
        agentsError={agentsError}
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
            <DialogDescription>
              This will permanently delete the schedule{" "}
              <span className="font-medium text-foreground">
                {pendingDelete?.name}
              </span>
              . This action cannot be undone.
            </DialogDescription>
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
