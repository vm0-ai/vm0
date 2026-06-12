import { command } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { saveOrgAutomation$ } from "../zero-page/zero-automations.ts";
import type { AutomationFormData } from "./automation-form.ts";
import {
  closeCreateAutomationDialog$,
  creatingOrgAutomation$,
  setCreatingOrgAutomation$,
} from "./automation-page-ui.ts";

// ---------------------------------------------------------------------------
// Create-automation flow wired for the ZeroAutomationsPage form dialog.
// Normalizes form values, saves, closes the dialog, and navigates to the new
// automation. Views wrap the `useSet` result with `onDomEventFn` so the
// returned promise is detached with `Reason.DomCallback`.
// ---------------------------------------------------------------------------

export const createOrgAutomationFromForm$ = command(
  async (
    { get, set },
    values: AutomationFormData,
    signal: AbortSignal,
  ): Promise<void> => {
    if (get(creatingOrgAutomation$)) {
      return;
    }
    set(setCreatingOrgAutomation$, true);
    const scheduleId = await set(
      saveOrgAutomation$,
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
      set(setCreatingOrgAutomation$, false);
    });
    signal.throwIfAborted();
    set(closeCreateAutomationDialog$);
    set(detachedNavigateTo$, "/automations/:scheduleId", {
      pathParams: { scheduleId },
    });
  },
);
