import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { zeroAgentSchedules } from "../../db/schema/zero-agent-schedule";
import { agentComposes } from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import type { ScheduleResponse } from "../../lib/zero/schedule/schedule-service";
import {
  deploySchedule,
  getScheduleByName,
  deleteSchedule,
  enableSchedule,
  disableSchedule,
  getScheduleRecentRuns,
} from "../../lib/zero/schedule";
import { getTestAuthContext } from "./core";

/**
 * Resolve composeId to agentId for test helpers.
 * Looks up the compose to get org/name, then finds the corresponding zero agent.
 */
async function resolveAgentIdFromCompose(composeId: string): Promise<string> {
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId, name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!compose) throw new Error(`Compose ${composeId} not found`);

  const [agent] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, compose.orgId),
        eq(zeroAgents.name, compose.name),
      ),
    )
    .limit(1);
  if (!agent) throw new Error(`Zero agent not found for compose ${composeId}`);

  return agent.id;
}

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
  initServices();
  const { userId, orgId } = await getTestAuthContext();
  const agentId = await resolveAgentIdFromCompose(composeId);

  // Default to cron if no trigger specified
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
  initServices();
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
  initServices();
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
  initServices();
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
  initServices();
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
  initServices();
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

/**
 * Update internal schedule state for testing edge cases.
 *
 * Direct DB write is required because the schedule API does not expose
 * an endpoint to set internal fields like consecutiveFailures or lastRunId —
 * these are managed by the callback system, not user actions.
 */
export async function updateTestScheduleState(
  scheduleId: string,
  state: {
    consecutiveFailures?: number;
    enabled?: boolean;
    nextRunAt?: Date | null;
    lastRunId?: string;
    intervalSeconds?: number;
  },
): Promise<void> {
  await globalThis.services.db
    .update(zeroAgentSchedules)
    .set(state)
    .where(eq(zeroAgentSchedules.id, scheduleId));
}

/**
 * Get internal schedule state by ID for verifying callback side-effects.
 *
 * Direct DB read is required because the schedule GET API requires
 * composeId + name, but callback tests only have the schedule ID from
 * the payload. Also exposes internal fields not in the API response.
 */
export async function findTestScheduleById(scheduleId: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId))
    .limit(1);
  return row;
}

/**
 * Disable enabled schedules for a specific org.
 * Prevents stale schedules from other test files consuming the limit(10)
 * batch in executeDueSchedules, which can cause test flakiness.
 *
 * Scoped to orgId so dev-server schedules are not affected.
 */
export async function disableAllSchedules(orgId: string): Promise<void> {
  await globalThis.services.db
    .update(zeroAgentSchedules)
    .set({ enabled: false })
    .where(
      and(
        eq(zeroAgentSchedules.enabled, true),
        eq(zeroAgentSchedules.orgId, orgId),
      ),
    );
}

/**
 * Set the consecutiveFailures count on a schedule.
 * Useful for testing auto-disable after N failures.
 */
export async function setScheduleConsecutiveFailures(
  composeId: string,
  name: string,
  failures: number,
): Promise<void> {
  await globalThis.services.db
    .update(zeroAgentSchedules)
    .set({ consecutiveFailures: failures })
    .where(
      and(
        eq(zeroAgentSchedules.agentId, composeId),
        eq(zeroAgentSchedules.name, name),
      ),
    );
}
