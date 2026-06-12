import {
  automationsV2MainContract,
  automationsV2ByRefContract,
  automationTriggersV2Contract,
  type AutomationResponseV2,
  type AutomationTriggerResponse,
  type CreateTriggerRequest,
} from "@vm0/api-contracts/contracts/automations-v2";
import type { ScheduleResponse } from "@vm0/api-contracts/contracts/zero-schedules";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";
import { getMockSchedules, setMockSchedules } from "./schedules-store.ts";

// The Automation resource API over the shared schedule store: each store row
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

function toTrigger(schedule: ScheduleResponse): AutomationTriggerResponse {
  const base = {
    id: triggerIdFor(schedule.id),
    automationId: schedule.id,
    enabled: schedule.enabled,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    timezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    consecutiveFailures: schedule.consecutiveFailures,
  };
  if (schedule.triggerType === "cron") {
    return {
      ...base,
      kind: "cron",
      cronExpression: schedule.cronExpression ?? "0 9 * * *",
    };
  }
  if (schedule.triggerType === "once") {
    return { ...base, kind: "once", atTime: schedule.atTime ?? "" };
  }
  return {
    ...base,
    kind: "loop",
    intervalSeconds: schedule.intervalSeconds ?? 60,
  };
}

/** Project a mock store row as its resource-API automation (for test overrides). */
export function toMockAutomationResponse(
  schedule: ScheduleResponse,
): AutomationResponseV2 {
  return {
    id: schedule.id,
    agentId: schedule.agentId,
    displayName: schedule.displayName,
    userId: schedule.userId,
    name: schedule.name,
    description: schedule.description,
    instruction: schedule.prompt,
    appendSystemPrompt: schedule.appendSystemPrompt,
    enabled: schedule.enabled,
    chatThreadId: schedule.chatThreadId,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    triggers: [toTrigger(schedule)],
  };
}

function triggerFields(
  trigger: CreateTriggerRequest,
): Pick<
  ScheduleResponse,
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
  throw new Error("Webhook triggers are not modeled by the schedule mocks");
}

function findByRef(ref: string): ScheduleResponse | undefined {
  return getMockSchedules().find((s) => s.id === ref || s.name === ref);
}

function replaceRow(updated: ScheduleResponse): void {
  setMockSchedules(
    getMockSchedules().map((s) => (s.id === updated.id ? updated : s)),
  );
}

export const apiAutomationsV2Handlers = [
  // GET /api/automations
  mockApi(automationsV2MainContract.list, ({ respond }) =>
    respond(200, {
      automations: getMockSchedules().map(toMockAutomationResponse),
    }),
  ),

  // POST /api/automations
  mockApi(automationsV2MainContract.create, ({ body, respond }) => {
    if (!body.trigger) {
      throw new Error("Schedule mocks expect the first-trigger sugar");
    }
    const now = nowDate().toISOString();
    const row: ScheduleResponse = {
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
    setMockSchedules([...getMockSchedules(), row]);
    return respond(201, { automation: toMockAutomationResponse(row) });
  }),

  // PATCH /api/automations/:ref
  mockApi(automationsV2ByRefContract.update, ({ params, body, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated: ScheduleResponse = {
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
  mockApi(automationsV2ByRefContract.delete, ({ params, respond }) => {
    const row = findByRef(params.ref);
    if (!row) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    setMockSchedules(getMockSchedules().filter((s) => s.id !== row.id));
    return respond(204);
  }),

  // POST /api/automations/:ref/enable
  mockApi(automationsV2ByRefContract.enable, ({ params, respond }) => {
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
  mockApi(automationsV2ByRefContract.disable, ({ params, respond }) => {
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
  mockApi(automationsV2ByRefContract.run, ({ respond }) =>
    respond(201, { runId: crypto.randomUUID() }),
  ),

  // POST /api/automations/:ref/triggers
  mockApi(
    automationsV2ByRefContract.addTrigger,
    ({ params, body, respond }) => {
      const row = findByRef(params.ref);
      if (!row) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      const updated: ScheduleResponse = {
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
    },
  ),

  // DELETE /api/automation-triggers/:id
  mockApi(automationTriggersV2Contract.remove, ({ params, respond }) => {
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
  mockApi(automationTriggersV2Contract.enable, ({ params, respond }) => {
    const automationId = automationIdForTrigger(params.id);
    const row = automationId
      ? getMockSchedules().find((s) => s.id === automationId)
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
