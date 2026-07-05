import {
  automationsMainContract,
  automationsByRefContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
} from "@vm0/api-contracts/contracts/automations";
import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";
import { mockApi } from "../msw-contract.ts";
import { getMockAutomations } from "./automations-store.ts";

// The Automation resource API over the shared automation store: each store row
// (flat single-trigger projection) is served as an automation carrying one
// time trigger. Trigger ids are minted per row and remembered so trigger
// sub-resource calls can be traced back to their store row. Schedule updates
// PATCH the trigger in place (the id survives).

const currentTriggerIds = new Map<string, string>();
const triggerOwners = new Map<string, string>();

export function resetMockAutomationTriggers(): void {
  currentTriggerIds.clear();
  triggerOwners.clear();
}

function triggerIdFor(automationId: string): string {
  let id = currentTriggerIds.get(automationId);
  if (!id) {
    id = crypto.randomUUID();
    currentTriggerIds.set(automationId, id);
    triggerOwners.set(id, automationId);
  }
  return id;
}

function automationIdForTrigger(triggerId: string): string | null {
  return triggerOwners.get(triggerId) ?? null;
}

function toTrigger(view: AutomationView): AutomationTriggerResponse {
  const base = {
    id: triggerIdFor(view.id),
    automationId: view.id,
    enabled: view.enabled,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    timezone: view.timezone,
    nextRunAt: view.nextRunAt,
    lastRunAt: view.lastRunAt,
    consecutiveFailures: view.consecutiveFailures,
  };
  if (view.triggerType === "cron") {
    return {
      ...base,
      kind: "cron",
      cronExpression: view.cronExpression ?? "0 9 * * *",
    };
  }
  if (view.triggerType === "once") {
    return { ...base, kind: "once", atTime: view.atTime ?? "" };
  }
  return {
    ...base,
    kind: "loop",
    intervalSeconds: view.intervalSeconds ?? 60,
  };
}

/** Project a mock store row as its resource-API automation (for test overrides). */
export function toMockAutomationResponse(
  view: AutomationView,
  options?: { triggers?: AutomationTriggerResponse[] },
): AutomationResponse {
  return {
    id: view.id,
    agentId: view.agentId,
    displayName: view.displayName,
    userId: view.userId,
    name: view.name,
    description: view.description,
    instruction: view.prompt,
    appendSystemPrompt: view.appendSystemPrompt,
    enabled: view.enabled,
    chatThreadId: view.chatThreadId,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    triggers: options?.triggers ?? [toTrigger(view)],
  };
}

function findByRef(ref: string): AutomationView | undefined {
  return getMockAutomations().find((s) => s.id === ref || s.name === ref);
}

export const apiAutomationsHandlers = [
  // GET /api/automations
  mockApi(automationsMainContract.list, ({ respond }) =>
    respond(200, {
      automations: getMockAutomations().map((view) => {
        return toMockAutomationResponse(view);
      }),
    }),
  ),

  // GET /api/automations/:ref
  mockApi(automationsByRefContract.show, ({ params, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, toMockAutomationResponse(row));
  }),

  // GET /api/automation-triggers/:id
  mockApi(automationTriggersContract.show, ({ params, respond }) => {
    const automationId = automationIdForTrigger(params.id);
    const row = automationId
      ? getMockAutomations().find((s) => s.id === automationId)
      : undefined;
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, toTrigger(row));
  }),
];
