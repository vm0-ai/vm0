import type { ScheduleResponse } from "../../lib/zero/schedule/schedule-service";
import {
  disableSchedule,
  enableSchedule,
  getScheduleByName,
  getScheduleRecentRuns,
} from "../../lib/zero/schedule";
import { POST as deployScheduleRoute } from "../../../app/api/zero/schedules/route";
import { DELETE as deleteScheduleRoute } from "../../../app/api/zero/schedules/[name]/route";
import { createTestRequest, getTestAuthContext } from "./core";
import {
  resolveAgentIdFromCompose,
  seedTestSchedule,
} from "../db-test-seeders/schedules";

export { seedTestSchedule };

/**
 * Create a test schedule via the schedule API route.
 * Note: vars and secrets are now managed via server-side tables (vm0 secret set, vm0 var set)
 */
export async function createTestSchedule(
  composeId: string,
  name: string,
  options?: {
    cronExpression?: string;
    atTime?: string;
    intervalSeconds?: number;
    timezone?: string;
    prompt?: string;
    description?: string;
    appendSystemPrompt?: string;
  },
): Promise<ScheduleResponse> {
  const agentId = await resolveAgentIdFromCompose(composeId);

  // Default to cron if no trigger specified
  const hasTrigger =
    options?.cronExpression ||
    options?.atTime ||
    options?.intervalSeconds !== undefined;

  const request = createTestRequest(
    "http://localhost:3000/api/zero/schedules",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        agentId,
        timezone: options?.timezone ?? "UTC",
        prompt: options?.prompt ?? "Test schedule prompt",
        cronExpression: hasTrigger ? options?.cronExpression : "0 0 * * *",
        atTime: options?.atTime,
        intervalSeconds: options?.intervalSeconds,
        description: options?.description,
        appendSystemPrompt: options?.appendSystemPrompt,
      }),
    },
  );

  const response = await deployScheduleRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create schedule: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.schedule;
}

/**
 * Get a test schedule by name via the schedule service.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @returns The schedule response
 */
export async function getTestSchedule(
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);
  return getScheduleByName(userId, orgId, agentId, name);
}

/**
 * Enable a test schedule via the schedule service.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @returns The updated schedule response
 */
export async function enableTestSchedule(
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);

  return enableSchedule(userId, orgId, agentId, name);
}

/**
 * Disable a test schedule via the schedule service.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @returns The updated schedule response
 */
export async function disableTestSchedule(
  composeId: string,
  name: string,
): Promise<ScheduleResponse> {
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);

  return disableSchedule(userId, orgId, agentId, name);
}

/**
 * Delete a test schedule via the delete API route.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 */
export async function deleteTestSchedule(
  composeId: string,
  name: string,
): Promise<void> {
  const agentId = await resolveAgentIdFromCompose(composeId);

  const request = createTestRequest(
    `http://localhost:3000/api/zero/schedules/${name}?agentId=${agentId}`,
    {
      method: "DELETE",
    },
  );

  const response = await deleteScheduleRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to delete schedule: ${error.error?.message || response.status}`,
    );
  }
}

/**
 * Get runs for a test schedule via the schedule service.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 * @param limit - Optional limit (default 5, max 100)
 * @returns Object with runs array
 */
export async function getTestScheduleRuns(
  composeId: string,
  name: string,
  limit?: number,
): Promise<{
  runs: Array<{
    id: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    error: string | null;
  }>;
}> {
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);
  const runs = await getScheduleRecentRuns(
    userId,
    orgId,
    agentId,
    name,
    limit ?? 5,
  );
  return { runs };
}
