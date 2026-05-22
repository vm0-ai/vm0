import { eq, isNull, or } from "drizzle-orm";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

export function visibleJoinedZeroAgentCondition(userId: string) {
  return or(
    isNull(zeroAgents.id),
    eq(zeroAgents.visibility, "public"),
    eq(zeroAgents.owner, userId),
  );
}
