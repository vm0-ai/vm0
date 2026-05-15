import { and, count, eq, isNull, or } from "drizzle-orm";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { ZeroAgentVisibility } from "@vm0/db/schema/zero-agent";
import type { Database } from "../../types/global";

export const PUBLIC_AGENT_LIMIT = 7;

export function isPrivateAgent(agent: {
  visibility: ZeroAgentVisibility | null | undefined;
}): boolean {
  return agent.visibility === "private";
}

export function visibleZeroAgentCondition(userId: string) {
  return or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId));
}

export function visibleJoinedZeroAgentCondition(userId: string) {
  return or(
    isNull(zeroAgents.id),
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, userId),
  );
}

export async function countPublicAgents(
  orgId: string,
  db: Database = globalThis.services.db,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.visibility, "public")),
    );
  return row?.value ?? 0;
}
