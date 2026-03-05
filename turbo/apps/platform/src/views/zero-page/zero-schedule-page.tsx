import { useState } from "react";
import { IconPencil, IconList, IconLayoutGrid } from "@tabler/icons-react";
import { Card, CardContent, Tabs, TabsList, TabsTrigger, cn } from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  DEFAULT_SCHEDULE,
  DUMMY_AGENT_SCHEDULE,
  getEntriesInCell,
  WEEKDAY_LABELS,
  CALENDAR_TIME_SLOTS,
  type ScheduleEntry,
} from "./zero-schedule-card";
import { ZERO_TEAM_JOBS } from "./zero-jobs-page";

type CombinedEntry = ScheduleEntry & { agentLabel: string };

function buildCombinedSchedule(): CombinedEntry[] {
  const zeroEntries: CombinedEntry[] = DEFAULT_SCHEDULE.map((e) => ({
    ...e,
    id: `zero-${e.id}`,
    agentLabel: "Zero",
  }));
  const jobEntries: CombinedEntry[] = ZERO_TEAM_JOBS.flatMap((job) =>
    DUMMY_AGENT_SCHEDULE.map((e) => ({
      ...e,
      id: `job-${job.id}-${e.id}`,
      agentLabel: `${job.agentName} · ${job.title}`,
    })),
  );
  return [...zeroEntries, ...jobEntries];
}

const COMBINED_SCHEDULE = buildCombinedSchedule();

const AGENT_ORDER = [
  "Zero",
  ...ZERO_TEAM_JOBS.map((j) => `${j.agentName} · ${j.title}`),
];

const AGENT_CELL_CLASSES = [
  "bg-blue-700/15 border-blue-700/40 text-blue-800 dark:text-blue-200 dark:border-blue-600/40 dark:bg-blue-900/25",
  "bg-emerald-700/15 border-emerald-700/40 text-emerald-800 dark:text-emerald-200 dark:border-emerald-600/40 dark:bg-emerald-900/25",
  "bg-amber-700/15 border-amber-700/40 text-amber-800 dark:text-amber-200 dark:border-amber-600/40 dark:bg-amber-900/25",
  "bg-violet-700/15 border-violet-700/40 text-violet-800 dark:text-violet-200 dark:border-violet-600/40 dark:bg-violet-900/25",
  "bg-teal-700/15 border-teal-700/40 text-teal-800 dark:text-teal-200 dark:border-teal-600/40 dark:bg-teal-900/25",
];

function getAgentCellClasses(agentLabel: string): string {
  const i = AGENT_ORDER.indexOf(agentLabel);
  return AGENT_CELL_CLASSES[i !== -1 ? i % AGENT_CELL_CLASSES.length : 0];
}

export function ZeroSchedulePage() {
  const [scheduleViewMode, setScheduleViewMode] = useState<"list" | "calendar">(
    "list",
  );

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            Schedule
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Schedules for Zero and all sub-agents.
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="rounded-2xl border border-border/70 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
            <CardContent className="py-5 flex flex-col gap-6">
              <header className="flex w-full flex-wrap items-center gap-4">
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">
                    All schedules
                  </h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Set times and prompts for Zero and sub-agents to run
                    automatically.
                  </p>
                </div>
                <Tabs
                  value={scheduleViewMode}
                  onValueChange={(v) =>
                    setScheduleViewMode(v as "list" | "calendar")
                  }
                  className="shrink-0"
                >
                  <TabsList className="h-9 gap-1 bg-muted/60 px-1 py-1">
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
                <ul className="flex flex-col" role="list">
                  {COMBINED_SCHEDULE.map((entry) => (
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
                        {WEEKDAY_LABELS.map((d) => (
                          <div
                            key={d}
                            className="bg-muted/50 p-2 border-b border-r border-border/60 last:border-r-0 font-medium text-muted-foreground text-center"
                          >
                            {d}
                          </div>
                        ))}
                        {CALENDAR_TIME_SLOTS.map((timeLabel) => (
                          <div key={timeLabel} className="contents">
                            <div className="bg-muted/30 p-2 border-b border-r border-border/60 text-muted-foreground text-xs flex items-center">
                              {timeLabel}
                            </div>
                            {WEEKDAY_LABELS.map((_, dayIndex) => {
                              const entries = getEntriesInCell(
                                COMBINED_SCHEDULE,
                                dayIndex,
                                timeLabel,
                              ) as CombinedEntry[];
                              const isEmpty = entries.length === 0;
                              return (
                                <div
                                  key={`${timeLabel}-${dayIndex}`}
                                  className={cn(
                                    "min-h-[52px] p-1.5 border-b border-r border-border/60 last:border-r-0 flex items-center justify-center",
                                    isEmpty && "bg-background/50",
                                  )}
                                >
                                  {isEmpty ? (
                                    <span className="text-muted-foreground/40 text-xs">
                                      —
                                    </span>
                                  ) : (
                                    <Popover>
                                      <PopoverTrigger asChild>
                                        <button
                                          type="button"
                                          className="w-full h-full min-h-[44px] rounded-lg p-1.5 flex flex-col gap-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                          aria-label={`${entries.length} scheduled in this slot`}
                                        >
                                          {entries.map((entry) => (
                                            <span
                                              key={entry.id}
                                              className={cn(
                                                "rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border min-h-0",
                                                getAgentCellClasses(
                                                  entry.agentLabel,
                                                ),
                                              )}
                                            >
                                              {entry.prompt}
                                            </span>
                                          ))}
                                        </button>
                                      </PopoverTrigger>
                                      <PopoverContent
                                        align="start"
                                        className="w-80 p-3 flex flex-col gap-3"
                                      >
                                        {entries.map((entry) => (
                                          <div
                                            key={entry.id}
                                            className="flex flex-col gap-1.5"
                                          >
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
                                        ))}
                                      </PopoverContent>
                                    </Popover>
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
                    const loopEntries = COMBINED_SCHEDULE.filter((e) =>
                      e.time.match(/Every \d+ minutes?/),
                    );
                    const onceEntries = COMBINED_SCHEDULE.filter((e) =>
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
                                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
                                >
                                  <span className="w-[180px] shrink-0 truncate text-muted-foreground text-xs">
                                    {entry.agentLabel}
                                  </span>
                                  <span className="text-foreground">
                                    {entry.time}
                                  </span>
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
                                  className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
                                >
                                  <span className="w-[180px] shrink-0 truncate text-muted-foreground text-xs">
                                    {entry.agentLabel}
                                  </span>
                                  <span className="text-foreground">
                                    {entry.time}
                                  </span>
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
    </div>
  );
}
