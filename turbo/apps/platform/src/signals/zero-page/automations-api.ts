import {
  automationsMainContract,
  automationsByRefContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
  type ChatThreadWorkflowTrigger,
  type UpdateTriggerRequest,
} from "@vm0/api-contracts/contracts/automations";
import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";
import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";
import type { AutomationFormBody } from "./cron.ts";

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

export type AutomationTriggerReadOnlyReason =
  | "multiple_triggers"
  | "unsupported_trigger"
  | "no_trigger";

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
  triggerCount: number;
  triggerKinds: AutomationTriggerResponse["kind"][];
  triggerEditable: boolean;
  triggerReadOnlyReason: AutomationTriggerReadOnlyReason | null;
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

function triggerReadOnlyReason(
  automation: AutomationResponse,
): AutomationTriggerReadOnlyReason | null {
  if (automation.triggers.length === 0) {
    return "no_trigger";
  }
  if (automation.triggers.length > 1) {
    return "multiple_triggers";
  }
  return timeTriggerOf(automation) ? null : "unsupported_trigger";
}

// The platform-local projection of an automation. It keeps the legacy flat time
// fields for existing list/calendar/detail code, while carrying the resource
// triggers needed by the new Trigger section.
function toPlatformAutomationView(
  automation: AutomationResponse,
): PlatformAutomationView {
  const trigger = timeTriggerOf(automation);
  const readOnlyReason = triggerReadOnlyReason(automation);
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
    triggerCount: automation.triggers.length,
    triggerKinds: automation.triggers.map((t) => {
      return t.kind;
    }),
    triggerEditable: readOnlyReason === null,
    triggerReadOnlyReason: readOnlyReason,
  };
}

// The narrower update union also satisfies the create-time trigger body.
function toTriggerRequest(body: AutomationFormBody): UpdateTriggerRequest {
  if ("cronExpression" in body) {
    return {
      kind: "cron",
      cronExpression: body.cronExpression,
      timezone: body.timezone,
    };
  }
  if ("atTime" in body) {
    return { kind: "once", atTime: body.atTime, timezone: body.timezone };
  }
  return { kind: "loop", intervalSeconds: body.intervalSeconds };
}

// Whether the existing trigger already matches the requested config — if so,
// the update skips the trigger replacement and keeps the run history state.
function triggerMatches(
  trigger: TimeTrigger,
  body: AutomationFormBody,
): boolean {
  if ("cronExpression" in body) {
    return (
      trigger.kind === "cron" &&
      trigger.cronExpression === body.cronExpression &&
      trigger.timezone === body.timezone
    );
  }
  if ("atTime" in body) {
    return (
      trigger.kind === "once" &&
      trigger.atTime === body.atTime &&
      trigger.timezone === body.timezone
    );
  }
  return (
    trigger.kind === "loop" && trigger.intervalSeconds === body.intervalSeconds
  );
}

async function listAutomationResources(
  client: ZeroClientFactory,
  fetchOptions?: RequestInit,
): Promise<AutomationResponse[]> {
  const result = await accept(
    client(automationsMainContract).list({ fetchOptions }),
    [200],
    { toast: false },
  );
  return result.body.automations;
}

// Names are unique per (agent, name) on the legacy surfaces but only the id is
// unambiguous on the resource API, so the helpers resolve through the list.
async function findByNameAndAgent(
  client: ZeroClientFactory,
  name: string,
  agentId: string,
): Promise<AutomationResponse> {
  const automations = await listAutomationResources(client);
  const match = automations.find((a) => {
    return a.name === name && a.agentId === agentId;
  });
  if (!match) {
    throw new Error(`Automation not found: ${name}`);
  }
  return match;
}

/** List the automation-page automations (those carrying a time trigger). */
export async function listAutomations(
  client: ZeroClientFactory,
  fetchOptions?: RequestInit,
  options?: { includeUnsupported?: boolean },
): Promise<PlatformAutomationView[]> {
  const automations = await listAutomationResources(client, fetchOptions);
  const views: PlatformAutomationView[] = [];
  for (const automation of automations) {
    if (options?.includeUnsupported || timeTriggerOf(automation)) {
      views.push(toPlatformAutomationView(automation));
    }
  }
  return views;
}

/**
 * List the workflow + goal triggers bound to the caller's chat threads. Surfaced
 * in the chat-thread automation sidebar; consumers filter by `chatThreadId`.
 */
export async function listThreadWorkflowTriggers(
  client: ZeroClientFactory,
  fetchOptions?: RequestInit,
): Promise<ChatThreadWorkflowTrigger[]> {
  const result = await accept(
    client(automationsMainContract).list({ fetchOptions }),
    [200],
    { toast: false },
  );
  return result.body.workflowTriggers;
}

/** Enable or disable a thread-bound workflow/goal trigger. */
export async function setWorkflowTriggerEnabled(
  client: ZeroClientFactory,
  params: { triggerId: string; enabled: boolean },
): Promise<void> {
  await accept(
    client(automationsMainContract).toggleWorkflowTrigger({
      params: { id: params.triggerId },
      body: { enabled: params.enabled },
    }),
    [204],
    { toast: false },
  );
}

async function createAutomation(
  client: ZeroClientFactory,
  body: AutomationFormBody,
): Promise<{ id: string; created: boolean }> {
  const result = await accept(
    client(automationsMainContract).create({
      body: {
        name: body.name,
        agentId: body.agentId,
        instruction: body.prompt,
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        trigger: toTriggerRequest(body),
      },
    }),
    [201],
  );
  return { id: result.body.automation.id, created: true };
}

async function updateAutomation(
  client: ZeroClientFactory,
  body: AutomationFormBody,
  options?: { requireEditableTrigger?: boolean },
): Promise<{ id: string; created: boolean }> {
  const existing = await findByNameAndAgent(client, body.name, body.agentId);
  if (
    options?.requireEditableTrigger &&
    triggerReadOnlyReason(existing) !== null
  ) {
    throw new Error(
      "This automation has triggers managed outside platform. Edit the trigger from the CLI or API.",
    );
  }

  await accept(
    client(automationsByRefContract).update({
      params: { ref: existing.id },
      body: {
        instruction: body.prompt,
        description: body.description ?? null,
      },
    }),
    [200],
  );

  // Replace the time trigger's schedule in place when its config changed:
  // one atomic PATCH that keeps the trigger's id and run history. A
  // triggerless automation (not visible on these pages) gets a fresh
  // trigger instead.
  const timeTriggers = existing.triggers.filter(isTimeTrigger);
  const kept = timeTriggers.find((trigger) => {
    return triggerMatches(trigger, body);
  });
  if (!kept) {
    const [current] = timeTriggers;
    if (current) {
      await accept(
        client(automationTriggersContract).update({
          params: { id: current.id },
          body: toTriggerRequest(body),
        }),
        [200],
      );
    } else {
      await accept(
        client(automationsByRefContract).addTrigger({
          params: { ref: existing.id },
          body: toTriggerRequest(body),
        }),
        [201],
      );
    }
  }

  return { id: existing.id, created: false };
}

/**
 * Upsert a single-time-trigger automation, keyed on (agent, name). Updates patch
 * the intent fields and replace the time trigger when its config changed.
 */
export function deployAutomation(
  client: ZeroClientFactory,
  body: AutomationFormBody,
  isUpdate: boolean,
  options?: { requireEditableTrigger?: boolean },
): Promise<{ id: string; created: boolean }> {
  return isUpdate
    ? updateAutomation(client, body, options)
    : createAutomation(client, body);
}

export async function updateAutomationIntent(
  client: ZeroClientFactory,
  params: {
    id: string;
    prompt?: string;
    description?: string | null;
  },
): Promise<void> {
  await accept(
    client(automationsByRefContract).update({
      params: { ref: params.id },
      body: {
        ...(params.prompt !== undefined && { instruction: params.prompt }),
        ...(params.description !== undefined && {
          description: params.description,
        }),
      },
    }),
    [200],
  );
}

/**
 * Enable or disable an automation by name, with the legacy surface's enable
 * semantics: the time trigger is re-enabled first (reviving an auto-disabled
 * automation and resetting its failure count; an expired one-time trigger is
 * rejected before any flag flips), then the automation resumes — which
 * recomputes the trigger's next run.
 */
export async function setAutomationEnabled(
  client: ZeroClientFactory,
  params: { name: string; agentId: string; enabled: boolean },
): Promise<void> {
  const automation = await findByNameAndAgent(
    client,
    params.name,
    params.agentId,
  );
  if (params.enabled) {
    const trigger = timeTriggerOf(automation);
    if (trigger) {
      await accept(
        client(automationTriggersContract).enable({
          params: { id: trigger.id },
          body: undefined,
        }),
        [200],
      );
    }
  }
  const action = params.enabled ? "enable" : "disable";
  await accept(
    client(automationsByRefContract)[action]({
      params: { ref: automation.id },
      body: undefined,
    }),
    [200],
  );
}

/** Delete an automation by name. */
export async function deleteAutomation(
  client: ZeroClientFactory,
  params: { name: string; agentId: string },
): Promise<void> {
  const automation = await findByNameAndAgent(
    client,
    params.name,
    params.agentId,
  );
  await accept(
    client(automationsByRefContract).delete({
      params: { ref: automation.id },
    }),
    [204],
  );
}

/** Execute an automation immediately; returns the created run id. */
export async function runAutomationNow(
  client: ZeroClientFactory,
  id: string,
): Promise<string> {
  const result = await accept(
    client(automationsByRefContract).run({
      params: { ref: id },
      body: undefined,
    }),
    [201],
    { toast: false },
  );
  return result.body.runId;
}
