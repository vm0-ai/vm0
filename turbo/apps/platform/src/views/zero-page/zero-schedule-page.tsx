import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { Switch } from "@vm0/ui/components/ui/switch";
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
  SCHEDULE_FREQUENCY_OPTIONS,
  SCHEDULE_LOOP_MINUTES,
  HOUR_OPTIONS,
  getMinuteOptions,
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
  type OrgScheduleEntry,
  type ZeroScheduleSaveParams,
} from "../../signals/zero-page/zero-schedule.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import emptyScheduleImg from "./assets/empty-schedule.png";

type CombinedEntry = ScheduleEntry & {
  agentLabel: string;
  composeId: string;
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
    enabled: e.enabled,
    notifyEmail: e.notifyEmail,
    notifySlack: e.notifySlack,
    name: e.name,
    intervalSeconds: e.intervalSeconds,
    agentLabel:
      e.composeId === defaultComposeId
        ? agentName
        : (nameToDisplay.get(e.composeName) ?? e.composeName),
    composeId: e.composeId,
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
  const open$ = useCCState(false);
  const open = useGet(open$);
  const setOpen = useSet(open$);

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
  const selectedDay$ = useCCState(
    new Date().getDay() === 0 ? 6 : new Date().getDay() - 1,
  );
  const selectedDay = useGet(selectedDay$);
  const setSelectedDay = useSet(selectedDay$);

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

function isCronFreq(f: string): boolean {
  return (
    f === "once" ||
    f === "every_weekday" ||
    f === "every_day" ||
    f === "every_week" ||
    f === "every_month"
  );
}

function ScheduleEditFields({
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
            className="h-9"
          />
        </div>
      )}
      {freq !== "now" && freq !== "every_n_minutes" && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">Time</label>
          <div className="flex items-center gap-2">
            <Select
              value={String(hour)}
              onValueChange={(v) => setHour(Number(v))}
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
              value={String(minute)}
              onValueChange={(v) => setMinute(Number(v))}
            >
              <SelectTrigger className="h-9 w-20">
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

interface ScheduleEditDialogProps {
  entry: CombinedEntry | null;
  onClose: () => void;
  onSave: (params: ZeroScheduleSaveParams & { composeId: string }) => void;
  saving: boolean;
}

function ScheduleEditDialogInner({
  entry,
  onClose,
  onSave,
  saving,
}: ScheduleEditDialogProps & { entry: CombinedEntry }) {
  const parsed = parseScheduleTimeString(entry.time);
  const prompt$ = useCCState(entry.prompt);
  const prompt = useGet(prompt$);
  const setPrompt = useSet(prompt$);
  const freq$ = useCCState(parsed.freq);
  const freq = useGet(freq$);
  const setFreq = useSet(freq$);
  const date$ = useCCState(parsed.date);
  const date = useGet(date$);
  const setDate = useSet(date$);
  const hour$ = useCCState(parsed.hour);
  const hour = useGet(hour$);
  const setHour = useSet(hour$);
  const minute$ = useCCState(parsed.minute);
  const minute = useGet(minute$);
  const setMinute = useSet(minute$);
  const timezone$ = useCCState(parsed.timezone);
  const timezone = useGet(timezone$);
  const setTimezone = useSet(timezone$);
  const loopMinutes$ = useCCState(parsed.loopMinutes);
  const loopMinutes = useGet(loopMinutes$);
  const setLoopMinutes = useSet(loopMinutes$);
  const notifyEmail$ = useCCState(entry.notifyEmail);
  const notifyEmail = useGet(notifyEmail$);
  const setNotifyEmail = useSet(notifyEmail$);
  const notifySlack$ = useCCState(entry.notifySlack);
  const notifySlack = useGet(notifySlack$);
  const setNotifySlack = useSet(notifySlack$);

  const handleSave = () => {
    if (!prompt.trim()) {
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
      editName: entry.name,
      composeId: entry.composeId,
      notifyEmail,
      notifySlack,
    });
  };

  return (
    <DialogContent className="sm:max-w-lg gap-6">
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
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            Notifications
          </label>
          <div className="flex items-center justify-between">
            <span className="text-sm text-foreground">Email</span>
            <Switch checked={notifyEmail} onCheckedChange={setNotifyEmail} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-foreground">Slack</span>
            <Switch checked={notifySlack} onCheckedChange={setNotifySlack} />
          </div>
        </div>
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
        <Button
          type="button"
          onClick={handleSave}
          disabled={!prompt.trim() || saving}
        >
          {saving ? "Saving\u2026" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function ScheduleEditDialog(props: ScheduleEditDialogProps) {
  const { entry, onClose } = props;
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      {entry && (
        <ScheduleEditDialogInner key={entry.id} {...props} entry={entry} />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

interface ScheduleCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (params: ZeroScheduleSaveParams & { composeId: string }) => void;
  saving: boolean;
  agents: { id: string; name: string; displayName?: string | null }[];
  defaultComposeId: string | null;
}

function ScheduleCreateDialogInner({
  onClose,
  onSave,
  saving,
  agents,
  defaultComposeId,
}: Omit<ScheduleCreateDialogProps, "open">) {
  const prompt$ = useCCState("");
  const prompt = useGet(prompt$);
  const setPrompt = useSet(prompt$);
  const composeId$ = useCCState(defaultComposeId ?? agents[0]?.id ?? "");
  const composeId = useGet(composeId$);
  const setComposeId = useSet(composeId$);
  const freq$ = useCCState("every_day");
  const freq = useGet(freq$);
  const setFreq = useSet(freq$);
  const date$ = useCCState(new Date().toISOString().slice(0, 10));
  const date = useGet(date$);
  const setDate = useSet(date$);
  const hour$ = useCCState(9);
  const hour = useGet(hour$);
  const setHour = useSet(hour$);
  const minute$ = useCCState(0);
  const minute = useGet(minute$);
  const setMinute = useSet(minute$);
  const timezone$ = useCCState(
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const timezone = useGet(timezone$);
  const setTimezone = useSet(timezone$);
  const loopMinutes$ = useCCState(15);
  const loopMinutes = useGet(loopMinutes$);
  const setLoopMinutes = useSet(loopMinutes$);

  const handleSave = () => {
    if (!prompt.trim() || !composeId) {
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
      composeId,
    });
  };

  return (
    <DialogContent className="sm:max-w-lg gap-6">
      <DialogHeader>
        <DialogTitle>New schedule</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="schedule-create-agent"
            className="text-sm font-medium text-foreground"
          >
            Agent
          </label>
          <Select value={composeId} onValueChange={setComposeId}>
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
        <Button
          type="button"
          onClick={handleSave}
          disabled={!prompt.trim() || !composeId || saving}
        >
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
  const togglingIds$ = useCCState<Set<string>>(new Set());
  const togglingIds = useGet(togglingIds$);
  const setTogglingIds = useSet(togglingIds$);

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
              {entry.prompt}
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

  const scheduleViewMode$ = useCCState<"list" | "calendar">("list");
  const scheduleViewMode = useGet(scheduleViewMode$);
  const setScheduleViewMode = useSet(scheduleViewMode$);
  const editingEntry$ = useCCState<CombinedEntry | null>(null);
  const editingEntry = useGet(editingEntry$);
  const setEditingEntry = useSet(editingEntry$);
  const saving$ = useCCState(false);
  const saving = useGet(saving$);
  const setSaving = useSet(saving$);
  const createOpen$ = useCCState(false);
  const createOpen = useGet(createOpen$);
  const setCreateOpen = useSet(createOpen$);

  const combinedSchedule = buildCombinedSchedule(
    entries,
    agentName,
    defaultComposeId,
    nameToDisplay,
  );

  const agentOrder = [
    ...new Set(combinedSchedule.map((e) => e.agentLabel)),
  ] as const;

  const openEditSchedule = (entry: CombinedEntry) => {
    setEditingEntry(entry);
  };

  const handleCreateSave = (
    params: ZeroScheduleSaveParams & { composeId: string },
  ) => {
    setSaving(true);
    detach(
      saveSchedule(params)
        .then(() => {
          setCreateOpen(false);
        })
        .finally(() => {
          setSaving(false);
        }),
      Reason.DomCallback,
    );
  };

  const handleDialogSave = (
    params: ZeroScheduleSaveParams & { composeId: string },
  ) => {
    setSaving(true);
    detach(
      saveSchedule(params)
        .then(() => {
          setEditingEntry(null);
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
      composeId: entry.composeId,
    });
  };

  const handleDelete = (entry: CombinedEntry) => {
    if (entry.name === undefined) {
      return;
    }
    detach(
      deleteSchedule({ name: entry.name, composeId: entry.composeId }),
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

      <ScheduleEditDialog
        entry={editingEntry}
        onClose={() => setEditingEntry(null)}
        onSave={handleDialogSave}
        saving={saving}
      />
      <ScheduleCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSave={handleCreateSave}
        saving={saving}
        agents={agents}
        defaultComposeId={defaultComposeId}
      />
    </div>
  );
}
