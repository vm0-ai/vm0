import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { zeroAgentSchedules } from "../../db/schema/zero-agent-schedule";

// ============================================================================
// Schedule Seeders
// ============================================================================

/**
 * Update internal schedule state for testing edge cases.
 *
 * @why-db-direct Sets internal scheduling fields (consecutiveFailures, enabled,
 * nextRunAt, lastRunId, intervalSeconds) that are managed by the scheduler
 * callback system, not exposed via any user-facing API.
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
  initServices();
  await globalThis.services.db
    .update(zeroAgentSchedules)
    .set(state)
    .where(eq(zeroAgentSchedules.id, scheduleId));
}

/**
 * Disable enabled schedules for a specific org.
 * Prevents stale schedules from other test files consuming the limit(10)
 * batch in executeDueSchedules, which can cause test flakiness.
 *
 * Scoped to orgId so dev-server schedules are not affected.
 *
 * @why-db-direct Bulk disable for test cleanup; no API exists for org-wide
 * schedule disable.
 */
export async function disableAllSchedules(orgId: string): Promise<void> {
  initServices();
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
 *
 * @why-db-direct Sets internal failure counter to test threshold-based
 * disabling; the scheduler manages this field internally via callbacks.
 */
export async function setScheduleConsecutiveFailures(
  composeId: string,
  name: string,
  failures: number,
): Promise<void> {
  initServices();
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
