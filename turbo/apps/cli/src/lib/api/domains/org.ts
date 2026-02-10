import { initClient } from "@ts-rest/core";
import {
  orgContract,
  scopeListContract,
  type OrgStatus,
  type ScopeListItem as CoreScopeListItem,
  type InviteLinkResponse as CoreInviteLinkResponse,
  type ScopeResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

/**
 * Re-export types from core with CLI-friendly names
 */
export type OrgStatusResponse = OrgStatus;
export type ScopeListItem = CoreScopeListItem;
export type InviteLinkResponse = CoreInviteLinkResponse;
export type OrgResponse = ScopeResponse;

/**
 * Create a new organization
 */
export async function createOrg(body: { slug: string }): Promise<OrgResponse> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create organization");
}

/**
 * Get user's organization status (owned org + members)
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
 * Create an invite link for the organization
 */
export async function createInviteLink(): Promise<InviteLinkResponse> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.createInvite({ body: {} });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create invite link");
}

/**
 * Remove a member from the organization
 */
export async function removeOrgMember(userId: string): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.removeMember({ params: { userId } });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to remove member");
}

/**
 * Leave an organization
 */
export async function leaveOrg(): Promise<void> {
  const config = await getClientConfig();
  const client = initClient(orgContract, config);

  const result = await client.leave({ body: {} });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to leave organization");
}

/**
 * List all accessible scopes (personal + org memberships)
 */
export async function listScopes(): Promise<ScopeListItem[]> {
  const config = await getClientConfig();
  const client = initClient(scopeListContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body.scopes;
  }

  handleError(result, "Failed to list scopes");
}
