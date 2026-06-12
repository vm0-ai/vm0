import {
  automationsMainContract,
  automationsByRefContract,
  automationTriggersContract,
  type AutomationResponse,
  type AutomationTriggerResponse,
  type CreateTriggerRequest,
} from "@vm0/api-contracts/contracts/automations";
import type { AutomationView } from "@vm0/api-contracts/contracts/automation-view";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";
import { getMockAutomations, setMockAutomations } from "./automations-store.ts";

// The Automation resource API over the shared automation store: each store row
// (flat single-trigger projection) is served as an automation carrying one
// time trigger. Trigger ids are minted per row and remembered so trigger
// sub-resource calls can be traced back to their store row. Replaced ids stay
// resolvable (`triggerOwners`) because the update flow adds the new trigger
// before deleting the stale one.

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
    triggers: [toTrigger(view)],
  };
}

function triggerFields(
  trigger: CreateTriggerRequest,
): Pick<
  AutomationView,
  "triggerType" | "cronExpression" | "atTime" | "intervalSeconds" | "timezone"
> {
  if (trigger.kind === "cron") {
    return {
      triggerType: "cron",
      cronExpression: trigger.cronExpression,
      atTime: null,
      intervalSeconds: null,
      timezone: trigger.timezone ?? "UTC",
    };
  }
  if (trigger.kind === "once") {
    return {
      triggerType: "once",
      cronExpression: null,
      atTime: trigger.atTime,
      intervalSeconds: null,
      timezone: trigger.timezone ?? "UTC",
    };
  }
  if (trigger.kind === "loop") {
    return {
      triggerType: "loop",
      cronExpression: null,
      atTime: null,
      intervalSeconds: trigger.intervalSeconds,
      timezone: "UTC",
    };
  }
  throw new Error("Webhook triggers are not modeled by the automation mocks");
}

function findByRef(ref: string): AutomationView | undefined {
  return getMockAutomations().find((s) => s.id === ref || s.name === ref);
}

function replaceRow(updated: AutomationView): void {
  setMockAutomations(
    getMockAutomations().map((s) => (s.id === updated.id ? updated : s)),
  );
}

export const apiAutomationsHandlers = [
  // GET /api/automations
  mockApi(automationsMainContract.list, ({ respond }) =>
    respond(200, {
      automations: getMockAutomations().map(toMockAutomationResponse),
    }),
  ),

  // POST /api/automations
  mockApi(automationsMainContract.create, ({ body, respond }) => {
    if (!body.trigger) {
      throw new Error("Automation mocks expect the first-trigger sugar");
    }
    const now = nowDate().toISOString();
    const row: AutomationView = {
      id: crypto.randomUUID(),
      agentId: body.agentId,
      displayName: null,
      userId: "test-user-123",
      name: body.name,
      ...triggerFields(body.trigger),
      prompt: body.instruction,
      description: body.description ?? null,
      appendSystemPrompt: body.appendSystemPrompt ?? null,
      enabled: body.enabled ?? true,
      nextRunAt: null,
      lastRunAt: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
      chatThreadId: body.chatThreadId ?? crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    setMockAutomations([...getMockAutomations(), row]);
    return respond(201, { automation: toMockAutomationResponse(row) });
  }),

  // PATCH /api/automations/:ref
  mockApi(automationsByRefContract.update, ({ params, body, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated: AutomationView = {
      ...row,
      ...(body.name !== undefined && { name: body.name }),
      ...(body.instruction !== undefined && { prompt: body.instruction }),
      ...(body.description !== undefined && { description: body.description }),
      updatedAt: nowDate().toISOString(),
    };
    replaceRow(updated);
    return respond(200, toMockAutomationResponse(updated));
  }),

  // DELETE /api/automations/:ref
  mockApi(automationsByRefContract.delete, ({ params, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    setMockAutomations(getMockAutomations().filter((s) => s.id !== row.id));
    return respond(204);
  }),

  // POST /api/automations/:ref/enable
  mockApi(automationsByRefContract.enable, ({ params, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...row, enabled: true };
    replaceRow(updated);
    return respond(200, toMockAutomationResponse(updated));
  }),

  // POST /api/automations/:ref/disable
  mockApi(automationsByRefContract.disable, ({ params, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...row, enabled: false };
    replaceRow(updated);
    return respond(200, toMockAutomationResponse(updated));
  }),

  // POST /api/automations/:ref/run
  mockApi(automationsByRefContract.run, ({ respond }) =>
    respond(201, { runId: crypto.randomUUID() }),
  ),

  // POST /api/automations/:ref/triggers
  mockApi(automationsByRefContract.addTrigger, ({ params, body, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated: AutomationView = {
      ...row,
      ...triggerFields(body),
      enabled: true,
      consecutiveFailures: 0,
      updatedAt: nowDate().toISOString(),
    };
    // Mint a fresh id for the new trigger; the replaced id stays known so
    // the update flow can still DELETE it afterwards.
    currentTriggerIds.delete(row.id);
    replaceRow(updated);
    return respond(201, { trigger: toTrigger(updated) });
  }),

  // DELETE /api/automation-triggers/:id
  mockApi(automationTriggersContract.remove, ({ params, respond }) => {
    const automationId = automationIdForTrigger(params.id);
    if (!automationId) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    // The store keeps the row; only the trigger id is retired. Removing an
    // already-replaced id leaves the row's current trigger untouched.
    triggerOwners.delete(params.id);
    if (currentTriggerIds.get(automationId) === params.id) {
      currentTriggerIds.delete(automationId);
    }
    return respond(204);
  }),

  // POST /api/automation-triggers/:id/enable
  mockApi(automationTriggersContract.enable, ({ params, respond }) => {
    const automationId = automationIdForTrigger(params.id);
    const row = automationId
      ? getMockAutomations().find((s) => s.id === automationId)
      : undefined;
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...row, consecutiveFailures: 0 };
    replaceRow(updated);
    return respond(200, toTrigger(updated));
  }),
];
