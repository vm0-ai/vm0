import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";

/**
 * Read the headVersionId and updatedAt of a compose record.
 * Useful for verifying recompose behavior in tests.
 */
export async function getComposeHeadVersion(
  composeId: string,
): Promise<
  { headVersionId: string | null; updatedAt: Date | null } | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      headVersionId: agentComposes.headVersionId,
      updatedAt: agentComposes.updatedAt,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row;
}

/**
 * Read the head compose version content for a compose record.
 * Returns the resolved compose content stored in the version.
 */
export async function getTestComposeVersionContent(
  composeId: string,
): Promise<Record<string, unknown> | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return (row?.content as Record<string, unknown>) ?? null;
}

/**
 * Get the zero_agents UUID by org + agent name.
 */
export async function getTestZeroAgentId(
  orgId: string,
  name: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, name)))
    .limit(1);
  if (!row) {
    throw new Error(`Zero agent not found: org=${orgId} name=${name}`);
  }
  return row.id;
}

/**
 * Read a zero_agents row by org + agent name.
 */
export async function getTestZeroAgent(
  orgId: string,
  name: string,
): Promise<
  | {
      displayName: string | null;
      description: string | null;
      sound: string | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, name)))
    .limit(1);
  return row;
}
