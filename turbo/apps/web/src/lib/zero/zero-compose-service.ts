import { eq, and, desc } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { notFound } from "../shared/errors";
import { canAccessCompose } from "../infra/agent/compose-access";
import type { ComposeListItem } from "@vm0/api-contracts/contracts/composes";

/**
 * Resolve zero_agents.id by org + compose name.
 * Returns null if no matching agent exists.
 */
export async function resolveAgentId(
  orgId: string,
  composeName: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, composeName)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Update compose metadata (displayName, description, sound).
 * Verifies compose exists and caller has access.
 *
 * Throws notFound if compose doesn't exist or caller lacks access.
 */
export async function updateComposeMetadata(
  composeId: string,
  userId: string,
  orgId: string,
  body: {
    displayName?: string | null;
    description?: string | null;
    sound?: string | null;
  },
): Promise<void> {
  const db = globalThis.services.db;

  const [compose] = await db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      orgId: agentComposes.orgId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose || !canAccessCompose(userId, orgId, compose)) {
    throw notFound("Agent compose not found");
  }

  await db
    .insert(zeroAgents)
    .values({
      id: compose.id,
      orgId: compose.orgId,
      owner: compose.userId,
      name: compose.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      sound: body.sound ?? null,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        ...(body.displayName !== undefined && {
          displayName: body.displayName,
        }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.sound !== undefined && { sound: body.sound }),
        updatedAt: new Date(),
      },
    });
}

/**
 * List all composes for an org with metadata from zero_agents.
 */
export async function listComposes(
  orgId: string,
): Promise<{ composes: ComposeListItem[] }> {
  const ownComposes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      updatedAt: agentComposes.updatedAt,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.orgId, orgId))
    .orderBy(desc(agentComposes.updatedAt));

  const composes = ownComposes.map((c) => {
    return {
      id: c.id,
      name: c.name,
      displayName: c.displayName ?? null,
      description: c.description ?? null,
      sound: c.sound ?? null,
      headVersionId: c.headVersionId,
      updatedAt: c.updatedAt.toISOString(),
    };
  });

  return { composes };
}
