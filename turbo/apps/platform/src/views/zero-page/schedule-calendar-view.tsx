import { useGet, useSet } from "ccstate-react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
} from "@tabler/icons-react";
import {
  cn,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@vm0/ui/components/ui/popover";
import {
  WEEKDAY_LABELS,
  buildCalendarTimeSlots,
  getEntriesInCell,
  type ScheduleEntry,
} from "./schedule-utils";
import {
  calendarSelectedDay$,
  setCalendarSelectedDay$,
  calendarPopoverEntryId$,
  setCalendarPopoverEntryId$,
} from "../../signals/schedule-page/schedule-page-ui.ts";

// ---------------------------------------------------------------------------
// Agent color classes (multi-agent calendar)
// ---------------------------------------------------------------------------

const AGENT_CELL_CLASSES = [
  "bg-blue-700/15 border-blue-700/40 text-blue-800 dark:text-blue-200 dark:border-blue-600/40 dark:bg-blue-900/25",
  "bg-emerald-700/15 border-emerald-700/40 text-emerald-800 dark:text-emerald-200 dark:border-emerald-600/40 dark:bg-emerald-900/25",
  "bg-amber-700/15 border-amber-700/40 text-amber-800 dark:text-amber-200 dark:border-amber-600/40 dark:bg-amber-900/25",
  "bg-violet-700/15 border-violet-700/40 text-violet-800 dark:text-violet-200 dark:border-violet-600/40 dark:bg-violet-900/25",
  "bg-teal-700/15 border-teal-700/40 text-teal-800 dark:text-teal-200 dark:border-teal-600/40 dark:bg-teal-900/25",
] as const;

const SINGLE_AGENT_CELL_CLASS = AGENT_CELL_CLASSES[0];

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

function CalendarEntryPopover<T extends ScheduleEntry>({
  entry,
  agentOrder,
  getAgentLabel,
  onEdit,
}: {
  entry: T;
  agentOrder?: readonly string[];
  getAgentLabel?: (entry: T) => string;
  onEdit: (entry: T) => void;
}) {
  const popoverEntryId = useGet(calendarPopoverEntryId$);
  const setPopoverEntryId = useSet(setCalendarPopoverEntryId$);
  const open = popoverEntryId === entry.id;
  const setOpen = (v: boolean) => {
    setPopoverEntryId(v ? entry.id : null);
  };

  const agentLabel = getAgentLabel?.(entry);
  const cellClass =
    agentOrder && agentLabel
      ? getAgentCellClasses(agentLabel, agentOrder)
      : SINGLE_AGENT_CELL_CLASS;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => {
            return setOpen(true);
          }}
          onMouseLeave={() => {
            return setOpen(false);
          }}
          onDoubleClick={() => {
            return onEdit(entry);
          }}
          className={cn(
            "w-full min-h-0 rounded px-1.5 py-0.5 text-[11px] leading-tight line-clamp-2 break-words border text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            cellClass,
          )}
          aria-label={`${agentLabel ? `${agentLabel}: ` : ""}${entry.description || entry.prompt}`}
        >
          {entry.description || entry.prompt}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={0}
        className="w-80 p-3 flex flex-col gap-3"
        onMouseEnter={() => {
          return setOpen(true);
        }}
        onMouseLeave={() => {
          return setOpen(false);
        }}
      >
        <div className="relative flex flex-col gap-1.5 pr-8">
          <div className="absolute top-0 right-0">
            <button
              type="button"
              onClick={() => {
                return onEdit(entry);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              aria-label={`Edit ${entry.time}`}
            >
              <IconPencil size={14} stroke={1.5} />
            </button>
          </div>
          {agentLabel && (
            <p className="text-xs text-muted-foreground font-medium">
              {agentLabel}
            </p>
          )}
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

export function ScheduleCalendarView<T extends ScheduleEntry>({
  entries,
  agentOrder,
  getAgentLabel,
  onEdit,
}: {
  entries: T[];
  agentOrder?: readonly string[];
  getAgentLabel?: (entry: T) => string;
  onEdit: (entry: T) => void;
}) {
  const enabledEntries = entries.filter((e) => {
    return e.enabled !== false;
  });
  const calendarSlots = buildCalendarTimeSlots(enabledEntries);
  const selectedDay = useGet(calendarSelectedDay$);
  const setSelectedDay = useSet(setCalendarSelectedDay$);

  const loopEntries = enabledEntries.filter((e) => {
    return e.time.match(/Every \d+ (minutes?|seconds?)/);
  });
  const onceEntries = enabledEntries.filter((e) => {
    return e.time.startsWith("Once on");
  });
  const monthlyEntries = enabledEntries.filter((e) => {
    return e.time.startsWith("Every month");
  });

  const sections: { title: string; entries: T[] }[] = [
    { title: "Loop", entries: loopEntries },
    { title: "Monthly", entries: monthlyEntries },
    { title: "Once", entries: onceEntries },
  ];

  return (
    <section className="flex flex-col gap-8 p-5">
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Week view
        </h3>
        <div className="rounded-xl zero-border bg-muted/20 overflow-hidden">
          {/* Mobile: single-day view */}
          <div className="md:hidden">
            <div
              role="navigation"
              aria-label="Day navigation"
              className="flex items-center justify-between bg-muted/50 px-3 py-2 border-b border-border/60"
            >
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        return setSelectedDay(
                          (selectedDay - 1 + WEEKDAY_LABELS.length) %
                            WEEKDAY_LABELS.length,
                        );
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="Previous day"
                    >
                      <IconChevronLeft size={16} stroke={1.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">Previous day</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <span className="text-sm font-medium text-muted-foreground">
                {WEEKDAY_LABELS[selectedDay]}
              </span>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        return setSelectedDay(
                          (selectedDay + 1) % WEEKDAY_LABELS.length,
                        );
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="Next day"
                    >
                      <IconChevronRight size={16} stroke={1.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">Next day</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            {calendarSlots.map((timeLabel, timeIndex) => {
              const cellEntries = getEntriesInCell(
                enabledEntries,
                selectedDay,
                timeLabel,
              ) as T[];
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
                        {cellEntries.map((entry) => {
                          return (
                            <CalendarEntryPopover
                              key={entry.id}
                              entry={entry}
                              agentOrder={agentOrder}
                              getAgentLabel={getAgentLabel}
                              onEdit={onEdit}
                            />
                          );
                        })}
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
              {WEEKDAY_LABELS.map((d, dayIndex) => {
                return (
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
                );
              })}
              {calendarSlots.map((timeLabel, timeIndex) => {
                return (
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
                    {WEEKDAY_LABELS.map((dayLabel, dayIndex) => {
                      const cellEntries = getEntriesInCell(
                        enabledEntries,
                        dayIndex,
                        timeLabel,
                      ) as T[];
                      const isEmpty = cellEntries.length === 0;
                      const isLastRow = timeIndex === calendarSlots.length - 1;
                      const isLastCol = dayIndex === WEEKDAY_LABELS.length - 1;
                      return (
                        <div
                          key={`${timeLabel}-${dayLabel}`}
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
                              {cellEntries.map((entry) => {
                                return (
                                  <CalendarEntryPopover
                                    key={entry.id}
                                    entry={entry}
                                    agentOrder={agentOrder}
                                    getAgentLabel={getAgentLabel}
                                    onEdit={onEdit}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      {sections.some((s) => {
        return s.entries.length > 0;
      }) && (
        <div className="flex flex-col gap-8">
          {sections.map((section) => {
            return section.entries.length > 0 ? (
              <div key={section.title} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.title}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {section.entries.map((entry) => {
                    const agentLabel = getAgentLabel?.(entry);
                    return (
                      <div
                        key={entry.id}
                        className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm w-fit"
                      >
                        {agentLabel && (
                          <span className="shrink-0 text-muted-foreground text-xs">
                            {agentLabel}
                          </span>
                        )}
                        <span className="text-foreground">{entry.time}</span>
                        <button
                          type="button"
                          onClick={() => {
                            return onEdit(entry);
                          }}
                          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Edit ${entry.time}`}
                        >
                          <IconPencil size={12} stroke={1.5} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null;
          })}
        </div>
      )}
    </section>
  );
}
