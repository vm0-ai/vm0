/**
 * Older APIs allowed the workspace default to become private or be deleted.
 * Current APIs reject both. These explicit persisted-state fixtures retain
 * integration access checks and missing-default recovery coverage for old data.
 */
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../lib/db";

function referencedDefault(agentId: string) {
  return and(
    eq(agents.id, agentId),
    inArray(
      agents.id,
      db().select({ id: orgMetadata.defaultAgentId }).from(orgMetadata),
    ),
  );
}

export async function seedLegacyMissingDefaultAgentFixture(
  agentId: string,
): Promise<void> {
  const rows = await db()
    .delete(agents)
    .where(referencedDefault(agentId))
    .returning({ id: agents.id });
  if (rows.length !== 1) {
    throw new Error("Expected one referenced default agent fixture");
  }
}

export async function seedLegacyPrivateDefaultAgentFixture(
  agentId: string,
): Promise<void> {
  const rows = await db()
    .update(agents)
    .set({ visibility: "private" })
    .where(referencedDefault(agentId))
    .returning({ id: agents.id });
  if (rows.length !== 1) {
    throw new Error("Expected one referenced default agent fixture");
  }
}
