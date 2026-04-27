import { command, computed, state } from "ccstate";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import type {
  OrgMember,
  OrgPendingInvitation,
  OrgMembershipRequest,
} from "@vm0/api-contracts/contracts/org-members";
import { org$ } from "../org";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";

export type { OrgMember, OrgPendingInvitation, OrgMembershipRequest };

const orgMembersVersion$ = state(0);

const orgMembersResponse$ = computed(async (get) => {
  get(orgMembersVersion$);
  const org = await get(org$);
  if (!org) {
    return null;
  }

  const createClient = get(zeroClient$);
  const client = createClient(zeroOrgMembersContract);
  const result = await accept(client.members(), [200], { toast: false });
  return result.body;
});

export const orgMembers$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response?.members ?? [];
});

export const orgPendingInvitations$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response?.pendingInvitations ?? [];
});

export const orgMembershipRequests$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response?.membershipRequests ?? [];
});

export const refreshOrgMembers$ = command(({ get, set }) => {
  set(orgMembersVersion$, get(orgMembersVersion$) + 1);
});
