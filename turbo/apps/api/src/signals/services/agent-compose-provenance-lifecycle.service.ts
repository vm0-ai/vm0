import { agentComposes } from "@okouai/db/schema/agent-compose";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { pgBooleanDecoder } from "../../lib/db-structured-result";

export const AGENT_COMPOSE_LIFECYCLE_LOCK_TIMEOUT = "100ms";

export class AgentComposeProvenanceSchemaUnavailableError extends Error {
  constructor() {
    super("Agent Compose provenance retention schema is not available");
    this.name = "AgentComposeProvenanceSchemaUnavailableError";
  }
}

export function isAgentComposeProvenanceSchemaUnavailable(
  error: unknown,
): error is AgentComposeProvenanceSchemaUnavailableError {
  return error instanceof AgentComposeProvenanceSchemaUnavailableError;
}

export async function assertAgentComposeProvenanceSchemaAvailable(
  db: Pick<NodePgDatabase, "select">,
): Promise<void> {
  // DB/API rollout fallback: a staged incoming API can execute against 0930,
  // whose Compose FK still cascades. Fail closed until the exact 0931 nullable
  // columns and SET NULL FK are visible. Remove this probe with the lifecycle
  // call sites in Stage 8 of #26938, after the observed ~102-minute rollout
  // window, rollback drain, and failed deletion-event replay are complete.
  const [state] = await db
    .select({
      available: sql`
        (
          SELECT count(*) = 2
          FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('public.agent_compose_versions')
            AND attname IN ('compose_id', 'created_by')
            AND NOT attisdropped
            AND NOT attnotnull
        )
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_constraint
          WHERE conname =
            'agent_compose_versions_compose_id_agent_composes_id_fk'
            AND conrelid = to_regclass('public.agent_compose_versions')
            AND confrelid = to_regclass('public.agent_composes')
            AND contype = 'f'
            AND confdeltype = 'n'
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  if (!state?.available) {
    throw new AgentComposeProvenanceSchemaUnavailableError();
  }
}

export async function deleteClerkAgentLifecycleData(
  db: NodePgDatabase,
  scope:
    | { readonly kind: "organization"; readonly orgId: string }
    | { readonly kind: "user"; readonly userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${AGENT_COMPOSE_LIFECYCLE_LOCK_TIMEOUT}, true)`,
    );
    await assertAgentComposeProvenanceSchemaAvailable(tx);
    if (scope.kind === "organization") {
      await tx.delete(agentRuns).where(eq(agentRuns.orgId, scope.orgId));
      await tx
        .delete(agentComposes)
        .where(eq(agentComposes.orgId, scope.orgId));
      return;
    }
    await tx.delete(agentRuns).where(eq(agentRuns.userId, scope.userId));
    await tx
      .delete(agentComposes)
      .where(eq(agentComposes.userId, scope.userId));
  });
}
