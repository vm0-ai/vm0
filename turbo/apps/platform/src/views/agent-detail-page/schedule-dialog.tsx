import { useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { Switch } from "@vm0/ui/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { IconClock } from "@tabler/icons-react";
import {
  scheduleDialogOpen$,
  closeScheduleDialog$,
  scheduleDialogPrompt$,
  setScheduleDialogPrompt$,
  scheduleDialogTimeOption$,
  setScheduleDialogTimeOption$,
  scheduleDialogHour$,
  setScheduleDialogHour$,
  scheduleDialogMinute$,
  setScheduleDialogMinute$,
  scheduleDialogDayOfWeek$,
  setScheduleDialogDayOfWeek$,
  scheduleDialogDayOfMonth$,
  setScheduleDialogDayOfMonth$,
  scheduleDialogIntervalSeconds$,
  setScheduleDialogIntervalSeconds$,
  scheduleDialogDate$,
  setScheduleDialogDate$,
  scheduleDialogSaving$,
  scheduleDialogSaveError$,
  submitScheduleDialog$,
  deleteScheduleFromDialog$,
  scheduleDialogTimezone$,
  setScheduleDialogTimezone$,
  scheduleDialogNotifyEmail$,
  setScheduleDialogNotifyEmail$,
  scheduleDialogNotifySlack$,
  setScheduleDialogNotifySlack$,
} from "../../signals/agent-detail/schedule.ts";
import {
  getTodayDateLocal,
  COMMON_TIMEZONES,
} from "../../signals/agent-detail/cron.ts";
import { detach, Reason } from "../../signals/utils.ts";

// ---------------------------------------------------------------------------
// ScheduleDialog
// ---------------------------------------------------------------------------

export function ScheduleDialog() {
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
  const open = useGet(scheduleDialogOpen$);
  const prompt = useGet(scheduleDialogPrompt$);
  const timeOption = useGet(scheduleDialogTimeOption$);
  const hour = useGet(scheduleDialogHour$);
  const minute = useGet(scheduleDialogMinute$);
  const dayOfWeek = useGet(scheduleDialogDayOfWeek$);
  const dayOfMonth = useGet(scheduleDialogDayOfMonth$);
  const intervalSeconds = useGet(scheduleDialogIntervalSeconds$);
  const date = useGet(scheduleDialogDate$);
  const saving = useGet(scheduleDialogSaving$);
  const saveError = useGet(scheduleDialogSaveError$);
  const close = useSet(closeScheduleDialog$);
  const setPrompt = useSet(setScheduleDialogPrompt$);
  const setTimeOption = useSet(setScheduleDialogTimeOption$);
  const setHour = useSet(setScheduleDialogHour$);
  const setMinute = useSet(setScheduleDialogMinute$);
  const setDayOfWeek = useSet(setScheduleDialogDayOfWeek$);
  const setDayOfMonth = useSet(setScheduleDialogDayOfMonth$);
  const setIntervalSeconds = useSet(setScheduleDialogIntervalSeconds$);
  const setDate = useSet(setScheduleDialogDate$);
  const submit = useSet(submitScheduleDialog$);
  const deleteSchedule = useSet(deleteScheduleFromDialog$);
  const timezone = useGet(scheduleDialogTimezone$);
  const setTimezone = useSet(setScheduleDialogTimezone$);
  const notifyEmail = useGet(scheduleDialogNotifyEmail$);
  const setNotifyEmail = useSet(setScheduleDialogNotifyEmail$);
  const notifySlack = useGet(scheduleDialogNotifySlack$);
  const setNotifySlack = useSet(setScheduleDialogNotifySlack$);

  const dayOfMonthOptions = Array.from({ length: 31 }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));

  const isOnce = timeOption === "once";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit this schedule</DialogTitle>
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
                <SelectItem value="once">Once</SelectItem>
                <SelectItem value="every-weekday">Every weekday</SelectItem>
                <SelectItem value="every-day">Every day</SelectItem>
                <SelectItem value="every-week">Every week</SelectItem>
                <SelectItem value="every-month">Every month</SelectItem>
                <SelectItem value="loop">Loop</SelectItem>
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

          {timeOption === "every-week" && (
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

          {timeOption === "every-month" && (
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

          {timeOption === "loop" ? (
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
          ) : (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground px-1">
                {isOnce ? "Time" : "Frequency"}
              </label>
              <div className="flex items-center gap-2">
                <IconClock
                  size={16}
                  className="text-muted-foreground shrink-0"
                />
                <Select value={hour} onValueChange={setHour}>
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

          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground px-1">
              Notifications
            </label>
            <div className="flex items-center justify-between px-1">
              <span className="text-sm text-foreground">Email</span>
              <Switch checked={notifyEmail} onCheckedChange={setNotifyEmail} />
            </div>
            <div className="flex items-center justify-between px-1">
              <span className="text-sm text-foreground">Slack</span>
              <Switch checked={notifySlack} onCheckedChange={setNotifySlack} />
            </div>
          </div>
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        <DialogFooter className="flex !justify-between">
          <Button
            variant="destructive"
            onClick={() => detach(deleteSchedule(), Reason.DomCallback)}
            disabled={saving}
          >
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => detach(submit(), Reason.DomCallback)}
              disabled={saving || !prompt.trim()}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
