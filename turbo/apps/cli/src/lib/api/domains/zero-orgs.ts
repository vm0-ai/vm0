import { initClient } from "@ts-rest/core";
import {
  zeroOrgContract,
  zeroOrgLeaveContract,
  zeroOrgDeleteContract,
} from "@vm0/core/contracts/zero-org";
import { cliAuthOrgContract } from "@vm0/core/contracts/cli-auth";
import { zeroOrgListContract } from "@vm0/core/contracts/zero-org-list";
import {
  zeroOrgInviteContract,
  zeroOrgMembersContract,
} from "@vm0/core/contracts/zero-org-members";
import type { OrgMembersResponse } from "@vm0/core/contracts/org-members";
import type { OrgResponse } from "@vm0/core/contracts/orgs";
import type { OrgListResponse } from "@vm0/core/contracts/org-list";
import {
  ApiRequestError,
  getClientConfig,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getToken } from "../config";

/**
 * Get client config that always uses the user token,
 * not the org token. Used for org list operations.
 */
async function getUserTokenClientConfig(): Promise<{
  baseUrl: string;
  baseHeaders: Record<string, string>;
  jsonQuery: false;
}> {
  const baseUrl = await getBaseUrl();
  const token = await getToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
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
 * Get current org info via zero API
 */
export async function getZeroOrg(): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgContract, config);

  const result = await client.get({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization");
}

/**
 * Update org slug via zero API
 */
export async function updateZeroOrg(body: {
  slug: string;
  force?: boolean;
}): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgContract, config);

  const result = await client.update({ body });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to update organization");
}

/**
 * List all accessible orgs (always uses user token)
 */
export async function listZeroOrgs(): Promise<OrgListResponse> {
  const config = await getUserTokenClientConfig();
  const client = initClient(zeroOrgListContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list organizations");
}

/**
 * Get org members via zero API
 */
export async function getZeroOrgMembers(): Promise<OrgMembersResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgMembersContract, config);

  const result = await client.members({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get organization members");
}

/**
 * Invite a member to the org via zero API
 */
export async function inviteZeroOrgMember(
  email: string,
  role: "member" | "admin" = "member",
): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgInviteContract, config);

  const result = await client.invite({
    body: { email, role },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to invite member");
}

/**
 * Remove a member from the org via zero API
 */
export async function removeZeroOrgMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgMembersContract, config);

  const result = await client.removeMember({
    body: { email },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to remove member");
}

/**
 * Leave the current org via zero API
 */
export async function leaveZeroOrg(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgLeaveContract, config);

  const result = await client.leave({
    body: {},
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to leave organization");
}

/**
 * Delete the current org via zero API
 */
export async function deleteZeroOrg(slug: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgDeleteContract, config);

  const result = await client.delete({
    body: { slug },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to delete organization");
}

/**
 * Switch active organization and get a new CLI JWT token.
 * Uses the user's current token for auth (not org-scoped).
 */
export async function switchZeroOrg(
  slug: string,
): Promise<{ access_token: string }> {
  const config = await getUserTokenClientConfig();
  const client = initClient(cliAuthOrgContract, config);

  const result = await client.switchOrg({
    headers: {},
    body: { slug },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to switch organization");
}
