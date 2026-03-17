import { eq } from "drizzle-orm";
import { agentComposes } from "../../db/schema/agent-compose";
import { resolveCallerOrgId } from "./resolve-org";

/**
 * Verify that the given agent compose belongs to the caller's active org.
 * Returns true if the compose exists and belongs to the caller's org.
 */
export async function verifyComposeOrgAccess(
  composeId: string,
  userId: string,
  requestUrl: string,
): Promise<boolean> {
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) {
    return false;
  }

  const callerOrgId = await resolveCallerOrgId(userId, new Request(requestUrl));
  return callerOrgId === compose.orgId;
}
