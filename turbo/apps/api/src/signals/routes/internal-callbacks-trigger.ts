import { command } from "ccstate";
import { internalCallbacksTriggerContract } from "@vm0/api-contracts/contracts/internal-callbacks-trigger";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { handleTriggerInternalCallback$ } from "../services/internal-trigger-run-callback.service";
import type { InternalRunCallbackKind } from "../services/internal-run-callback";

type TriggerInternalRunCallbackKind = Extract<
  InternalRunCallbackKind,
  "trigger:cron" | "trigger:loop"
>;

function successResponse(skipped?: true): {
  readonly status: 200;
  readonly body: { readonly success: true; readonly skipped?: true };
} {
  return { status: 200, body: { success: true, ...(skipped && { skipped }) } };
}

function errorResponse(message: string): {
  readonly status: 400;
  readonly body: { readonly error: string };
} {
  return { status: 400, body: { error: message } };
}

/**
 * Completion callback for `automation_triggers` time rows, keyed on
 * `trigger_id`: a completed run resets the consecutive-failure counter, a
 * failed run increments it (auto-disable at the threshold), and the recurrence
 * advances from completion time. The poller's claim cleared `next_run_at`, so
 * this callback is what reschedules the trigger. `once` triggers were disabled
 * at claim, so their callback lands in the disabled-skip branch.
 */
function createTriggerCallbackHandler(kind: TriggerInternalRunCallbackKind) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);

    const result = await set(
      handleTriggerInternalCallback$,
      { kind, callback },
      signal,
    );
    signal.throwIfAborted();

    // The run summary is owned by the chat callback (triggerSource "chat"); this
    // reschedule callback only advances next_run_at / consecutive-failure
    // bookkeeping and must NOT write a second summary (D9).
    return result.success
      ? successResponse(result.skipped)
      : errorResponse(result.error);
  });
}

const handleCronTriggerCallback$ = createTriggerCallbackHandler("trigger:cron");
const handleLoopTriggerCallback$ = createTriggerCallbackHandler("trigger:loop");

export const internalCallbacksTriggerRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksTriggerContract.cron,
    handler: callbackRoute(handleCronTriggerCallback$),
  },
  {
    route: internalCallbacksTriggerContract.loop,
    handler: callbackRoute(handleLoopTriggerCallback$),
  },
];
