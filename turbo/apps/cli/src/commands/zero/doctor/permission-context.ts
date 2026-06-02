import { getZeroOrg } from "../../../lib/api/domains/zero-orgs";
import { getZeroAgent } from "../../../lib/api/domains/zero-agents";
import { decodeZeroTokenPayload } from "../../../lib/api/zero-token";
import { decodeCliTokenPayload } from "../../../lib/api/cli-token";
import { getToken } from "../../../lib/api/config";
import type { OrgResponse } from "@vm0/api-contracts/contracts/orgs";

type AgentRole = "admin" | "owner" | "member" | "unknown";
type PermissionGrantMode = NonNullable<OrgResponse["permissionGrantMode"]>;

interface PermissionChangeContext {
  readonly role: AgentRole;
  readonly permissionGrantMode: PermissionGrantMode;
}

const LEGACY_PERMISSION_GRANT_MODE: PermissionGrantMode = "legacy";

function roleFromOrg(org: OrgResponse): AgentRole {
  if (org.role === "admin") return "admin";
  if (org.role === "member") return "member";
  return "unknown";
}

function permissionGrantModeFromOrg(org: OrgResponse): PermissionGrantMode {
  return org.permissionGrantMode ?? LEGACY_PERMISSION_GRANT_MODE;
}

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

export async function resolvePermissionGrantMode(): Promise<PermissionGrantMode> {
  try {
    const org = await getZeroOrg();
    return permissionGrantModeFromOrg(org);
  } catch {
    return LEGACY_PERMISSION_GRANT_MODE;
  }
}

export async function resolvePermissionChangeContext(
  agentId: string | undefined,
): Promise<PermissionChangeContext> {
  try {
    const org = await getZeroOrg();
    const permissionGrantMode = permissionGrantModeFromOrg(org);

    if (!agentId || permissionGrantMode === "user-grants") {
      return {
        role: roleFromOrg(org),
        permissionGrantMode,
      };
    }

    if (org.role === "admin") {
      return { role: "admin", permissionGrantMode };
    }

    if (org.role === "member") {
      const userId = await resolveUserId();
      if (userId) {
        const agent = await getZeroAgent(agentId);
        if (agent.ownerId === userId) {
          return { role: "owner", permissionGrantMode };
        }
      }
      return { role: "member", permissionGrantMode };
    }

    return { role: "unknown", permissionGrantMode };
  } catch {
    return {
      role: "unknown",
      permissionGrantMode: LEGACY_PERMISSION_GRANT_MODE,
    };
  }
}
