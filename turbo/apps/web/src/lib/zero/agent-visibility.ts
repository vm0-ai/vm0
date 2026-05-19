import { eq, isNull, or } from "drizzle-orm";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { ZeroAgentVisibility } from "@vm0/db/schema/zero-agent";

export function isPrivateAgent(agent: {
  visibility: ZeroAgentVisibility | null | undefined;
}): boolean {
  return agent.visibility === "private";
}

export function visibleJoinedZeroAgentCondition(userId: string) {
  return or(
    isNull(zeroAgents.id),
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, userId),
  );
}
