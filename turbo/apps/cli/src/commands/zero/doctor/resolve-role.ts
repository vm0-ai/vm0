import { getZeroOrg } from "../../../lib/api/domains/zero-orgs";
import { getZeroAgent } from "../../../lib/api/domains/zero-agents";
import { decodeZeroTokenPayload } from "../../../lib/api/zero-token";
import { decodeCliTokenPayload } from "../../../lib/api/cli-token";
import { getToken } from "../../../lib/api/config";

type AgentRole = "admin" | "owner" | "member" | "unknown";

/**
 * Resolve the current user's userId from the available token.
 * Tries ZERO_TOKEN (sandbox) first, then CLI token.
 */
async function resolveUserId(): Promise<string | undefined> {
  const zeroPayload = decodeZeroTokenPayload();
  if (zeroPayload?.userId) return zeroPayload.userId;

  const token = await getToken();
  const cliPayload = decodeCliTokenPayload(token);
  return cliPayload?.userId;
}

/**
 * Best-effort role detection that also considers agent ownership.
 *
 * Returns "admin" if the user is an org admin (can manage any agent).
 * Returns "owner" if the user is a non-admin but owns the specified agent.
 * Returns "member" if the user is a non-admin, non-owner member.
 * Returns "unknown" on any API failure.
 */
export async function resolveAgentRole(agentId: string): Promise<AgentRole> {
  try {
    const org = await getZeroOrg();
    if (org.role === "admin") return "admin";

    if (org.role === "member") {
      // Check if the member owns this agent
      const userId = await resolveUserId();
      if (userId) {
        const agent = await getZeroAgent(agentId);
        if (agent.ownerId === userId) return "owner";
      }
      return "member";
    }

    return "unknown";
  } catch (error: unknown) {
    console.debug("resolveAgentRole failed, falling back to unknown:", error);
    return "unknown";
  }
}
