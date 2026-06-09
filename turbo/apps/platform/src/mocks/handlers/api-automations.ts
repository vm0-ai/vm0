import {
  automationsMainContract,
  automationsByNameContract,
  automationsEnableContract,
  automationRunContract,
} from "@vm0/api-contracts/contracts/automations";
import type { ScheduleResponse } from "@vm0/api-contracts/contracts/zero-schedules";
import { mockApi } from "../msw-contract.ts";
import { getMockSchedules, setMockSchedules } from "./schedules-store.ts";

// Mirrors the production Automations route: a thin product projection over the
// very same schedule service, so these handlers operate on the shared schedule
// store. An automation row IS a schedule row; only the wrapper key differs
// (`automations` vs `schedules`, `automationId` vs `scheduleId`).

function upsert(
  body: {
    readonly agentId: string;
    readonly name: string;
    readonly cronExpression?: string;
    readonly atTime?: string;
    readonly intervalSeconds?: number;
    readonly timezone: string;
    readonly prompt: string;
    readonly description?: string;
    readonly appendSystemPrompt?: string;
    readonly enabled?: boolean;
    readonly chatThreadId?: string;
  },
  name: string,
): { automation: ScheduleResponse; created: boolean; status: 200 | 201 } {
  const now = new Date().toISOString();
  const automation: ScheduleResponse = {
    id: crypto.randomUUID(),
    agentId: body.agentId,
    displayName: null,
    userId: "test-user-123",
    name,
    triggerType: body.cronExpression ? "cron" : body.atTime ? "once" : "loop",
    cronExpression: body.cronExpression ?? null,
    atTime: body.atTime ?? null,
    intervalSeconds: body.intervalSeconds ?? null,
    timezone: body.timezone,
    prompt: body.prompt,
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
  const automations = getMockSchedules();
  const existing = automations.find((s) => s.name === name);
  if (existing) {
    setMockSchedules(
      automations.map((s) => (s.name === name ? automation : s)),
    );
    return { automation, created: false, status: 200 };
  }
  setMockSchedules([...automations, automation]);
  return { automation, created: true, status: 201 };
}

export const apiAutomationsHandlers = [
  // GET /api/automations
  mockApi(automationsMainContract.list, ({ respond }) =>
    respond(200, { automations: getMockSchedules() }),
  ),

  // POST /api/automations
  mockApi(automationsMainContract.create, ({ body, respond }) => {
    const { automation, created, status } = upsert(body, body.name);
    return respond(status, { automation, created });
  }),

  // PUT /api/automations/:name
  mockApi(automationsByNameContract.update, ({ params, body, respond }) => {
    const { automation, created, status } = upsert(
      { ...body, name: params.name },
      params.name,
    );
    return respond(status, { automation, created });
  }),

  // DELETE /api/automations/:name
  mockApi(automationsByNameContract.delete, ({ params, respond }) => {
    setMockSchedules(getMockSchedules().filter((s) => s.name !== params.name));
    return respond(204);
  }),

  // POST /api/automations/:name/enable
  mockApi(automationsEnableContract.enable, ({ params, respond }) => {
    const automation = getMockSchedules().find((s) => s.name === params.name);
    if (!automation) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...automation, enabled: true };
    setMockSchedules(
      getMockSchedules().map((s) => (s.name === params.name ? updated : s)),
    );
    return respond(200, updated);
  }),

  // POST /api/automations/:name/disable
  mockApi(automationsEnableContract.disable, ({ params, respond }) => {
    const automation = getMockSchedules().find((s) => s.name === params.name);
    if (!automation) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...automation, enabled: false };
    setMockSchedules(
      getMockSchedules().map((s) => (s.name === params.name ? updated : s)),
    );
    return respond(200, updated);
  }),

  // POST /api/automations/run
  mockApi(automationRunContract.run, ({ respond }) =>
    respond(201, { runId: crypto.randomUUID() }),
  ),
];
