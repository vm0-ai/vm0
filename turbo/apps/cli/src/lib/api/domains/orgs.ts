import { initClient } from "@ts-rest/core";
import {
  orgContract,
  orgMembersContract,
  orgListContract,
  type OrgMembersResponse,
  type OrgListResponse,
} from "@vm0/core";
import {
  getClientConfig,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getToken } from "../config";
import type { OrgResponse } from "../core/types";

/**
 * Get client config that always uses the user token (vm0_live_),
 * not the org token. Used for org list/create operations.
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
 * Get current user's default organization
 */
export async function getOrg(): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization");
}

/**
 * Update user's default organization slug
 */
export async function updateOrg(body: {
  slug: string;
  force?: boolean;
}): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.update({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update organization");
}

/**
 * Get organization members and status
 */
export async function getOrgMembers(): Promise<OrgMembersResponse> {
  const config = await getClientConfig();
  const client = initClient(orgMembersContract, config);

  const result = await client.members({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization members");
}

/**
 * Invite a member to the organization
 */
export async function inviteOrgMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgMembersContract, config);

  const result = await client.invite({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to invite member");
}

/**
 * Remove a member from the organization
 */
export async function removeOrgMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgMembersContract, config);

  const result = await client.removeMember({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to remove member");
}

/**
 * Leave the current organization
 */
export async function leaveOrg(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgMembersContract, config);

  const result = await client.leave({
    body: {},
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to leave organization");
}

/**
 * List all accessible organizations (always uses user token)
 */
export async function listOrgs(): Promise<OrgListResponse> {
  const config = await getUserTokenClientConfig();
  const client = initClient(orgListContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list organizations");
}
