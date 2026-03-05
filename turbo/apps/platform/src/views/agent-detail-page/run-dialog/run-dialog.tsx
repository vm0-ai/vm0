import { useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { IconClock } from "@tabler/icons-react";
import {
  runDialogOpen$,
  closeRunDialog$,
  runDialogPrompt$,
  setRunDialogPrompt$,
  runDialogTimeOption$,
  setRunDialogTimeOption$,
  runDialogFrequency$,
  setRunDialogFrequency$,
  runDialogMinute$,
  setRunDialogMinute$,
  runDialogDayOfWeek$,
  setRunDialogDayOfWeek$,
  runDialogDayOfMonth$,
  setRunDialogDayOfMonth$,
  runDialogDate$,
  setRunDialogDate$,
  runDialogSaving$,
  runDialogSaveError$,
  submitRunDialog$,
  runDialogTimezone$,
  setRunDialogTimezone$,
  runDialogIntervalSeconds$,
  setRunDialogIntervalSeconds$,
} from "../../../signals/agent-detail/run-dialog.ts";
import { agentSchedule$ } from "../../../signals/agent-detail/schedule.ts";
import {
  getTodayDateLocal,
  COMMON_TIMEZONES,
} from "../../../signals/agent-detail/cron.ts";
import { detach, Reason } from "../../../signals/utils.ts";

// ---------------------------------------------------------------------------
// RunDialog
// ---------------------------------------------------------------------------

export function RunDialog() {
  const open = useGet(runDialogOpen$);
  const prompt = useGet(runDialogPrompt$);
  const timeOption = useGet(runDialogTimeOption$);
  const frequency = useGet(runDialogFrequency$);
  const minute = useGet(runDialogMinute$);
  const dayOfWeek = useGet(runDialogDayOfWeek$);
  const dayOfMonth = useGet(runDialogDayOfMonth$);
  const date = useGet(runDialogDate$);
  const saving = useGet(runDialogSaving$);
  const saveError = useGet(runDialogSaveError$);
  const close = useSet(closeRunDialog$);
  const setPrompt = useSet(setRunDialogPrompt$);
  const setTimeOption = useSet(setRunDialogTimeOption$);
  const setFrequency = useSet(setRunDialogFrequency$);
  const setMinute = useSet(setRunDialogMinute$);
  const setDayOfWeek = useSet(setRunDialogDayOfWeek$);
  const setDayOfMonth = useSet(setRunDialogDayOfMonth$);
  const setDate = useSet(setRunDialogDate$);
  const submit = useSet(submitRunDialog$);
  const timezone = useGet(runDialogTimezone$);
  const setTimezone = useSet(setRunDialogTimezone$);
  const intervalSeconds = useGet(runDialogIntervalSeconds$);
  const setIntervalSeconds = useSet(setRunDialogIntervalSeconds$);
  const schedule = useGet(agentSchedule$);

  const weekdays = [
    { value: "1", label: "Monday" },
    { value: "2", label: "Tuesday" },
    { value: "3", label: "Wednesday" },
    { value: "4", label: "Thursday" },
    { value: "5", label: "Friday" },
    { value: "6", label: "Saturday" },
    { value: "0", label: "Sunday" },
  ];

  const hours = Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: String(i).padStart(2, "0"),
  }));

  const minutes = Array.from({ length: 60 }, (_, i) => ({
    value: String(i),
    label: String(i).padStart(2, "0"),
  }));

  const dayOfMonthOptions = Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));

  const hasSchedule = schedule !== null;
  const isSchedule = timeOption !== "now";
  const isOnce = timeOption === "once";
  const isLoop = timeOption === "loop";
  const isRecurring = isSchedule && !isOnce && !isLoop;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run this agent</DialogTitle>
          <DialogDescription>
            A few presets help your agent run remotely instead of locally.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground px-1">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe your task in natural language."
              className="w-full h-[100px] rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>

          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground px-1">
              Time
            </label>
            <Select value={timeOption} onValueChange={setTimeOption}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="now">Now</SelectItem>
                <SelectItem value="once">Once</SelectItem>
                {!hasSchedule && (
                  <>
                    <SelectItem value="every-weekday">Every weekday</SelectItem>
                    <SelectItem value="every-day">Every day</SelectItem>
                    <SelectItem value="every-week">Every week</SelectItem>
                    <SelectItem value="every-month">Every month</SelectItem>
                    <SelectItem value="loop">Loop</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>

          {isOnce && (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                Date
              </label>
              <Input
                type="date"
                value={date}
                min={getTodayDateLocal()}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          )}

          {isRecurring && timeOption === "every-week" && (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                Day of week
              </label>
              <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {weekdays.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isRecurring && timeOption === "every-month" && (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                Day of month
              </label>
              <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dayOfMonthOptions.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isLoop && (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                Interval (seconds)
              </label>
              <div className="flex items-center gap-2">
                <IconClock
                  size={16}
                  className="text-muted-foreground shrink-0"
                />
                <input
                  type="number"
                  min="0"
                  value={intervalSeconds}
                  onChange={(e) => setIntervalSeconds(e.target.value)}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="300"
                />
              </div>
              <p className="text-xs text-muted-foreground px-1">
                Time between the end of one run and the start of the next. Use 0
                for immediate restart.
              </p>
            </div>
          )}

          {isSchedule && !isLoop && (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                {isOnce ? "Time" : "Frequency"}
              </label>
              <div className="flex items-center gap-2">
                <IconClock
                  size={16}
                  className="text-muted-foreground shrink-0"
                />
                <Select value={frequency} onValueChange={setFrequency}>
                  <SelectTrigger className="w-[80px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hours.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground">:</span>
                <Select value={minute} onValueChange={setMinute}>
                  <SelectTrigger className="w-[80px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {minutes.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isSchedule && (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                Timezone
              </label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger>
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
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => detach(submit(), Reason.DomCallback)}
            disabled={saving || !prompt.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
