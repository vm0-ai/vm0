import { randomBytes } from "node:crypto";

import type {
  ScheduleCronCallbackPayload,
  ScheduleLoopCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-schedule";
import type { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";

import { internalApiBaseUrl } from "../../../lib/internal-api-url";

/**
 * Identifies how an Automation should be interpreted into an agent run. The
 * interpreter is keyed off the Automation (this kind), not off the trigger.
 * Only the time-based interpreter exists today.
 */
export type InterpreterKind = "time";

/**
 * Domain view of an Automation as the interpreter sees it. This is a thin
 * projection of a `zero_agent_schedules` row down to the fields needed to build
 * an agent-run input: the prompt, the append-prompt context, the agent /
 * chat-thread linkage, and the owning org / user.
 */
export interface Automation {
  readonly interpreterKind: InterpreterKind;
  readonly id: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly triggerType: "cron" | "once" | "loop";
  readonly cronExpression: string | null;
  readonly timezone: string;
}

interface RunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

/**
 * The run-identity metadata an interpreter attaches to its produced run. The
 * time interpreter tags the originating schedule; the webhook interpreter tags
 * the originating automation. Open for the run-create layer to thread either
 * into `zeroRunMetadata`.
 */
export type ZeroRunInputMetadata =
  | { readonly scheduleId: string }
  | { readonly automationId: string };

/**
 * The automation-derived portion of a Zero agent-run request: the parts an
 * interpreter constructs from the Automation definition (and trigger event).
 * Runtime concerns resolved from live state (model pin, provider admission) are
 * layered on by the caller, not by the interpreter. `Metadata` is the
 * interpreter-specific run-identity shape (schedule vs automation).
 */
export interface ZeroRunInput<
  Metadata extends ZeroRunInputMetadata = ZeroRunInputMetadata,
> {
  readonly prompt: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly appendSystemPrompt: string;
  readonly callbacks: readonly RunCallback[];
  readonly zeroRunMetadata: Metadata;
}

/**
 * Builds the agent-run input for an Automation from its definition and a trigger
 * event. Generic over both the automation projection an interpreter consumes
 * (schedule-shaped for time, automation-shaped for webhook) and the trigger
 * event, so each interpreter stays decoupled from the others' shapes.
 */
export interface AutomationInterpreter<
  AutomationProjection,
  TriggerEvent,
  Metadata extends ZeroRunInputMetadata = ZeroRunInputMetadata,
> {
  interpret(
    automation: AutomationProjection,
    triggerEvent: TriggerEvent,
  ): Promise<ZeroRunInput<Metadata>>;
}

/**
 * Trigger event for a time-based Automation: the run request payload. The time
 * interpreter is driven entirely by the Automation definition, so the event
 * only carries the schedule identity for now.
 */
export interface TimeTriggerEvent {
  readonly scheduleId: string;
}

/**
 * Maps a `zero_agent_schedules` row to the Automation view the interpreter
 * consumes. All time-based schedules use the `time` interpreter.
 */
export function scheduleToAutomation(
  schedule: typeof zeroAgentSchedules.$inferSelect,
): Automation {
  return {
    interpreterKind: "time",
    id: schedule.id,
    agentId: schedule.agentId,
    orgId: schedule.orgId,
    userId: schedule.userId,
    chatThreadId: schedule.chatThreadId,
    prompt: schedule.prompt,
    appendSystemPrompt: schedule.appendSystemPrompt,
    triggerType: schedule.triggerType as "cron" | "once" | "loop",
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
  };
}

function buildSchedulePrompt(triggerType: string): string {
  return [
    "# Current Integration",
    "You are currently running inside: Schedule",
    `Trigger type: ${triggerType}`,
  ].join("\n");
}

function buildAppendSystemPrompt(automation: Automation): string {
  const integrationContext = [
    buildSchedulePrompt(automation.triggerType),
    "",
    "This scheduled run is linked to a web chat thread. Everything you output is automatically shown to the user as a chat message in that thread.",
  ].join("\n");
  const baseAppendPrompt = automation.appendSystemPrompt ?? undefined;
  return baseAppendPrompt
    ? `${integrationContext}\n\n${baseAppendPrompt}`
    : integrationContext;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildCallbacks(automation: Automation): RunCallback[] {
  const callbacks: RunCallback[] = [];

  if (automation.triggerType === "loop") {
    const payload: ScheduleLoopCallbackPayload = { scheduleId: automation.id };
    callbacks.push({
      url: `${internalApiBaseUrl()}/api/internal/callbacks/schedule/loop`,
      secret: generateCallbackSecret(),
      payload,
    });
  } else if (
    automation.triggerType === "cron" ||
    automation.triggerType === "once"
  ) {
    const payload: ScheduleCronCallbackPayload = {
      scheduleId: automation.id,
      ...(automation.cronExpression && {
        cronExpression: automation.cronExpression,
      }),
      timezone: automation.timezone,
    };
    callbacks.push({
      url: `${internalApiBaseUrl()}/api/internal/callbacks/schedule/cron`,
      secret: generateCallbackSecret(),
      payload,
    });
  }

  // Also drive the chat callback so the run renders as a web-chat turn
  // (summary/title/lifecycle + autoSend). The reschedule callback above is
  // retained for next_run_at / consecutive-failure bookkeeping; only the chat
  // callback writes the run summary (D9), so callback dispatch order is safe.
  callbacks.push({
    url: `${internalApiBaseUrl()}/api/internal/callbacks/chat`,
    secret: generateCallbackSecret(),
    payload: {
      threadId: automation.chatThreadId,
      agentId: automation.agentId,
    },
  });

  return callbacks;
}

/**
 * Time-based Automation interpreter: renders the schedule as a web-chat turn in
 * its linked thread. Behavior-preserving extraction of the run-input
 * construction that used to be inline in `runScheduleNow$`.
 */
export class TimeInterpreter implements AutomationInterpreter<
  Automation,
  TimeTriggerEvent,
  { readonly scheduleId: string }
> {
  interpret(
    automation: Automation,
    _triggerEvent: TimeTriggerEvent,
  ): Promise<ZeroRunInput<{ readonly scheduleId: string }>> {
    return Promise.resolve({
      prompt: automation.prompt,
      agentId: automation.agentId,
      chatThreadId: automation.chatThreadId,
      appendSystemPrompt: buildAppendSystemPrompt(automation),
      callbacks: buildCallbacks(automation),
      zeroRunMetadata: { scheduleId: automation.id },
    });
  }
}
