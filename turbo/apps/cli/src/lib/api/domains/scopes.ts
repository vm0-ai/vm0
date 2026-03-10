import { initClient } from "@ts-rest/core";
import {
  scopeContract,
  scopeMembersContract,
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
import type { ScopeResponse } from "../core/types";

/**
 * Get client config that always uses the user token (vm0_live_),
 * not the org token. Used for scope list/create operations.
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
 * Get current user's default scope
 */
export async function getScope(): Promise<ScopeResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get scope");
}

/**
 * Create user's default scope
 */
export async function createScope(body: {
  slug: string;
}): Promise<ScopeResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create scope");
}

/**
 * Update user's default scope slug
 */
export async function updateScope(body: {
  slug: string;
  force?: boolean;
}): Promise<ScopeResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeContract, config);

  const result = await client.update({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update scope");
}

/**
 * Get scope members and status
 */
export async function getScopeMembers(): Promise<ScopeMembersResponse> {
  const config = await getClientConfig();
  const client = initClient(scopeMembersContract, config);

  const result = await client.members({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get scope members");
}

/**
 * Invite a member to the scope
 */
export async function inviteScopeMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(scopeMembersContract, config);

  const result = await client.invite({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to invite member");
}

/**
 * Remove a member from the scope
 */
export async function removeScopeMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(scopeMembersContract, config);

  const result = await client.removeMember({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to remove member");
}

/**
 * Leave the current scope
 */
export async function leaveScope(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(scopeMembersContract, config);

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
