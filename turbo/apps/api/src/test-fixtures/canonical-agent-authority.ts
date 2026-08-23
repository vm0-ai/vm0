import { agents, type AgentVisibility } from "@okouai/db/schema/agent";
import { agentComposes } from "@okouai/db/schema/agent-compose";
import { zeroAgents } from "@okouai/db/schema/zero-agent";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

interface CanonicalAgentAuthorityOverride {
  readonly owner: string;
  readonly displayName: string;
  readonly visibility: AgentVisibility;
  readonly updatedAt: Date;
}

export async function overrideCanonicalAgentAuthorityFixture(args: {
  readonly agentId: string;
  readonly override: CanonicalAgentAuthorityOverride;
  readonly signal: AbortSignal;
}): Promise<{
  readonly legacyOwner: string;
  readonly legacyDisplayName: string | null;
  readonly legacyVisibility: AgentVisibility;
}> {
  const updated = await db()
    .update(agents)
    .set(args.override)
    .where(eq(agents.id, args.agentId))
    .returning({ id: agents.id });
  args.signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Expected one canonical Agent authority fixture row");
  }

  const [legacy] = await db()
    .select({
      owner: agentComposes.userId,
      displayName: zeroAgents.displayName,
      visibility: zeroAgents.visibility,
    })
    .from(agentComposes)
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(eq(agentComposes.id, args.agentId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!legacy) {
    throw new Error("Expected one legacy Agent fixture row");
  }

  return {
    legacyOwner: legacy.owner,
    legacyDisplayName: legacy.displayName,
    legacyVisibility: legacy.visibility,
  };
}
