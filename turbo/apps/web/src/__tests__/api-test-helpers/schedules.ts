import type { ScheduleResponse } from "../../lib/zero/schedule/schedule-service";
import {
  deleteSchedule,
  deploySchedule,
  disableSchedule,
  enableSchedule,
  getScheduleByName,
  getScheduleRecentRuns,
} from "../../lib/zero/schedule";
import { getTestAuthContext } from "./core";
import {
  resolveAgentIdFromCompose,
  seedTestSchedule,
} from "../db-test-seeders/schedules";

export { seedTestSchedule };

/**
 * Create a test schedule via the schedule service.
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
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);

  // Default to cron if no trigger specified.
  const hasTrigger =
    options?.cronExpression ||
    options?.atTime ||
    options?.intervalSeconds !== undefined;

  const result = await deploySchedule(userId, orgId, {
    name,
    agentId,
    timezone: options?.timezone ?? "UTC",
    prompt: options?.prompt ?? "Test schedule prompt",
    cronExpression: hasTrigger ? options?.cronExpression : "0 0 * * *",
    atTime: options?.atTime,
    intervalSeconds: options?.intervalSeconds,
    description: options?.description,
    appendSystemPrompt: options?.appendSystemPrompt,
  });

  return result.schedule;
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
 * Delete a test schedule via the schedule service.
 *
 * @param composeId - The compose ID
 * @param name - The schedule name
 */
export async function deleteTestSchedule(
  composeId: string,
  name: string,
): Promise<void> {
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);

  await deleteSchedule(userId, orgId, agentId, name);
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
