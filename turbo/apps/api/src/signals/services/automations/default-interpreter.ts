import { randomBytes } from "node:crypto";

import type { InternalRunCallbackKind } from "../internal-run-callback";
import type {
  TriggerCronCallbackPayload,
  TriggerLoopCallbackPayload,
} from "../trigger-callback-payload";

/**
 * Identifies how an Automation should be interpreted into an agent run. The
 * interpreter is keyed off the Automation (this kind), not off the trigger.
 * A single default interpreter handles every kind today; this stays on the
 * Automation as the future hook for the first fetching interpreter (e.g. Gmail),
 * at which point a registry replaces the single impl.
 */
type InterpreterKind = "time" | "default";

/**
 * Domain view of an Automation as the interpreter sees it. This is a thin
 * projection down to the fields needed to build an agent-run input: the prompt,
 * the append-prompt context, the agent / chat-thread linkage, and the
 * recurrence for time-trigger reschedule callbacks.
 */
interface Automation {
  readonly interpreterKind: InterpreterKind;
  readonly id: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly triggerType: "cron" | "once" | "loop" | "manual";
  readonly cronExpression: string | null;
  readonly timezone: string;
}

interface InternalRunCallback {
  readonly internalKind: InternalRunCallbackKind;
  readonly secret: string;
  readonly payload: unknown;
}

type RunCallback = InternalRunCallback;

/**
 * The run-identity metadata an interpreter attaches to its produced run. A time
 * fire tags the originating automation plus the trigger that fired it (run
 * provenance); a manual fire was not fired by any trigger, so its `triggerId`
 * is absent — the run-create layer's metadata fields are all optional, this
 * local shape just keeps `automationId` required.
 */
type ZeroRunInputMetadata = {
  readonly automationId: string;
  readonly triggerId?: string;
};

/**
 * The automation-derived portion of a Zero agent-run request: the parts the
 * interpreter constructs from the Automation definition (and trigger event).
 * Runtime concerns resolved from live state (model pin, provider admission) are
 * layered on by the caller, not by the interpreter. `Metadata` is the
 * trigger-specific run-identity shape.
 */
interface ZeroRunInput<
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
 * Trigger event for an automation-table time fire (the trigger poller, U4).
 * It is instruction-only — no inbound payload — and tags the run with the
 * originating automation + the firing `automation_triggers` row (run
 * provenance, U3), attaching the trigger-keyed reschedule callback (the claim
 * cleared `next_run_at`; the callback advances it). `triggerId` is the firing
 * trigger row.
 */
interface AutomationTimeTriggerEvent {
  readonly kind: "automation-time";
  readonly triggerId: string;
}

/**
 * Trigger event for a manual fire (the run-now endpoint): instruction-only
 * like a time fire, but no trigger row was claimed, so the run carries neither
 * a trigger provenance tag nor a reschedule callback — only the chat callback.
 */
interface ManualTriggerEvent {
  readonly kind: "manual";
}

/**
 * The trigger that fired an Automation. A time fire carries the firing trigger
 * identity; a manual fire carries nothing. The interpreter keys its
 * context/callbacks/metadata off this discriminant.
 */
type TriggerEvent = AutomationTimeTriggerEvent | ManualTriggerEvent;

/**
 * Maps an `automations` row (joined with its firing time trigger) to the
 * Automation view the interpreter consumes for an automation-table time fire
 * (the trigger poller). The recurrence lives on the trigger row, so its
 * `kind` (cron/once/loop) and `cronExpression`/`timezone` are threaded in
 * here.
 */
export function automationRowToTimeAutomation(row: {
  readonly id: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly instruction: string;
  readonly appendSystemPrompt: string | null;
  readonly triggerType: "cron" | "once" | "loop";
  readonly cronExpression: string | null;
  readonly timezone: string;
}): Automation {
  return {
    interpreterKind: "time",
    id: row.id,
    agentId: row.agentId,
    orgId: row.orgId,
    userId: row.userId,
    chatThreadId: row.chatThreadId,
    prompt: row.instruction,
    appendSystemPrompt: row.appendSystemPrompt,
    triggerType: row.triggerType,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
  };
}

/**
 * Maps an `automations` row to the Automation view the interpreter consumes for
 * a manual fire (the run-now endpoint). A manual fire is keyed off no
 * trigger row, so the recurrence fields collapse to their inert values and the
 * `triggerType` renders as "manual" in the automation integration context.
 */
export function automationRowToManualAutomation(row: {
  readonly id: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly instruction: string;
  readonly appendSystemPrompt: string | null;
}): Automation {
  return {
    interpreterKind: "default",
    id: row.id,
    agentId: row.agentId,
    orgId: row.orgId,
    userId: row.userId,
    chatThreadId: row.chatThreadId,
    prompt: row.instruction,
    appendSystemPrompt: row.appendSystemPrompt,
    triggerType: "manual",
    cronExpression: null,
    timezone: "UTC",
  };
}

function buildAutomationPrompt(triggerType: string): string {
  return [
    "# Current Integration",
    "You are currently running inside: Automation",
    `Trigger type: ${triggerType}`,
  ].join("\n");
}

/**
 * Automation (time-fire) context: the integration header plus any user-provided
 * append prompt. Behavior-preserving extraction of the time interpreter.
 */
function buildAutomationAppendSystemPrompt(automation: Automation): string {
  const integrationContext = [
    buildAutomationPrompt(automation.triggerType),
    "",
    "This automated run is linked to a web chat thread. Everything you output is automatically shown to the user as a chat message in that thread.",
  ].join("\n");
  const baseAppendPrompt = automation.appendSystemPrompt ?? undefined;
  return baseAppendPrompt
    ? `${integrationContext}\n\n${baseAppendPrompt}`
    : integrationContext;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The chat callback drives the web-chat render (summary/title/lifecycle +
 * autoSend). Both fire paths attach it so the run shows up as a turn in the
 * linked thread.
 */
function buildChatCallback(automation: Automation): RunCallback {
  return {
    internalKind: "chat",
    secret: generateCallbackSecret(),
    payload: {
      threadId: automation.chatThreadId,
      agentId: automation.agentId,
    },
  };
}

/**
 * Trigger-table time-fire callbacks: the recurrence-specific reschedule
 * callback keyed on the firing `automation_triggers` row (next_run_at /
 * consecutive-failure bookkeeping in the trigger callback route) plus the chat
 * callback — the events-first counterpart of `buildScheduleCallbacks`. Only the
 * chat callback writes the run summary (D9), so callback dispatch order is safe.
 */
function buildTriggerCallbacks(
  automation: Automation,
  triggerId: string,
): RunCallback[] {
  const callbacks: RunCallback[] = [];

  if (automation.triggerType === "loop") {
    const payload: TriggerLoopCallbackPayload = { triggerId };
    callbacks.push({
      internalKind: "trigger:loop",
      secret: generateCallbackSecret(),
      payload,
    });
  } else if (
    automation.triggerType === "cron" ||
    automation.triggerType === "once"
  ) {
    const payload: TriggerCronCallbackPayload = {
      triggerId,
      ...(automation.cronExpression && {
        cronExpression: automation.cronExpression,
      }),
      timezone: automation.timezone,
    };
    callbacks.push({
      internalKind: "trigger:cron",
      secret: generateCallbackSecret(),
      payload,
    });
  }

  callbacks.push(buildChatCallback(automation));

  return callbacks;
}

/**
 * The single default Automation interpreter. It builds the agent-run input from
 * `(automation, triggerEvent)`:
 *
 * - `prompt` is always the automation's user instruction.
 * - A time fire (no raw payload) is instruction-only: it renders the
 *   automation integration context plus any user append prompt, attaches the
 *   recurrence reschedule callback, and tags the run with the originating
 *   automation.
 *
 * Both fire paths attach the chat callback so the run renders as a web-chat turn
 * in the linked thread. One impl for now; the registry is deferred to the first
 * fetching interpreter (e.g. Gmail), keyed off `automation.interpreterKind`.
 */
export class DefaultInterpreter {
  interpret(
    automation: Automation,
    triggerEvent: TriggerEvent,
  ): Promise<ZeroRunInput> {
    // Manual fire: instruction-only automation context, tagged with the
    // automation alone — no trigger was claimed, so there is no trigger
    // provenance and no reschedule callback, only the chat callback.
    if (triggerEvent.kind === "manual") {
      return Promise.resolve({
        prompt: automation.prompt,
        agentId: automation.agentId,
        chatThreadId: automation.chatThreadId,
        appendSystemPrompt: buildAutomationAppendSystemPrompt(automation),
        callbacks: [buildChatCallback(automation)],
        zeroRunMetadata: { automationId: automation.id },
      });
    }

    // Time fire: instruction-only automation context, tagged with the
    // automation + firing trigger (provenance) and carrying the trigger-keyed
    // reschedule callback — the claim cleared next_run_at, the callback
    // advances it.
    return Promise.resolve({
      prompt: automation.prompt,
      agentId: automation.agentId,
      chatThreadId: automation.chatThreadId,
      appendSystemPrompt: buildAutomationAppendSystemPrompt(automation),
      callbacks: buildTriggerCallbacks(automation, triggerEvent.triggerId),
      zeroRunMetadata: {
        automationId: automation.id,
        triggerId: triggerEvent.triggerId,
      },
    });
  }
}
