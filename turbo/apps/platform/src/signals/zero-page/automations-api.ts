import {
  automationsMainContract,
  automationsByRefContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
  type CreateTriggerRequest,
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
// (automation + triggers[]), replacing the retired schedule surfaces (#17307).
// ---------------------------------------------------------------------------

type TimeTrigger = Extract<
  AutomationTriggerResponse,
  { kind: "cron" | "once" | "loop" }
>;

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

// The flat single-trigger projection of an automation: the pages' view model.
// `retryStartedAt` is vestigial in the contract and always null.
function toAutomationView(
  automation: AutomationResponse,
  trigger: TimeTrigger,
): AutomationView {
  return {
    id: automation.id,
    agentId: automation.agentId,
    displayName: automation.displayName,
    userId: automation.userId,
    name: automation.name,
    triggerType: trigger.kind,
    cronExpression: trigger.kind === "cron" ? trigger.cronExpression : null,
    atTime: trigger.kind === "once" ? trigger.atTime : null,
    intervalSeconds: trigger.kind === "loop" ? trigger.intervalSeconds : null,
    timezone: trigger.timezone,
    prompt: automation.instruction,
    description: automation.description,
    appendSystemPrompt: automation.appendSystemPrompt,
    enabled: automation.enabled,
    nextRunAt: trigger.nextRunAt,
    lastRunAt: trigger.lastRunAt,
    retryStartedAt: null,
    consecutiveFailures: trigger.consecutiveFailures,
    chatThreadId: automation.chatThreadId,
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function toTriggerRequest(body: AutomationFormBody): CreateTriggerRequest {
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
): Promise<AutomationView[]> {
  const automations = await listAutomationResources(client, fetchOptions);
  const views: AutomationView[] = [];
  for (const automation of automations) {
    const trigger = timeTriggerOf(automation);
    if (trigger) {
      views.push(toAutomationView(automation, trigger));
    }
  }
  return views;
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
): Promise<{ id: string; created: boolean }> {
  const existing = await findByNameAndAgent(client, body.name, body.agentId);

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

  // Replace the time trigger when its config changed. The new trigger is
  // added before the stale one is removed, so a failure in between never
  // leaves the automation triggerless (a triggerless automation vanishes
  // from the automation pages); the sweep then also collects duplicates left
  // behind by an earlier interrupted replacement.
  const timeTriggers = existing.triggers.filter(isTimeTrigger);
  const kept = timeTriggers.find((trigger) => {
    return triggerMatches(trigger, body);
  });
  if (!kept) {
    await accept(
      client(automationsByRefContract).addTrigger({
        params: { ref: existing.id },
        body: toTriggerRequest(body),
      }),
      [201],
    );
  }
  for (const stale of timeTriggers) {
    if (stale !== kept) {
      await accept(
        client(automationTriggersContract).remove({
          params: { id: stale.id },
        }),
        [204],
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
): Promise<{ id: string; created: boolean }> {
  return isUpdate
    ? updateAutomation(client, body)
    : createAutomation(client, body);
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
