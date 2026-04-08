import { command, computed, state } from "ccstate";
import {
  zeroOrgMembersContract,
  type OrgMember,
  type OrgPendingInvitation,
  type OrgMembershipRequest,
} from "@vm0/core";
import { org$ } from "../org";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";

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
  // eslint-disable-next-line no-restricted-syntax -- TODO(no-try): remove — use accept() error propagation
  try {
    const result = await accept(client.members(), [200], { toast: false });
    return result.body;
  } catch (error) {
    throwIfAbort(error);
    return null;
  }
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
