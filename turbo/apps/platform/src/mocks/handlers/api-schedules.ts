import {
  zeroSchedulesMainContract,
  zeroSchedulesByNameContract,
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/api-contracts/contracts/zero-schedules";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";
import {
  getMockSchedules,
  setMockSchedules as setStore,
} from "./schedules-store.ts";

const DEFAULT_CHAT_THREAD_ID = "d0000000-0000-4000-a000-000000000001";

interface MockScheduleDeployBody {
  agentId: string;
  name: string;
  cronExpression?: string | null;
  atTime?: string | null;
  intervalSeconds?: number | null;
  timezone?: string | null;
  prompt: string;
  description?: string | null;
  appendSystemPrompt?: string | null;
  enabled?: boolean;
  chatThreadId?: string | null;
}

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
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    chatThreadId: DEFAULT_CHAT_THREAD_ID,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

function getMockScheduleTriggerType(
  body: MockScheduleDeployBody,
): ScheduleResponse["triggerType"] {
  if (body.cronExpression) {
    return "cron";
  }
  if (body.atTime) {
    return "once";
  }
  return "loop";
}

// Shared with the automations mock handlers: an automation row IS a schedule
// row, so upserts on either surface must preserve the stored identity fields
// (id, chatThreadId, createdAt) the same way the production service does.
export function createStoredSchedule(
  body: MockScheduleDeployBody,
  existing: ScheduleResponse | undefined,
  now: string,
): ScheduleResponse {
  return {
    id: existing?.id ?? crypto.randomUUID(),
    agentId: body.agentId,
    displayName: existing?.displayName ?? null,
    userId: existing?.userId ?? "test-user-123",
    name: body.name,
    triggerType: getMockScheduleTriggerType(body),
    cronExpression: body.cronExpression ?? null,
    atTime: body.atTime ?? null,
    intervalSeconds: body.intervalSeconds ?? null,
    timezone: body.timezone ?? "UTC",
    prompt: body.prompt,
    description: body.description ?? null,
    appendSystemPrompt: body.appendSystemPrompt ?? null,
    enabled: body.enabled ?? true,
    nextRunAt: null,
    lastRunAt: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    chatThreadId:
      body.chatThreadId ?? existing?.chatThreadId ?? crypto.randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export { resetMockSchedules } from "./schedules-store.ts";

export const apiSchedulesHandlers = [
  // GET /api/zero/schedules
  mockApi(zeroSchedulesMainContract.list, ({ respond }) =>
    respond(200, { schedules: getMockSchedules() }),
  ),

  // POST /api/zero/schedules
  mockApi(zeroSchedulesMainContract.deploy, ({ body, respond }) => {
    const now = nowDate().toISOString();
    const schedules = getMockSchedules();
    const existing = schedules.find((s) => s.name === body.name);
    const schedule = createStoredSchedule(body, existing, now);
    if (existing) {
      setStore(schedules.map((s) => (s.name === body.name ? schedule : s)));
      return respond(200, { schedule, created: false });
    }
    setStore([...schedules, schedule]);
    return respond(201, { schedule, created: true });
  }),

  // DELETE /api/zero/schedules/:name
  mockApi(zeroSchedulesByNameContract.delete, ({ params, respond }) => {
    setStore(getMockSchedules().filter((s) => s.name !== params.name));
    return respond(204);
  }),

  // POST /api/zero/schedules/:name/enable
  mockApi(zeroSchedulesEnableContract.enable, ({ params, respond }) => {
    const schedule = getMockSchedules().find((s) => s.name === params.name);
    if (!schedule) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...schedule, enabled: true };
    setStore(
      getMockSchedules().map((s) => (s.name === params.name ? updated : s)),
    );
    return respond(200, updated);
  }),

  // POST /api/zero/schedules/:name/disable
  mockApi(zeroSchedulesEnableContract.disable, ({ params, respond }) => {
    const schedule = getMockSchedules().find((s) => s.name === params.name);
    if (!schedule) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    const updated = { ...schedule, enabled: false };
    setStore(
      getMockSchedules().map((s) => (s.name === params.name ? updated : s)),
    );
    return respond(200, updated);
  }),

  // POST /api/zero/schedules/run
  mockApi(zeroScheduleRunContract.run, ({ respond }) =>
    respond(201, { runId: crypto.randomUUID() }),
  ),
];
