import { agents, type AgentVisibility } from "@okouai/db/schema/agent";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

interface CanonicalAgentAuthorityOverride {
  readonly owner: string;
  readonly displayName: string;
  readonly visibility: AgentVisibility;
  readonly updatedAt: Date;
}

export async function readCanonicalAgentNameFixture(
  agentId: string,
): Promise<string> {
  const [agent] = await db()
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) {
    throw new Error("Expected a canonical Agent fixture");
  }
  return agent.name;
}

export async function overrideCanonicalAgentAuthorityFixture(args: {
  readonly agentId: string;
  readonly override: CanonicalAgentAuthorityOverride;
  readonly signal: AbortSignal;
}): Promise<void> {
  const updated = await db()
    .update(agents)
    .set(args.override)
    .where(eq(agents.id, args.agentId))
    .returning({ id: agents.id });
  args.signal.throwIfAborted();
  if (updated.length !== 1) {
    throw new Error("Expected one canonical Agent authority fixture row");
  }
}
