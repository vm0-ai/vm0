import { initClient } from "@ts-rest/core";
import {
  orgContract,
  scopeListContract,
  scopeUseContract,
  type OrgStatusResponse,
  type ScopeListResponse,
  type ScopeUseResponse,
} from "@vm0/core";
import {
  getClientConfig,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getToken } from "../config";

/**
 * Get client config that always uses the user token (vm0_live_),
 * not the org token. Used for scope list/use operations.
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
 * Create a new organization
 */
export async function createOrg(slug: string): Promise<OrgStatusResponse> {
  const config = await getUserTokenClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.create({
    body: { slug },
  });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create organization");
}

/**
 * Get organization status and members (requires org access token)
 */
export async function getOrgStatus(): Promise<OrgStatusResponse> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.status({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization status");
}

/**
 * Invite a member to the organization (requires org access token)
 */
export async function inviteMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.invite({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to invite member");
}

/**
 * Remove a member from the organization (requires org access token)
 */
export async function removeMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.removeMember({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to remove member");
}

/**
 * Leave the current organization (requires org access token)
 */
export async function leaveOrg(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.leave({
    body: {},
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to leave organization");
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

/**
 * Switch to a different scope (always uses user token)
 */
export async function useScope(slug: string): Promise<ScopeUseResponse> {
  const config = await getUserTokenClientConfig();
  const client = initClient(scopeUseContract, config);

  const result = await client.use({
    body: { slug },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to switch scope");
}
