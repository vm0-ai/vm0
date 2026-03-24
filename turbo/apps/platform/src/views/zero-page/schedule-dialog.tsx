import { useState } from "react";
import { useLoadable } from "ccstate-react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { Switch } from "@vm0/ui/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  COMMON_TIMEZONES,
  getTodayDateLocal,
} from "../../signals/zero-page/cron.ts";
import { slackOrgData$ } from "../../signals/zero-page/zero-slack.ts";
import { slackChannels$ } from "../../signals/zero-page/slack-channels.ts";

// ---------------------------------------------------------------------------
// Constants (moved from zero-schedule-card.tsx)
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

/**
 * Build the minute dropdown options, inserting a non-standard value (e.g. an
 * existing schedule whose minute is not a multiple of 5) so the schedule
 * remains editable.
 */
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

const DAY_OF_WEEK_OPTIONS = [
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"],
  ["0", "Sun"],
] as const;

function getLoopMinuteOptions(current: number): readonly number[] {
  if ((SCHEDULE_LOOP_MINUTES as readonly number[]).includes(current)) {
    return SCHEDULE_LOOP_MINUTES;
  }
  return [...SCHEDULE_LOOP_MINUTES, current].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleFormValues {
  prompt: string;
  description: string;
  composeId: string;
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes: number;
  dayOfWeek: string;
  dayOfMonth: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackChannelId: string | null;
}

interface SlackChannelOption {
  id: string;
  name: string;
}

interface ScheduleFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: ScheduleFormValues) => void;
  saving: boolean;
  mode: "create" | "edit";
  initialValues?: Partial<ScheduleFormValues>;
  /** When provided, renders an agent selector dropdown. */
  agents?: { id: string; name: string; displayName?: string | null }[];
  /** Error message displayed above the footer. */
  saveError?: string | null;
}

// ---------------------------------------------------------------------------
// Confirm-close overlay
// ---------------------------------------------------------------------------

function ConfirmCloseOverlay({
  onDiscard,
  onContinue,
}: {
  onDiscard: () => void;
  onContinue: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ pointerEvents: "auto" }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-close-title"
      aria-describedby="confirm-close-desc"
    >
      <div
        className="fixed inset-0 bg-black/50 dark:bg-black/70"
        onClick={onContinue}
        role="presentation"
      />
      <div className="relative z-10 mx-4 max-w-sm rounded-lg border border-border bg-card p-6 shadow-xl">
        <p
          id="confirm-close-title"
          className="text-sm font-medium text-foreground mb-1"
        >
          You have unsaved changes
        </p>
        <p
          id="confirm-close-desc"
          className="text-sm text-muted-foreground mb-4"
        >
          Are you sure you want to close? Your changes will be lost.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onContinue}>
            Continue Editing
          </Button>
          <Button variant="destructive" size="sm" onClick={onDiscard}>
            Discard Changes
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Timing fields sub-component
// ---------------------------------------------------------------------------

function ScheduleTimingFields({
  freq,
  setFreq,
  loopMinutes,
  setLoopMinutes,
  date,
  setDate,
  dayOfWeek,
  setDayOfWeek,
  dayOfMonth,
  setDayOfMonth,
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
  dayOfWeek: string;
  setDayOfWeek: (v: string) => void;
  dayOfMonth: string;
  setDayOfMonth: (v: string) => void;
  hour: number;
  setHour: (v: number) => void;
  minute: number;
  setMinute: (v: number) => void;
  timezone: string;
  setTimezone: (v: string) => void;
}) {
  return (
    <>
      {/* Frequency */}
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

      {/* Loop interval */}
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
              {getLoopMinuteOptions(loopMinutes).map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {m} minutes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Date (once) */}
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
            min={getTodayDateLocal()}
            onChange={(e) => setDate(e.target.value)}
            className="h-9"
          />
        </div>
      )}

      {/* Day of week */}
      {freq === "every_week" && (
        <DayOfWeekPicker dayOfWeek={dayOfWeek} setDayOfWeek={setDayOfWeek} />
      )}

      {/* Day of month */}
      {freq === "every_month" && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            Day of month
          </label>
          <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
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

      {/* Hour / minute */}
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

      {/* Timezone */}
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
              {((COMMON_TIMEZONES as readonly string[]).includes(timezone)
                ? COMMON_TIMEZONES
                : [timezone, ...COMMON_TIMEZONES]
              ).map((tz) => (
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
// Day of week picker sub-component
// ---------------------------------------------------------------------------

function DayOfWeekPicker({
  dayOfWeek,
  setDayOfWeek,
}: {
  dayOfWeek: string;
  setDayOfWeek: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-foreground">Day of week</label>
      <div className="flex gap-1">
        {DAY_OF_WEEK_OPTIONS.map(([value, label]) => {
          const selected = dayOfWeek.split(",").includes(value);
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
                const current = dayOfWeek.split(",").filter(Boolean);
                if (selected) {
                  if (current.length > 1) {
                    setDayOfWeek(current.filter((d) => d !== value).join(","));
                  }
                } else {
                  setDayOfWeek([...current, value].join(","));
                }
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notification fields sub-component
// ---------------------------------------------------------------------------

function ScheduleNotificationFields({
  notifyEmail,
  setNotifyEmail,
  notifySlack,
  setNotifySlack,
  slackHasBot,
  slackChannels,
  slackChannelId,
  setSlackChannelId,
}: {
  notifyEmail: boolean;
  setNotifyEmail: (v: boolean) => void;
  notifySlack: boolean;
  setNotifySlack: (v: boolean) => void;
  slackHasBot: boolean;
  slackChannels: SlackChannelOption[];
  slackChannelId: string | null;
  setSlackChannelId: (v: string | null) => void;
}) {
  return (
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
        <Switch
          checked={notifySlack}
          onCheckedChange={setNotifySlack}
          disabled={!slackHasBot}
        />
      </div>
      {!slackHasBot && (
        <p className="text-xs text-muted-foreground">
          Connect a Slack workspace in Settings to enable Slack notifications.
        </p>
      )}
      {notifySlack && slackHasBot && slackChannels.length > 0 && (
        <div className="flex flex-col gap-1">
          <label
            htmlFor="schedule-dialog-slack-channel"
            className="text-xs text-muted-foreground"
          >
            Channel
          </label>
          <Select
            value={slackChannelId ?? "__dm__"}
            onValueChange={(v) => setSlackChannelId(v === "__dm__" ? null : v)}
          >
            <SelectTrigger id="schedule-dialog-slack-channel" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__dm__">Direct message</SelectItem>
              {slackChannels.map((ch) => (
                <SelectItem key={ch.id} value={ch.id}>
                  #{ch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaults(
  agents: ScheduleFormDialogProps["agents"],
  initialValues: Partial<ScheduleFormValues> | undefined,
): ScheduleFormValues {
  const defaults: ScheduleFormValues = {
    prompt: "",
    description: "",
    composeId: agents?.[0]?.id ?? "",
    freq: "every_day",
    date: new Date().toISOString().slice(0, 10),
    hour: 9,
    minute: 0,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    loopMinutes: 15,
    dayOfWeek: "1",
    dayOfMonth: "1",
    notifyEmail: false,
    notifySlack: false,
    slackChannelId: null,
  };
  return { ...defaults, ...initialValues };
}

function checkDirty(
  current: ScheduleFormValues,
  init: ScheduleFormValues,
  mode: "create" | "edit",
  opts: { hasAgents: boolean },
): boolean {
  if (mode !== "edit") {
    return current.prompt.trim() !== "" || current.description.trim() !== "";
  }
  return (
    current.prompt !== init.prompt ||
    current.description !== init.description ||
    current.freq !== init.freq ||
    current.date !== init.date ||
    current.hour !== init.hour ||
    current.minute !== init.minute ||
    current.timezone !== init.timezone ||
    current.loopMinutes !== init.loopMinutes ||
    current.dayOfWeek !== init.dayOfWeek ||
    current.dayOfMonth !== init.dayOfMonth ||
    current.notifyEmail !== init.notifyEmail ||
    current.notifySlack !== init.notifySlack ||
    current.slackChannelId !== init.slackChannelId ||
    (opts.hasAgents && current.composeId !== init.composeId)
  );
}

function getSaveLabel(mode: "create" | "edit", saving: boolean): string {
  if (mode === "edit") {
    return saving ? "Saving\u2026" : "Save";
  }
  return saving ? "Creating\u2026" : "Create";
}

// ---------------------------------------------------------------------------
// Inner dialog (manages form state, mounted only when open)
// ---------------------------------------------------------------------------

function ScheduleFormDialogInner({
  onClose,
  onSave,
  saving,
  mode,
  initialValues,
  agents,
  saveError,
}: Omit<ScheduleFormDialogProps, "open">) {
  const slackData = useLoadable(slackOrgData$);
  const slackHasBot =
    slackData.state === "hasData" && slackData.data?.isInstalled === true;
  const slackChannelsLoadable = useLoadable(slackChannels$);
  const slackChannels: SlackChannelOption[] =
    slackChannelsLoadable.state === "hasData" ? slackChannelsLoadable.data : [];

  const init = buildDefaults(agents, initialValues);

  const [prompt, setPrompt] = useState(init.prompt);
  const [description, setDescription] = useState(init.description);
  const [composeId, setComposeId] = useState(init.composeId);
  const [freq, setFreq] = useState(init.freq);
  const [date, setDate] = useState(init.date);
  const [hour, setHour] = useState(init.hour);
  const [minute, setMinute] = useState(init.minute);
  const [timezone, setTimezone] = useState(init.timezone);
  const [loopMinutes, setLoopMinutes] = useState(init.loopMinutes);
  const [dayOfWeek, setDayOfWeek] = useState(init.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(init.dayOfMonth);
  const [notifyEmail, setNotifyEmail] = useState(init.notifyEmail);
  const [notifySlack, setNotifySlack] = useState(init.notifySlack);
  const [slackChannelId, setSlackChannelId] = useState(init.slackChannelId);
  const [showConfirm, setShowConfirm] = useState(false);

  const current: ScheduleFormValues = {
    prompt,
    description,
    composeId,
    freq,
    date,
    hour,
    minute,
    timezone,
    loopMinutes,
    dayOfWeek,
    dayOfMonth,
    notifyEmail,
    notifySlack,
    slackChannelId,
  };

  const isDirty = checkDirty(current, init, mode, {
    hasAgents: agents !== undefined,
  });

  const requestClose = () => {
    if (isDirty) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  };

  const handleSave = () => {
    if (!prompt.trim()) {
      return;
    }
    if (agents && !composeId) {
      return;
    }
    onSave(current);
  };

  const title = mode === "edit" ? "Edit schedule" : "Add schedule";
  const saveLabel = getSaveLabel(mode, saving);

  return (
    <>
      <DialogContent
        className="sm:max-w-lg gap-6 [&>button[aria-label=Close]:last-child]:hidden"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onInteractOutside={(e) => {
          e.preventDefault();
          requestClose();
        }}
      >
        <button
          type="button"
          className="absolute right-4 top-4 flex items-center justify-center size-9 rounded-lg transition-colors opacity-70 hover:opacity-100 hover:bg-accent focus:outline-none"
          aria-label="Close"
          onClick={requestClose}
        >
          <IconX size={20} className="text-foreground" />
        </button>

        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Agent selector (create-on-page only) */}
          {agents && (
            <div className="flex flex-col gap-2">
              <label
                htmlFor="schedule-dialog-agent"
                className="text-sm font-medium text-foreground"
              >
                Agent
              </label>
              <Select value={composeId} onValueChange={setComposeId}>
                <SelectTrigger id="schedule-dialog-agent" className="h-9">
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
          )}

          {/* Prompt */}
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

          {/* Description */}
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
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Leave blank to auto-generate"
              className="h-9"
            />
          </div>

          <ScheduleTimingFields
            freq={freq}
            setFreq={setFreq}
            loopMinutes={loopMinutes}
            setLoopMinutes={setLoopMinutes}
            date={date}
            setDate={setDate}
            dayOfWeek={dayOfWeek}
            setDayOfWeek={setDayOfWeek}
            dayOfMonth={dayOfMonth}
            setDayOfMonth={setDayOfMonth}
            hour={hour}
            setHour={setHour}
            minute={minute}
            setMinute={setMinute}
            timezone={timezone}
            setTimezone={setTimezone}
          />

          <ScheduleNotificationFields
            notifyEmail={notifyEmail}
            setNotifyEmail={setNotifyEmail}
            notifySlack={notifySlack}
            setNotifySlack={setNotifySlack}
            slackHasBot={slackHasBot}
            slackChannels={slackChannels}
            slackChannelId={slackChannelId}
            setSlackChannelId={setSlackChannelId}
          />
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="zero-btn-morandi"
            onClick={requestClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!prompt.trim() || (agents ? !composeId : false) || saving}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>

      {showConfirm && (
        <ConfirmCloseOverlay
          onDiscard={onClose}
          onContinue={() => setShowConfirm(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function ScheduleFormDialog({ open, ...rest }: ScheduleFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      {open && <ScheduleFormDialogInner {...rest} />}
    </Dialog>
  );
}
