import { initClient } from "@ts-rest/core";
import {
  scopeMemberContract,
  scopeListContract,
  type ScopeMembersResponse,
  type ScopeListResponse,
} from "@vm0/core";
import {
  getClientConfig,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getToken } from "../config";

/**
 * Get client config that always uses the user token (vm0_live_),
 * not the scope token. Used for scope list/use operations.
 */
async function getUserTokenClientConfig(): Promise<{
  baseUrl: string;
  baseHeaders: Record<string, string>;
  jsonQuery: false;
}> {
  const baseUrl = await getBaseUrl();
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Run: vm0 auth login");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return { baseUrl, baseHeaders: headers, jsonQuery: false };
}

/**
 * Get scope members and status (requires scope access token)
 */
export async function getScopeMembers(): Promise<ScopeMembersResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeMemberContract, config);

  const result = await client.getMembers({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get scope members");
}

/**
 * Invite a member to the scope (requires scope access token)
 */
export async function inviteMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(scopeMemberContract, config);

  const result = await client.invite({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to invite member");
}

/**
 * Remove a member from the scope (requires scope access token)
 */
export async function removeMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(scopeMemberContract, config);

  const result = await client.removeMember({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to remove member");
}

/**
 * Leave the current scope (requires scope access token)
 */
export async function leaveScope(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(scopeMemberContract, config);

  const result = await client.leave({
    body: {},
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to leave scope");
}

/**
 * List all accessible scopes (always uses user token)
 */
export async function listScopes(): Promise<ScopeListResponse> {
  const config = await getUserTokenClientConfig();
  const client = initClient(scopeListContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list scopes");
}
