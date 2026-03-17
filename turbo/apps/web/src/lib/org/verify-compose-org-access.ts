import { eq } from "drizzle-orm";
import { agentComposes } from "../../db/schema/agent-compose";
import { resolveOrg } from "./resolve-org";
import { isNotFound, isForbidden } from "../errors";

/**
 * Verify that a compose belongs to the caller's active organization.
 *
 * Returns true if the compose exists and belongs to the resolved org.
 * Returns false if the compose does not exist or belongs to a different org.
 * Throws on unexpected errors (DB failures, timeouts).
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

  const orgSlug = new URL(requestUrl).searchParams.get("org");
  try {
    const { org } = await resolveOrg(userId, orgSlug);
    return compose.orgId === org.orgId;
  } catch (error) {
    if (isNotFound(error) || isForbidden(error)) {
      return false;
    }
    throw error;
  }
}
