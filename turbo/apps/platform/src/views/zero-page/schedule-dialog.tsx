// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastResolved } from "ccstate-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  COMMON_TIMEZONES,
  getTodayDateLocal,
  getTimezoneLabel,
} from "../../signals/zero-page/cron.ts";
import { userPreferences$ } from "../../signals/zero-page/settings/user-preferences.ts";
import {
  dialogForm$,
  updateDialogForm$,
  showConfirm$,
  setShowConfirm$,
  dialogAgentModelDefault$,
} from "../../signals/schedule-page/schedule-form.ts";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";

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

const HOUR_OPTIONS: readonly number[] = Array.from({ length: 24 }, (_, i) => {
  return i;
});

const MINUTE_OPTIONS: readonly number[] = Array.from({ length: 12 }, (_, i) => {
  return i * 5;
});

/**
 * Build the minute dropdown options, inserting a non-standard value (e.g. an
 * existing schedule whose minute is not a multiple of 5) so the schedule
 * remains editable.
 */
function getMinuteOptions(currentMinute?: number): readonly number[] {
  if (currentMinute === undefined || MINUTE_OPTIONS.includes(currentMinute)) {
    return MINUTE_OPTIONS;
  }
  return [...MINUTE_OPTIONS, currentMinute].sort((a, b) => {
    return a - b;
  });
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
  return [...SCHEDULE_LOOP_MINUTES, current].sort((a, b) => {
    return a - b;
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleFormValues {
  prompt: string;
  description: string;
  agentId: string;
  freq: string;
  date: string;
  hour: number;
  minute: number;
  timezone: string;
  loopMinutes: number;
  dayOfWeek: string;
  dayOfMonth: string;
  modelProviderId: string | null;
  selectedModel: string | null;
}

interface ScheduleFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: ScheduleFormValues) => void;
  saving: boolean;
  mode: "create" | "edit";
  initialValues?: Partial<ScheduleFormValues>;
  /** When provided, renders an agent selector dropdown. */
  agents?: { id: string; displayName?: string | null }[];
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
      className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-auto"
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
            {SCHEDULE_FREQUENCY_OPTIONS.map((opt) => {
              return (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              );
            })}
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
            onValueChange={(v) => {
              return setLoopMinutes(Number(v));
            }}
          >
            <SelectTrigger id="schedule-dialog-loop" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {getLoopMinuteOptions(loopMinutes).map((m) => {
                return (
                  <SelectItem key={m} value={String(m)}>
                    {m} minutes
                  </SelectItem>
                );
              })}
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
            onChange={(e) => {
              return setDate(e.target.value);
            }}
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
          <label
            htmlFor="schedule-dialog-day-of-month"
            className="text-sm font-medium text-foreground"
          >
            Day of month
          </label>
          <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
            <SelectTrigger id="schedule-dialog-day-of-month" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 31 }, (_, i) => {
                return (
                  <SelectItem key={i + 1} value={String(i + 1)}>
                    {i + 1}
                  </SelectItem>
                );
              })}
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
              onValueChange={(v) => {
                return setHour(Number(v));
              }}
            >
              <SelectTrigger
                id="schedule-dialog-hour"
                aria-label="Hour"
                className="h-9 w-20"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOUR_OPTIONS.map((h) => {
                  return (
                    <SelectItem key={h} value={String(h)}>
                      {h.toString().padStart(2, "0")}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">:</span>
            <Select
              value={String(minute)}
              onValueChange={(v) => {
                return setMinute(Number(v));
              }}
            >
              <SelectTrigger
                id="schedule-dialog-minute"
                aria-label="Minute"
                className="h-9 w-20"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getMinuteOptions(minute).map((m) => {
                  return (
                    <SelectItem key={m} value={String(m)}>
                      {m.toString().padStart(2, "0")}
                    </SelectItem>
                  );
                })}
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
              ).map((tz) => {
                return (
                  <SelectItem key={tz} value={tz}>
                    {getTimezoneLabel(tz)}
                  </SelectItem>
                );
              })}
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
              aria-pressed={selected}
              className={`h-8 min-w-[40px] rounded-lg border text-xs font-medium transition-colors ${
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => {
                const current = dayOfWeek.split(",").filter(Boolean);
                if (selected) {
                  if (current.length > 1) {
                    setDayOfWeek(
                      current
                        .filter((d) => {
                          return d !== value;
                        })
                        .join(","),
                    );
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
// Helpers
// ---------------------------------------------------------------------------

function buildDefaults(
  agents: ScheduleFormDialogProps["agents"],
  initialValues: Partial<ScheduleFormValues> | undefined,
  preferredTimezone: string | null | undefined,
): ScheduleFormValues {
  const defaults: ScheduleFormValues = {
    prompt: "",
    description: "",
    agentId: agents?.[0]?.id ?? "",
    freq: "every_day",
    date: new Date().toISOString().slice(0, 10),
    hour: 9,
    minute: 0,
    timezone:
      preferredTimezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
    loopMinutes: 15,
    dayOfWeek: "1",
    dayOfMonth: "1",
    modelProviderId: null,
    selectedModel: null,
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
    current.modelProviderId !== init.modelProviderId ||
    current.selectedModel !== init.selectedModel ||
    (opts.hasAgents && current.agentId !== init.agentId)
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
  preferredTimezone,
}: Omit<ScheduleFormDialogProps, "open"> & {
  preferredTimezone: string | null | undefined;
}) {
  const init = buildDefaults(agents, initialValues, preferredTimezone);

  const updateForm = useSet(updateDialogForm$);
  const form = useGet(dialogForm$);
  const showConfirmVal = useGet(showConfirm$);
  const setShowConfirmVal = useSet(setShowConfirm$);

  const orgProviders = useLastResolved(orgModelProviders$);

  const agentModelDefault = useLastResolved(dialogAgentModelDefault$) ?? null;

  const current: ScheduleFormValues = {
    prompt: form.prompt,
    description: form.description,
    agentId: form.agentId,
    freq: form.freq,
    date: form.date,
    hour: form.hour,
    minute: form.minute,
    timezone: form.timezone,
    loopMinutes: form.loopMinutes,
    dayOfWeek: form.dayOfWeek,
    dayOfMonth: form.dayOfMonth,
    modelProviderId: form.modelProviderId,
    selectedModel: form.selectedModel,
  };

  const isDirty = checkDirty(current, init, mode, {
    hasAgents: agents !== undefined,
  });

  const requestClose = () => {
    if (isDirty) {
      setShowConfirmVal(true);
    } else {
      onClose();
    }
  };

  const handleSave = () => {
    if (!form.prompt.trim()) {
      return;
    }
    if (agents && !form.agentId) {
      return;
    }
    onSave(current);
  };

  const title = mode === "edit" ? "Edit schedule" : "Add schedule";
  const saveLabel = getSaveLabel(mode, saving);

  return (
    <>
      <DialogContent
        className="w-[calc(100vw-2rem)] sm:max-w-lg gap-6 [&>button[aria-label=Close]:last-child]:hidden"
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
          <DialogDescription>
            {mode === "edit"
              ? "Update the schedule settings and save your changes."
              : "Configure when and how often this agent should run."}
          </DialogDescription>
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
              <Select
                value={form.agentId}
                onValueChange={(v) => {
                  return updateForm({ agentId: v });
                }}
              >
                <SelectTrigger id="schedule-dialog-agent" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => {
                    return (
                      <SelectItem key={a.id} value={a.id}>
                        {a.displayName ?? a.id}
                      </SelectItem>
                    );
                  })}
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
              value={form.prompt}
              onChange={(e) => {
                return updateForm({ prompt: e.target.value });
              }}
              placeholder="Describe your task and instruction"
              rows={5}
              className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[120px]"
            />
          </div>

          {/* Description (edit mode only) */}
          {mode === "edit" && (
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
                value={form.description}
                onChange={(e) => {
                  return updateForm({ description: e.target.value });
                }}
                placeholder="Leave blank to auto-generate"
                className="h-9"
              />
            </div>
          )}

          <ScheduleTimingFields
            freq={form.freq}
            setFreq={(v) => {
              return updateForm({ freq: v });
            }}
            loopMinutes={form.loopMinutes}
            setLoopMinutes={(v) => {
              return updateForm({ loopMinutes: v });
            }}
            date={form.date}
            setDate={(v) => {
              return updateForm({ date: v });
            }}
            dayOfWeek={form.dayOfWeek}
            setDayOfWeek={(v) => {
              return updateForm({ dayOfWeek: v });
            }}
            dayOfMonth={form.dayOfMonth}
            setDayOfMonth={(v) => {
              return updateForm({ dayOfMonth: v });
            }}
            hour={form.hour}
            setHour={(v) => {
              return updateForm({ hour: v });
            }}
            minute={form.minute}
            setMinute={(v) => {
              return updateForm({ minute: v });
            }}
            timezone={form.timezone}
            setTimezone={(v) => {
              return updateForm({ timezone: v });
            }}
          />

          {orgProviders && orgProviders.modelProviders.length > 0 && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">
                Model
                <span className="text-muted-foreground font-normal ml-1">
                  (optional)
                </span>
              </label>
              <ModelProviderPicker
                providers={orgProviders.modelProviders}
                value={
                  form.modelProviderId && form.selectedModel
                    ? {
                        modelProviderId: form.modelProviderId,
                        selectedModel: form.selectedModel,
                      }
                    : null
                }
                onChange={(sel: ModelProviderSelection | null) => {
                  updateForm({
                    modelProviderId: sel?.modelProviderId ?? null,
                    selectedModel: sel?.selectedModel ?? null,
                  });
                }}
                agentDefault={agentModelDefault}
                inheritLabel="agent"
              />
            </div>
          )}
        </div>

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
            disabled={
              !form.prompt.trim() || (agents ? !form.agentId : false) || saving
            }
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>

      {showConfirmVal && (
        <ConfirmCloseOverlay
          onDiscard={onClose}
          onContinue={() => {
            return setShowConfirmVal(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function ScheduleFormDialog({ open, ...rest }: ScheduleFormDialogProps) {
  const preferences = useLastResolved(userPreferences$);

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      {open && (
        <ScheduleFormDialogInner
          {...rest}
          preferredTimezone={preferences?.timezone}
        />
      )}
    </Dialog>
  );
}
