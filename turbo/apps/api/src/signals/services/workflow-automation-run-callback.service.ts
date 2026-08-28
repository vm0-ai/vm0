import { command } from "ccstate";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
  InternalRunCallbackKind,
} from "./internal-run-callback";
import {
  automationCronCallbackPayloadSchema,
  type AutomationCronCallbackPayload,
  automationLoopCallbackPayloadSchema,
  type AutomationLoopCallbackPayload,
} from "./automation-callback-payload";

const MAX_CONSECUTIVE_FAILURES = 3;

type WorkflowAutomationInternalRunCallbackKind = Extract<
  InternalRunCallbackKind,
  "workflow-automation:cron" | "workflow-automation:loop"
>;

type WorkflowAutomationPayload =
  | { readonly kind: "cron"; readonly data: AutomationCronCallbackPayload }
  | { readonly kind: "loop"; readonly data: AutomationLoopCallbackPayload };

interface HandleWorkflowAutomationInternalCallbackInput {
  readonly kind: WorkflowAutomationInternalRunCallbackKind;
  readonly callback: InternalRunCallbackEnvelope;
}

function parseWorkflowAutomationPayload(
  kind: WorkflowAutomationInternalRunCallbackKind,
  payload: unknown,
): WorkflowAutomationPayload | null {
  switch (kind) {
    case "workflow-automation:cron": {
      const result = automationCronCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "cron", data: result.data } : null;
    }
    case "workflow-automation:loop": {
      const result = automationLoopCallbackPayloadSchema.safeParse(payload);
      return result.success ? { kind: "loop", data: result.data } : null;
    }
  }
}

/**
 * Advance a workflow schedule automation after its run completes: cron advances to
 * the next occurrence from the completion time, loop by its interval; a
 * disabled automation (e.g. a claimed one-time automation) does not recur. Consecutive
 * failures auto-disable the automation after three. It is keyed on
 * `workflow_automations`.
 */
export async function handleWorkflowAutomationInternalCallback(
  db: Db,
  input: HandleWorkflowAutomationInternalCallbackInput,
  signal?: AbortSignal,
): Promise<InternalRunCallbackDispatchResult> {
  const payload = parseWorkflowAutomationPayload(
    input.kind,
    input.callback.payload,
  );
  if (!payload) {
    return { success: false, error: "Invalid or missing payload" };
  }

  if (input.callback.status === "progress") {
    return { success: true, skipped: true };
  }

  const [automation] = await db
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, payload.data.automationId))
    .limit(1);
  signal?.throwIfAborted();

  if (!automation || !automation.enabled) {
    return { success: true, skipped: true };
  }

  const completedAt = nowDate();
  const consecutiveFailures =
    input.callback.status === "completed"
      ? 0
      : automation.consecutiveFailures + 1;
  const shouldDisable = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = advanceTimeAutomationAfterCompletion({
    scheduleType: payload.kind,
    cronExpression:
      payload.kind === "cron" ? payload.data.cronExpression : undefined,
    intervalSeconds: automation.intervalSeconds,
    timezone: automation.timezone,
    completedAt,
    shouldDisable,
  });

  await db
    .update(workflowAutomations)
    .set({
      consecutiveFailures,
      ...(shouldDisable && { enabled: false }),
      nextRunAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(workflowAutomations.id, payload.data.automationId),
        eq(workflowAutomations.enabled, true),
      ),
    );
  signal?.throwIfAborted();

  return { success: true };
}

export const handleWorkflowAutomationInternalCallback$ = command(
  async (
    { set },
    input: HandleWorkflowAutomationInternalCallbackInput,
    signal: AbortSignal,
  ): Promise<InternalRunCallbackDispatchResult> => {
    return await handleWorkflowAutomationInternalCallback(
      set(writeDb$),
      input,
      signal,
    );
  },
);
