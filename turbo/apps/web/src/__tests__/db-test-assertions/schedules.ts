import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { zeroAgentSchedules } from "../../db/schema/zero-agent-schedule";

// ============================================================================
// Schedule Assertions
// ============================================================================

/**
 * Get internal schedule state by ID for verifying callback side-effects.
 *
 * Direct DB read is required because the schedule GET API requires
 * composeId + name, but callback tests only have the schedule ID from
 * the payload. Also exposes internal fields not in the API response.
 */
export async function findTestScheduleById(scheduleId: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, scheduleId))
    .limit(1);
  return row;
}
