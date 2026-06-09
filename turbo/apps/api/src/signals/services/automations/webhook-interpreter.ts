import { randomBytes } from "node:crypto";

import { internalApiBaseUrl } from "../../../lib/internal-api-url";
import type { AutomationInterpreter, ZeroRunInput } from "./time-interpreter";

/**
 * Domain view of a webhook Automation as the interpreter sees it: a thin
 * projection of an `automations` row down to the fields needed to build an
 * agent-run input. Unlike the schedule-shaped `Automation`, a webhook
 * automation carries no recurrence; its prompt is the user `instruction` and
 * the trigger event supplies the dynamic payload.
 */
export interface WebhookAutomation {
  readonly id: string;
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly instruction: string;
}

/**
 * Trigger event for a webhook Automation: the inbound request reduced to the
 * parts the interpreter renders into the run context. `headers` is the request
 * header map; `body` is the parsed JSON payload (an object/array/primitive) or
 * the raw string when the body is not JSON.
 */
export interface WebhookTriggerEvent {
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type WebhookRunMetadata = { readonly automationId: string };

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Render the webhook payload (headers + body) as a single fenced JSON block so
 * the agent can read the trigger that fired it. v1 does no templating: the
 * payload is passed through verbatim as run context (YAGNI — no JSONPath).
 */
function buildWebhookContextPrompt(event: WebhookTriggerEvent): string {
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

/**
 * Webhook Automation interpreter: turns an inbound webhook request into an
 * agent run. The prompt is the automation's user `instruction`; the request
 * payload is placed into the run context as a fenced JSON block. The chat
 * callback renders the run as a web-chat turn in the linked thread (mirroring
 * the time interpreter), and the run is tagged with the originating automation.
 */
export class WebhookInterpreter implements AutomationInterpreter<
  WebhookAutomation,
  WebhookTriggerEvent,
  WebhookRunMetadata
> {
  interpret(
    automation: WebhookAutomation,
    triggerEvent: WebhookTriggerEvent,
  ): Promise<ZeroRunInput<WebhookRunMetadata>> {
    return Promise.resolve({
      prompt: automation.instruction,
      agentId: automation.agentId,
      chatThreadId: automation.chatThreadId,
      appendSystemPrompt: buildWebhookContextPrompt(triggerEvent),
      callbacks: [
        {
          url: `${internalApiBaseUrl()}/api/internal/callbacks/chat`,
          secret: generateCallbackSecret(),
          payload: {
            threadId: automation.chatThreadId,
            agentId: automation.agentId,
          },
        },
      ],
      zeroRunMetadata: { automationId: automation.id },
    });
  }
}
