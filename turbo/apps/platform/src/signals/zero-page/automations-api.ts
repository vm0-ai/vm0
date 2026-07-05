import {
  automationsMainContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations";
import {
  zeroWorkflowTriggersContract,
  type ChatThreadWorkflowTrigger,
} from "@vm0/api-contracts/contracts/zero-workflows";
import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";
import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";

// ---------------------------------------------------------------------------
// The platform's automation pages over the Automation resource API.
//
// The pages keep their single-trigger editing model: each automation they
// manage carries exactly one time trigger (cron / once / loop), and the view
// model stays `AutomationView` — the flat projection the pages were built
// on. These helpers translate between that projection and the resource API
// (automation + triggers[]), replacing the retired single-trigger surfaces (#17307).
// ---------------------------------------------------------------------------

type TimeTrigger = Extract<
  AutomationTriggerResponse,
  { kind: "cron" | "once" | "loop" }
>;

export type PlatformAutomationView = Omit<
  AutomationView,
  "triggerType" | "timezone" | "consecutiveFailures" | "nextRunAt" | "lastRunAt"
> & {
  triggerType: TimeTrigger["kind"] | null;
  cronExpression: string | null;
  atTime: string | null;
  intervalSeconds: number | null;
  timezone: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number | null;
  triggers: AutomationTriggerResponse[];
};

function isTimeTrigger(
  trigger: AutomationTriggerResponse,
): trigger is TimeTrigger {
  return (
    trigger.kind === "cron" ||
    trigger.kind === "once" ||
    trigger.kind === "loop"
  );
}

function timeTriggerOf(automation: AutomationResponse): TimeTrigger | null {
  return automation.triggers.find(isTimeTrigger) ?? null;
}

// The platform-local projection of an automation. It keeps the legacy flat time
// fields for existing list/calendar/detail code, while carrying the single
// trigger resource used for in-place schedule updates.
function toPlatformAutomationView(
  automation: AutomationResponse,
): PlatformAutomationView {
  const trigger = timeTriggerOf(automation);
  return {
    id: automation.id,
    agentId: automation.agentId,
    displayName: automation.displayName,
    userId: automation.userId,
    name: automation.name,
    triggerType: trigger?.kind ?? null,
    cronExpression: trigger?.kind === "cron" ? trigger.cronExpression : null,
    atTime: trigger?.kind === "once" ? trigger.atTime : null,
    intervalSeconds: trigger?.kind === "loop" ? trigger.intervalSeconds : null,
    timezone: trigger?.timezone ?? null,
    prompt: automation.instruction,
    description: automation.description,
    appendSystemPrompt: automation.appendSystemPrompt,
    enabled: automation.enabled,
    nextRunAt: trigger?.nextRunAt ?? null,
    lastRunAt: trigger?.lastRunAt ?? null,
    retryStartedAt: null,
    consecutiveFailures: trigger?.consecutiveFailures ?? null,
    chatThreadId: automation.chatThreadId,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
    triggers: automation.triggers,
  };
}

async function listAutomationResources(
  client: ZeroClientFactory,
  fetchOptions?: RequestInit,
): Promise<AutomationResponse[]> {
  const result = await accept(
    client(automationsMainContract).list({ fetchOptions }),
    [200],
  );
  return result.body.automations;
}

/** List the automation-page automations (those carrying a time trigger). */
export async function listAutomations(
  client: ZeroClientFactory,
  fetchOptions?: RequestInit,
): Promise<PlatformAutomationView[]> {
  const automations = await listAutomationResources(client, fetchOptions);
  const views: PlatformAutomationView[] = [];
  for (const automation of automations) {
    if (timeTriggerOf(automation)) {
      views.push(toPlatformAutomationView(automation));
    }
  }
  return views;
}

/**
 * List workflow triggers bound to a chat thread. Goal triggers are managed by
 * the goal API and are not part of this workflow sidebar surface.
 */
export async function listThreadWorkflowTriggers(
  client: ZeroClientFactory,
  params: { readonly threadId: string },
  fetchOptions?: RequestInit,
): Promise<ChatThreadWorkflowTrigger[]> {
  const result = await accept(
    client(zeroWorkflowTriggersContract).listForChatThread({
      params: { threadId: params.threadId },
      fetchOptions,
    }),
    [200],
  );
  return result.body;
}

/** Enable or disable a thread-bound workflow trigger. */
export async function setWorkflowTriggerEnabled(
  client: ZeroClientFactory,
  params: { triggerId: string; enabled: boolean },
): Promise<void> {
  const workflowTriggers = client(zeroWorkflowTriggersContract);
  const request = params.enabled
    ? workflowTriggers.enable({ params: { id: params.triggerId } })
    : workflowTriggers.disable({ params: { id: params.triggerId } });
  await accept(request, [200]);
}
