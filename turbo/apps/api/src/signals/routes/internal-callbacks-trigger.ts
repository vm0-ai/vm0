import { command } from "ccstate";
import {
  internalCallbacksTriggerContract,
  triggerCronCallbackPayloadSchema,
  triggerLoopCallbackPayloadSchema,
  type TriggerCronCallbackPayload,
  type TriggerLoopCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-trigger";
import { automationTriggers } from "@vm0/db/schema/automation";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { TimeTrigger } from "../services/automations/time-trigger";

const MAX_CONSECUTIVE_FAILURES = 3;

type TriggerPayload =
  | { readonly kind: "cron"; readonly data: TriggerCronCallbackPayload }
  | { readonly kind: "loop"; readonly data: TriggerLoopCallbackPayload };

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

function parseCronPayload(payload: unknown): TriggerPayload | null {
  const result = triggerCronCallbackPayloadSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }
  return { kind: "cron", data: result.data };
}

function parseLoopPayload(payload: unknown): TriggerPayload | null {
  const result = triggerLoopCallbackPayloadSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }
  return { kind: "loop", data: result.data };
}

/**
 * Completion callback for `automation_triggers` time rows — mirrors the schedule
 * callback's semantics 1:1, keyed on `trigger_id`: a completed run resets the
 * consecutive-failure counter, a failed run increments it (auto-disable at the
 * threshold), and the recurrence advances from completion time. The poller's
 * claim cleared `next_run_at`, so this callback is what reschedules the trigger.
 * `once` triggers were disabled at claim, so their callback lands in the
 * disabled-skip branch — same as the live schedule path.
 */
function createTriggerCallbackHandler(
  parsePayload: (payload: unknown) => TriggerPayload | null,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = parsePayload(callback.payload);
    if (!payload) {
      return errorResponse("Invalid or missing payload");
    }

    if (callback.status === "progress") {
      return successResponse(true);
    }

    const writeDb = set(writeDb$);
    const [trigger] = await writeDb
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, payload.data.triggerId))
      .limit(1);
    signal.throwIfAborted();

    if (!trigger || !trigger.enabled) {
      return successResponse(true);
    }

    const completedAt = nowDate();
    const consecutiveFailures =
      callback.status === "completed" ? 0 : trigger.consecutiveFailures + 1;
    const shouldDisable = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    const nextRunAt = new TimeTrigger().advanceAfterCompletion({
      triggerType: payload.kind,
      cronExpression:
        payload.kind === "cron" ? payload.data.cronExpression : undefined,
      intervalSeconds: trigger.intervalSeconds,
      timezone: trigger.timezone,
      completedAt,
      shouldDisable,
    });

    await writeDb
      .update(automationTriggers)
      .set({
        consecutiveFailures,
        ...(shouldDisable && { enabled: false }),
        nextRunAt,
        updatedAt: completedAt,
      })
      .where(eq(automationTriggers.id, payload.data.triggerId));
    signal.throwIfAborted();

    // The run summary is owned by the chat callback (triggerSource "chat"); this
    // reschedule callback only advances next_run_at / consecutive-failure
    // bookkeeping and must NOT write a second summary (D9).
    return successResponse();
  });
}

const handleCronTriggerCallback$ =
  createTriggerCallbackHandler(parseCronPayload);
const handleLoopTriggerCallback$ =
  createTriggerCallbackHandler(parseLoopPayload);

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
