import { command, computed, state } from "ccstate";
import {
  zeroOrgMembersContract,
  type OrgMember,
  type OrgPendingInvitation,
} from "@vm0/core";
import { org$ } from "../org";
import { zeroClient$ } from "../api-client";

export type { OrgMember, OrgPendingInvitation };

const orgMembersVersion$ = state(0);

const orgMembersResponse$ = computed(async (get) => {
  get(orgMembersVersion$);
  const org = await get(org$);
  if (!org) {
    return null;
  }

  const createClient = get(zeroClient$);
  const client = createClient(zeroOrgMembersContract);
  const result = await client.members();

  if (result.status === 200) {
    return result.body;
  }

  return null;
});

export const orgMembers$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response?.members ?? [];
});

export const orgPendingInvitations$ = computed(async (get) => {
  const response = await get(orgMembersResponse$);
  return response?.pendingInvitations ?? [];
});

export const refreshOrgMembers$ = command(({ get, set }) => {
  set(orgMembersVersion$, get(orgMembersVersion$) + 1);
});
