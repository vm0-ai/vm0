import { command } from "ccstate";
import { automationTriggers } from "@vm0/db/schema/automation";
import { eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { TimeTrigger } from "./automations/time-trigger";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
  InternalRunCallbackKind,
} from "./internal-run-callback";
import {
  triggerCronCallbackPayloadSchema,
  type TriggerCronCallbackPayload,
  triggerLoopCallbackPayloadSchema,
  type TriggerLoopCallbackPayload,
} from "./trigger-callback-payload";

const MAX_CONSECUTIVE_FAILURES = 3;

type TriggerInternalRunCallbackKind = Extract<
  InternalRunCallbackKind,
  "trigger:cron" | "trigger:loop"
>;

type TriggerPayload =
  | { readonly kind: "cron"; readonly data: TriggerCronCallbackPayload }
  | { readonly kind: "loop"; readonly data: TriggerLoopCallbackPayload };

interface HandleTriggerInternalCallbackInput {
  readonly kind: TriggerInternalRunCallbackKind;
  readonly callback: InternalRunCallbackEnvelope;
}

function parseTriggerPayload(
  kind: TriggerInternalRunCallbackKind,
  payload: unknown,
): TriggerPayload | null {
  switch (kind) {
    case "trigger:cron": {
      const result = triggerCronCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "cron", data: result.data } : null;
    }
    case "trigger:loop": {
      const result = triggerLoopCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "loop", data: result.data } : null;
    }
  }
}

export async function handleTriggerInternalCallback(
  db: Db,
  input: HandleTriggerInternalCallbackInput,
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const payload = parseTriggerPayload(input.kind, input.callback.payload);
  if (!payload) {
    return { success: false, error: "Invalid or missing payload" };
  }

  if (input.callback.status === "progress") {
    return { success: true, skipped: true };
  }

  const [trigger] = await db
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.id, payload.data.triggerId))
    .limit(1);
  signal?.throwIfAborted();

  if (!trigger || !trigger.enabled) {
    return { success: true, skipped: true };
  }

  const completedAt = nowDate();
  const consecutiveFailures =
    input.callback.status === "completed" ? 0 : trigger.consecutiveFailures + 1;
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

  await db
    .update(automationTriggers)
    .set({
      consecutiveFailures,
      ...(shouldDisable && { enabled: false }),
      nextRunAt,
      updatedAt: completedAt,
    })
    .where(eq(automationTriggers.id, payload.data.triggerId));
  signal?.throwIfAborted();

  return { success: true };
}

export const handleTriggerInternalCallback$ = command(
  async (
    { set },
    input: HandleTriggerInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleTriggerInternalCallback(set(writeDb$), input, signal);
  },
);
