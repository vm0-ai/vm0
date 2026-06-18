import { command } from "ccstate";
import { zeroWorkflowTriggers } from "@vm0/db/schema/zero-workflow";
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

type WorkflowTriggerInternalRunCallbackKind = Extract<
  InternalRunCallbackKind,
  "workflow-trigger:cron" | "workflow-trigger:loop"
>;

type WorkflowTriggerPayload =
  | { readonly kind: "cron"; readonly data: TriggerCronCallbackPayload }
  | { readonly kind: "loop"; readonly data: TriggerLoopCallbackPayload };

interface HandleWorkflowTriggerInternalCallbackInput {
  readonly kind: WorkflowTriggerInternalRunCallbackKind;
  readonly callback: InternalRunCallbackEnvelope;
}

function parseWorkflowTriggerPayload(
  kind: WorkflowTriggerInternalRunCallbackKind,
  payload: unknown,
): WorkflowTriggerPayload | null {
  switch (kind) {
    case "workflow-trigger:cron": {
      const result = triggerCronCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "cron", data: result.data } : null;
    }
    case "workflow-trigger:loop": {
      const result = triggerLoopCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "loop", data: result.data } : null;
    }
  }
}

/**
 * Advance a workflow schedule trigger after its run completes: cron advances to
 * the next occurrence from the completion time, loop by its interval; a
 * disabled trigger (e.g. a claimed one-time trigger) does not recur. Consecutive
 * failures auto-disable the trigger after three. Mirrors the automation
 * `handleTriggerInternalCallback`, keyed on `zero_workflow_triggers`.
 */
export async function handleWorkflowTriggerInternalCallback(
  db: Db,
  input: HandleWorkflowTriggerInternalCallbackInput,
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const payload = parseWorkflowTriggerPayload(
    input.kind,
    input.callback.payload,
  );
  if (!payload) {
    return { success: false, error: "Invalid or missing payload" };
  }

  if (input.callback.status === "progress") {
    return { success: true, skipped: true };
  }

  const [trigger] = await db
    .select()
    .from(zeroWorkflowTriggers)
    .where(eq(zeroWorkflowTriggers.id, payload.data.triggerId))
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
    .update(zeroWorkflowTriggers)
    .set({
      consecutiveFailures,
      ...(shouldDisable && { enabled: false }),
      nextRunAt,
      updatedAt: completedAt,
    })
    .where(eq(zeroWorkflowTriggers.id, payload.data.triggerId));
  signal?.throwIfAborted();

  return { success: true };
}

export const handleWorkflowTriggerInternalCallback$ = command(
  async (
    { set },
    input: HandleWorkflowTriggerInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleWorkflowTriggerInternalCallback(
      set(writeDb$),
      input,
      signal,
    );
  },
);
