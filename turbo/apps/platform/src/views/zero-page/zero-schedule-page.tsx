import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";
import { IconPencil, IconList, IconLayoutGrid } from "@tabler/icons-react";
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
import {
  DEFAULT_SCHEDULE,
  DUMMY_AGENT_SCHEDULE,
  getEntriesInCell,
  WEEKDAY_LABELS,
  CALENDAR_TIME_SLOTS,
  buildScheduleTimeString,
  parseScheduleTimeString,
  SCHEDULE_FREQUENCY_OPTIONS,
  SCHEDULE_LOOP_MINUTES,
  HOUR_OPTIONS,
  MINUTE_OPTIONS,
  TIMEZONE_OPTIONS,
  type ScheduleEntry,
} from "./zero-schedule-card";
import { ZERO_TEAM_JOBS } from "./zero-jobs-page";

type CombinedEntry = ScheduleEntry & { agentLabel: string };

function buildCombinedSchedule(
  zeroSchedule: ScheduleEntry[],
  jobSchedules: Record<string, ScheduleEntry[]>,
): CombinedEntry[] {
  const zeroEntries: CombinedEntry[] = zeroSchedule.map((e) => ({
    ...e,
    id: `zero-${e.id}`,
    agentLabel: "Zero",
  }));
  const jobEntries: CombinedEntry[] = ZERO_TEAM_JOBS.flatMap((job) =>
    (jobSchedules[job.id] ?? DUMMY_AGENT_SCHEDULE).map((e) => ({
      ...e,
      id: `job-${job.id}-${e.id}`,
      agentLabel: `${job.agentName} · ${job.title}`,
    })),
  );
  return [...zeroEntries, ...jobEntries];
}

const AGENT_ORDER: readonly string[] = [
  "Zero",
  ...ZERO_TEAM_JOBS.map((j) => `${j.agentName} · ${j.title}`),
];

const AGENT_CELL_CLASSES = [
  "bg-blue-700/15 border-blue-700/40 text-blue-800 dark:text-blue-200 dark:border-blue-600/40 dark:bg-blue-900/25",
  "bg-emerald-700/15 border-emerald-700/40 text-emerald-800 dark:text-emerald-200 dark:border-emerald-600/40 dark:bg-emerald-900/25",
  "bg-amber-700/15 border-amber-700/40 text-amber-800 dark:text-amber-200 dark:border-amber-600/40 dark:bg-amber-900/25",
  "bg-violet-700/15 border-violet-700/40 text-violet-800 dark:text-violet-200 dark:border-violet-600/40 dark:bg-violet-900/25",
  "bg-teal-700/15 border-teal-700/40 text-teal-800 dark:text-teal-200 dark:border-teal-600/40 dark:bg-teal-900/25",
] as const;

function getAgentCellClasses(agentLabel: string): string {
  const i = AGENT_ORDER.indexOf(agentLabel);
  return AGENT_CELL_CLASSES[i !== -1 ? i % AGENT_CELL_CLASSES.length : 0];
}

const JOB_INITIAL_PROMPTS: Readonly<Record<string, string>> = {
  "1": "Compile the daily digest from Slack and email; highlight items that need follow-up.",
  "2": "Triage new GitHub issues, suggest labels and assignees, and post a short summary in #eng.",
  "3": "Draft the weekly team report from the last 7 days and save to the shared drive.",
  "4": "Summarize new customer feedback from Zendesk and Notion; flag recurring themes.",
};

const initialJobSchedules: Readonly<
  Record<string, readonly Readonly<ScheduleEntry>[]>
> = Object.fromEntries(
  ZERO_TEAM_JOBS.map((job) => [
    job.id,
    [
      {
        id: "j1",
        time: DUMMY_AGENT_SCHEDULE[0].time,
        prompt: JOB_INITIAL_PROMPTS[job.id] ?? DUMMY_AGENT_SCHEDULE[0].prompt,
      },
    ],
  ]),
);

export function ZeroSchedulePage() {
  const scheduleViewMode$ = useCCState<"list" | "calendar">("list");
  const scheduleViewMode = useGet(scheduleViewMode$);
  const setScheduleViewMode = useSet(scheduleViewMode$);
  const zeroSchedule$ = useCCState<ScheduleEntry[]>([...DEFAULT_SCHEDULE]);
  const zeroSchedule = useGet(zeroSchedule$);
  const setZeroSchedule = useSet(zeroSchedule$);
  const jobSchedules$ = useCCState<Record<string, ScheduleEntry[]>>(
    Object.fromEntries(
      Object.entries(initialJobSchedules).map(([k, v]) => [k, [...v]]),
    ),
  );
  const jobSchedules = useGet(jobSchedules$);
  const setJobSchedules = useSet(jobSchedules$);
  const editingEntry$ = useCCState<CombinedEntry | null>(null);
  const editingEntry = useGet(editingEntry$);
  const setEditingEntry = useSet(editingEntry$);
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

  const combinedSchedule = buildCombinedSchedule(zeroSchedule, jobSchedules);

  const openEditSchedule = (entry: CombinedEntry) => {
    setEditingEntry(entry);
    setNewSchedulePrompt(entry.prompt);
    const parsed = parseScheduleTimeString(entry.time);
    setScheduleFreq(parsed.freq);
    setScheduleDate(parsed.date);
    setScheduleHour(parsed.hour);
    setScheduleMinute(parsed.minute);
    setScheduleTimezone(parsed.timezone);
    setScheduleLoopMinutes(parsed.loopMinutes);
  };

  const saveScheduleEdit = () => {
    if (!editingEntry || !newSchedulePrompt.trim()) {
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
    const id = editingEntry.id;
    if (id.startsWith("zero-")) {
      const baseId = id.slice("zero-".length);
      setZeroSchedule((prev) =>
        prev.map((e) =>
          e.id === baseId
            ? { ...e, time: timeStr, prompt: newSchedulePrompt.trim() }
            : e,
        ),
      );
    } else if (id.startsWith("job-")) {
      const parts = id.split("-");
      const jobId = parts[1];
      const entryId = parts.slice(2).join("-");
      setJobSchedules((prev) => ({
        ...prev,
        [jobId]: (prev[jobId] ?? []).map((e) =>
          e.id === entryId
            ? { ...e, time: timeStr, prompt: newSchedulePrompt.trim() }
            : e,
        ),
      }));
    }
    setEditingEntry(null);
    setNewSchedulePrompt("");
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Schedule
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Schedules for Zero and all sub-agents.
            </p>
          </div>
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
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="py-5 flex flex-col gap-6">
              {scheduleViewMode === "list" && (
                <ul className="flex flex-col" role="list">
                  {combinedSchedule.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-b-0 text-sm text-foreground hover:bg-muted/30 -mx-1 px-1 rounded transition-colors"
                    >
                      <span className="w-[180px] shrink-0 text-muted-foreground text-xs truncate">
                        {entry.agentLabel}
                      </span>
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
                                combinedSchedule,
                                dayIndex,
                                timeLabel,
                              ) as CombinedEntry[];
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
                                              className={cn(
                                                "w-full min-h-0 rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                getAgentCellClasses(
                                                  entry.agentLabel,
                                                ),
                                              )}
                                              aria-label={`${entry.agentLabel}: ${entry.prompt}`}
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
                                              <p className="text-xs text-muted-foreground font-medium">
                                                {entry.agentLabel}
                                              </p>
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
                    const loopEntries = combinedSchedule.filter((e) =>
                      e.time.match(/Every \d+ minutes?/),
                    );
                    const onceEntries = combinedSchedule.filter((e) =>
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
                                  <span className="shrink-0 text-muted-foreground text-xs">
                                    {entry.agentLabel}
                                  </span>
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
                                  <span className="shrink-0 text-muted-foreground text-xs">
                                    {entry.agentLabel}
                                  </span>
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
          </Card>
        </div>
      </main>

      <Dialog
        open={editingEntry !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingEntry(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md gap-6">
          <DialogHeader>
            <DialogTitle>Edit schedule</DialogTitle>
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
              onClick={() => setEditingEntry(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={saveScheduleEdit}
              disabled={!newSchedulePrompt.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
