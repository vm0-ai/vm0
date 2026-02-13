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
  runDialogSaving$,
  runDialogSaveError$,
  submitRunDialog$,
} from "../../../signals/agent-detail/run-dialog.ts";
import { detach, Reason } from "../../../signals/utils.ts";

function buildHourOptions() {
  return Array.from({ length: 16 }, (_, i) => {
    const hour = i + 6; // 6:00 am to 9:00 pm
    const period = hour >= 12 ? "pm" : "am";
    const displayHour = hour > 12 ? hour - 12 : hour;
    return {
      value: String(hour),
      label: `${String(displayHour)}:00 ${period}`,
    };
  });
}

export function RunDialog() {
  const open = useGet(runDialogOpen$);
  const prompt = useGet(runDialogPrompt$);
  const timeOption = useGet(runDialogTimeOption$);
  const frequency = useGet(runDialogFrequency$);
  const saving = useGet(runDialogSaving$);
  const saveError = useGet(runDialogSaveError$);
  const close = useSet(closeRunDialog$);
  const setPrompt = useSet(setRunDialogPrompt$);
  const setTimeOption = useSet(setRunDialogTimeOption$);
  const setFrequency = useSet(setRunDialogFrequency$);
  const submit = useSet(submitRunDialog$);

  const isSchedule = timeOption !== "now";
  const hourOptions = buildHourOptions();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run this agent</DialogTitle>
          <DialogDescription>
            A few presets help your agent run remotely instead of locally.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe your task in natural language."
              className="w-full min-h-[120px] rounded-lg border border-border bg-input p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">Time</label>
            <Select value={timeOption} onValueChange={setTimeOption}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="now">Now</SelectItem>
                <SelectItem value="every-weekday">Every weekday</SelectItem>
                <SelectItem value="every-day">Every day</SelectItem>
                <SelectItem value="every-week">Every week</SelectItem>
                <SelectItem value="every-month">Every month</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isSchedule && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">
                Frequency
              </label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger>
                  <div className="flex items-center gap-2">
                    <IconClock size={16} className="text-muted-foreground" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {hourOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
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
