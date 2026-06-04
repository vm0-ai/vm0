import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { mockApi } from "../msw-contract.ts";

let mockSchedules: ScheduleResponse[] = [];

export function createMockScheduleResponse(
  overrides?: Partial<ScheduleResponse>,
): ScheduleResponse {
  return {
    id: "f0000001-0000-4000-a000-000000000001",
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: null,
    userId: "test-user-123",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "UTC",
    prompt: "Summarize yesterday's threads",
    description: null,
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    chatThreadId: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

export function setMockSchedules(schedules: ScheduleResponse[]): void {
  mockSchedules = schedules;
}

export function resetMockSchedules(): void {
  mockSchedules = [];
}

export const apiSchedulesHandlers = [
  // GET /api/zero/schedules
  mockApi(zeroSchedulesMainContract.list, ({ respond }) =>
    respond(200, { schedules: mockSchedules }),
  ),

  // POST /api/zero/schedules
  mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
    const now = new Date().toISOString();
    const schedule: ScheduleResponse = {
      id: crypto.randomUUID(),
      agentId: body.agentId,
      displayName: null,
      userId: "test-user-123",
      name: body.name,
      triggerType: body.cronExpression ? "cron" : body.atTime ? "once" : "loop",
      cronExpression: body.cronExpression ?? null,
      atTime: body.atTime ?? null,
      intervalSeconds: body.intervalSeconds ?? null,
      timezone: body.timezone ?? "UTC",
      prompt: body.prompt,
      description: body.description ?? null,
      appendSystemPrompt: body.appendSystemPrompt ?? null,
      vars: null,
      secretNames: null,
      volumeVersions: body.volumeVersions ?? null,
      enabled: body.enabled ?? true,
      nextRunAt: null,
      lastRunAt: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
      chatThreadId: body.chatThreadId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const existing = mockSchedules.find((s) => s.name === body.name);
    if (existing) {
      mockSchedules = mockSchedules.map((s) =>
        s.name === body.name ? schedule : s,
      );
      return respond(200, { schedule, created: false });
    }
    mockSchedules = [...mockSchedules, schedule];
    return respond(201, { schedule, created: true });
  }),

  // DELETE /api/zero/schedules/:name
  mockApi(zeroSchedulesByNameContract.delete, ({ params, respond }) => {
    mockSchedules = mockSchedules.filter((s) => s.name !== params.name);
    return respond(204);
  }),

  // POST /api/zero/schedules/:name/enable
  mockApi(zeroSchedulesEnableContract.enable, ({ params, respond }) => {
    const schedule = mockSchedules.find((s) => s.name === params.name);
    if (!schedule) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...schedule, enabled: true };
    mockSchedules = mockSchedules.map((s) =>
      s.name === params.name ? updated : s,
    );
    return respond(200, updated);
  }),

  // POST /api/zero/schedules/:name/disable
  mockApi(zeroSchedulesEnableContract.disable, ({ params, respond }) => {
    const schedule = mockSchedules.find((s) => s.name === params.name);
    if (!schedule) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...schedule, enabled: false };
    mockSchedules = mockSchedules.map((s) =>
      s.name === params.name ? updated : s,
    );
    return respond(200, updated);
  }),

  // POST /api/zero/schedules/run
  mockApi(zeroScheduleRunContract.run, ({ respond }) =>
    respond(201, { runId: crypto.randomUUID() }),
  ),
];
