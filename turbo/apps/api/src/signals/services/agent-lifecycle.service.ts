import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { removeAgentInstructionsStorageInTransaction } from "./agent-instructions-storage-transaction.service";
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";

export const AGENT_LIFECYCLE_LOCK_TIMEOUT = "100ms";

export async function deleteClerkAgentLifecycleData(
  db: NodePgDatabase,
  scope:
    | { readonly kind: "organization"; readonly orgId: string }
    | { readonly kind: "user"; readonly userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
    const ownedAgents = await tx
      .select({ id: agents.id, name: agents.name, orgId: agents.orgId })
      .from(agents)
      .where(
        scope.kind === "organization"
          ? eq(agents.orgId, scope.orgId)
          : eq(agents.owner, scope.userId),
      )
      .orderBy(asc(agents.id));

    for (const agent of ownedAgents) {
      await lockCanonicalAgentMutation(tx, agent.id);
    }

    if (scope.kind === "organization") {
      await tx.delete(agentRuns).where(eq(agentRuns.orgId, scope.orgId));
      if (ownedAgents.length === 0) {
        return;
      }
      const agentIds = ownedAgents.map((agent) => {
        return agent.id;
      });
      await tx
        .delete(agents)
        .where(
          and(eq(agents.orgId, scope.orgId), inArray(agents.id, agentIds)),
        );
      return;
    }
    await tx.delete(agentRuns).where(eq(agentRuns.userId, scope.userId));
    if (ownedAgents.length === 0) {
      return;
    }
    const agentIds = ownedAgents.map((agent) => {
      return agent.id;
    });
    for (const agent of ownedAgents) {
      await removeAgentInstructionsStorageInTransaction(tx, {
        orgId: agent.orgId,
        agentName: agent.name,
      });
    }
    await tx
      .delete(agents)
      .where(and(eq(agents.owner, scope.userId), inArray(agents.id, agentIds)));
  });
}
