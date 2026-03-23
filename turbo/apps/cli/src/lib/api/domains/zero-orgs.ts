import { initClient } from "@ts-rest/core";
import {
  zeroOrgContract,
  zeroOrgListContract,
  zeroOrgMembersContract,
  zeroOrgInviteContract,
  zeroOrgLeaveContract,
  zeroOrgDeleteContract,
  type OrgResponse,
  type OrgMembersResponse,
  type OrgListResponse,
} from "@vm0/core";
import {
  getClientConfig,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getToken } from "../config";

/**
 * Get client config that always uses the user token (vm0_live_),
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
export async function inviteZeroOrgMember(email: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(zeroOrgInviteContract, config);

  const result = await client.invite({
    body: { email },
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
