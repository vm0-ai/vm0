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
 * A single default interpreter handles every kind today; this stays on the
 * Automation as the future hook for the first fetching interpreter (e.g. Gmail),
 * at which point a registry replaces the single impl.
 */
export type InterpreterKind = "time" | "webhook";

/**
 * Domain view of an Automation as the interpreter sees it. This is a thin
 * projection down to the fields needed to build an agent-run input: the prompt,
 * the append-prompt context, the agent / chat-thread linkage, and the recurrence
 * (for schedule reschedule callbacks). A webhook automation carries no
 * recurrence — its `triggerType` is "webhook" and its `cronExpression` is null —
 * and supplies its dynamic payload through the trigger event instead.
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
  readonly triggerType: "cron" | "once" | "loop" | "webhook";
  readonly cronExpression: string | null;
  readonly timezone: string;
}

interface RunCallback {
  readonly url: string;
  readonly secret: string;
  readonly payload: unknown;
}

/**
 * The run-identity metadata an interpreter attaches to its produced run. A time
 * fire tags the originating schedule; a webhook fire tags the originating
 * automation plus the trigger that fired it (run provenance). Open for the
 * run-create layer to thread either into `zeroRunMetadata`.
 */
type ZeroRunInputMetadata =
  | { readonly scheduleId: string }
  | { readonly automationId: string; readonly triggerId: string };

/**
 * The automation-derived portion of a Zero agent-run request: the parts the
 * interpreter constructs from the Automation definition (and trigger event).
 * Runtime concerns resolved from live state (model pin, provider admission) are
 * layered on by the caller, not by the interpreter. `Metadata` is the
 * trigger-specific run-identity shape (schedule vs automation).
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
 * Trigger event for a time fire: the run request payload. The time path is
 * driven entirely by the Automation definition, so the event only carries the
 * schedule identity. The `kind` discriminant lets the single interpreter branch
 * between an instruction-only run (time) and a payload-context run (webhook).
 */
interface TimeTriggerEvent {
  readonly kind: "time";
  readonly scheduleId: string;
}

/**
 * Trigger event for a webhook fire: the inbound request reduced to the parts the
 * interpreter renders into the run context. `triggerId` is the firing
 * `automation_triggers` row (run provenance); `headers` is the request header
 * map; `body` is the parsed JSON payload (an object/array/primitive) or the raw
 * string when the body is not JSON.
 */
export interface WebhookTriggerEvent {
  readonly kind: "webhook";
  readonly triggerId: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/**
 * The trigger that fired an Automation. A time fire carries only the schedule
 * identity; a webhook fire carries the raw inbound payload. The interpreter
 * keys its context/callbacks/metadata off this discriminant.
 */
type TriggerEvent = TimeTriggerEvent | WebhookTriggerEvent;

/**
 * Maps a `zero_agent_schedules` row to the Automation view the interpreter
 * consumes. All time-based schedules use the `time` interpreter kind.
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

/**
 * Maps an `automations` row (joined with its firing trigger) to the Automation
 * view the interpreter consumes. A webhook automation carries no recurrence, so
 * the time-only fields collapse to their inert values; its dynamic payload
 * arrives through the trigger event instead. Counterpart to
 * `scheduleToAutomation` for the webhook fire path.
 */
export function webhookRowToAutomation(row: {
  readonly id: string;
  readonly agentId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly instruction: string;
}): Automation {
  return {
    interpreterKind: "webhook",
    id: row.id,
    agentId: row.agentId,
    orgId: row.orgId,
    userId: row.userId,
    chatThreadId: row.chatThreadId,
    prompt: row.instruction,
    appendSystemPrompt: null,
    triggerType: "webhook",
    cronExpression: null,
    timezone: "UTC",
  };
}

function buildSchedulePrompt(triggerType: string): string {
  return [
    "# Current Integration",
    "You are currently running inside: Schedule",
    `Trigger type: ${triggerType}`,
  ].join("\n");
}

/**
 * Schedule (time-fire) context: the integration header plus any user-provided
 * append prompt. Behavior-preserving extraction of the time interpreter.
 */
function buildScheduleAppendSystemPrompt(automation: Automation): string {
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

/**
 * Render the webhook payload (headers + body) as a single fenced JSON block so
 * the agent can read the trigger that fired it. v1 does no templating: the
 * payload is passed through verbatim as run context (YAGNI — no JSONPath).
 */
function buildWebhookAppendSystemPrompt(event: WebhookTriggerEvent): string {
  const payload = JSON.stringify(
    { headers: event.headers, body: event.body },
    null,
    2,
  );
  return [
    "# Current Integration",
    "You are currently running inside: Webhook automation",
    "",
    "This automation was fired by an inbound webhook. The request that triggered it is below as JSON (request headers and body).",
    "",
    "```json",
    payload,
    "```",
    "",
    "This run is linked to a web chat thread. Everything you output is automatically shown to the user as a chat message in that thread.",
  ].join("\n");
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
    url: `${internalApiBaseUrl()}/api/internal/callbacks/chat`,
    secret: generateCallbackSecret(),
    payload: {
      threadId: automation.chatThreadId,
      agentId: automation.agentId,
    },
  };
}

/**
 * Time-fire callbacks: the recurrence-specific reschedule callback (next_run_at
 * / consecutive-failure bookkeeping) plus the chat callback. Only the chat
 * callback writes the run summary (D9), so callback dispatch order is safe.
 */
function buildScheduleCallbacks(automation: Automation): RunCallback[] {
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

  callbacks.push(buildChatCallback(automation));

  return callbacks;
}

/**
 * The single default Automation interpreter. It builds the agent-run input from
 * `(automation, triggerEvent)`:
 *
 * - `prompt` is always the automation's user instruction.
 * - A webhook fire (raw inbound payload) renders headers + body into the run
 *   context as a fenced JSON block, and tags the run with the originating
 *   automation + trigger (run provenance). No reschedule callback (webhooks
 *   don't recur).
 * - A time fire (no raw payload) is instruction-only: it renders the schedule
 *   integration context plus any user append prompt, attaches the recurrence
 *   reschedule callback, and tags the run with the originating schedule.
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
    if (triggerEvent.kind === "webhook") {
      return Promise.resolve({
        prompt: automation.prompt,
        agentId: automation.agentId,
        chatThreadId: automation.chatThreadId,
        appendSystemPrompt: buildWebhookAppendSystemPrompt(triggerEvent),
        callbacks: [buildChatCallback(automation)],
        zeroRunMetadata: {
          automationId: automation.id,
          triggerId: triggerEvent.triggerId,
        },
      });
    }

    return Promise.resolve({
      prompt: automation.prompt,
      agentId: automation.agentId,
      chatThreadId: automation.chatThreadId,
      appendSystemPrompt: buildScheduleAppendSystemPrompt(automation),
      callbacks: buildScheduleCallbacks(automation),
      zeroRunMetadata: { scheduleId: automation.id },
    });
  }
}
