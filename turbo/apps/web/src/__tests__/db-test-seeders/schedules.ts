import { initServices } from "../../lib/init-services";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { uniqueId } from "../test-helpers";

// ============================================================================
// Schedule Seeders
// ============================================================================

/**
 * Seed a schedule record directly in the database.
 *
 * @why-db-direct Creates schedules directly for bulk testing (e.g. top-100
 * truncation tests). The API creates one schedule at a time and would be
 * impractical for seeding large numbers of schedules.
 *
 * @returns The schedule ID
 */
export async function seedTestSchedule(params: {
  agentId: string;
  userId: string;
  orgId: string;
  name?: string;
  description?: string;
}): Promise<string> {
  initServices();
  const [sched] = await globalThis.services.db
    .insert(zeroAgentSchedules)
    .values({
      agentId: params.agentId,
      userId: params.userId,
      orgId: params.orgId,
      name: params.name ?? uniqueId("sched"),
      description: params.description,
      cronExpression: "0 0 * * *",
      prompt: "test",
    })
    .returning({ id: zeroAgentSchedules.id });
  return sched!.id;
}
