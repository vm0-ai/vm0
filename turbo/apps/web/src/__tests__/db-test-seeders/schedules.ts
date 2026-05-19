import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
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

/**
 * Resolve composeId to agentId for test helpers.
 * Looks up the compose to get org/name, then finds the corresponding zero agent.
 *
 * @why-db-direct Resolves compose → zero_agent mapping; no API endpoint
 * provides composeId→agentId resolution
 */
export async function resolveAgentIdFromCompose(
  composeId: string,
): Promise<string> {
  initServices();
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
