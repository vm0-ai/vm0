import { command } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { saveOrgSchedule$ } from "../zero-page/zero-schedule.ts";
import type { ScheduleFormData } from "./schedule-form.ts";
import {
  closeCreateScheduleDialog$,
  creatingOrgSchedule$,
  setCreatingOrgSchedule$,
} from "./schedule-page-ui.ts";

// ---------------------------------------------------------------------------
// Create-schedule flow wired for the ZeroSchedulePage form dialog.
// Normalizes form values, saves, closes the dialog, and navigates to the new
// schedule. Views wrap the `useSet` result with `onDomEventFn` so the
// returned promise is detached with `Reason.DomCallback`.
// ---------------------------------------------------------------------------

export const createOrgScheduleFromForm$ = command(
  async (
    { get, set },
    values: ScheduleFormData,
    signal: AbortSignal,
  ): Promise<void> => {
    if (get(creatingOrgSchedule$)) {
      return;
    }
    set(setCreatingOrgSchedule$, true);
    const scheduleId = await set(
      saveOrgSchedule$,
      {
        prompt: values.prompt.trim(),
        description: values.description.trim() || undefined,
        freq: values.freq,
        date: values.date,
        hour: values.hour,
        minute: values.minute,
        timezone: values.timezone,
        intervalSeconds: values.loopMinutes * 60,
        agentId: values.agentId,
        ...(values.freq === "every_week"
          ? { dayOfWeek: values.dayOfWeek }
          : {}),
        ...(values.freq === "every_month"
          ? { dayOfMonth: values.dayOfMonth }
          : {}),
      },
      signal,
    ).finally(() => {
      set(setCreatingOrgSchedule$, false);
    });
    signal.throwIfAborted();
    set(closeCreateScheduleDialog$);
    set(detachedNavigateTo$, "/schedules/:scheduleId", {
      pathParams: { scheduleId },
    });
  },
);
