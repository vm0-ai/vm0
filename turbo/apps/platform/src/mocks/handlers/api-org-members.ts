import {
  zeroOrgMembersContract,
  zeroOrgInviteContract,
  zeroOrgMembershipRequestsContract,
} from "@vm0/api-contracts/contracts/zero-org-members";
import type { OrgMembersResponse } from "@vm0/api-contracts/contracts/org-members";
import { mockApi } from "../msw-contract.ts";

let mockOrgMembersResponse: OrgMembersResponse = {
  slug: "user-12345678",
  role: "admin",
  members: [],
  pendingInvitations: [],
  membershipRequests: [],
  createdAt: "2024-01-01T00:00:00Z",
};

export function setMockOrgMembers(
  overrides: Partial<OrgMembersResponse>,
): void {
  mockOrgMembersResponse = { ...mockOrgMembersResponse, ...overrides };
}

export function resetMockOrgMembers(): void {
  mockOrgMembersResponse = {
    slug: "user-12345678",
    role: "admin",
    members: [],
    pendingInvitations: [],
    membershipRequests: [],
    createdAt: "2024-01-01T00:00:00Z",
  };
}

export const apiOrgMembersHandlers = [
  mockApi(zeroOrgMembersContract.members, ({ respond }) => {
    return respond(200, mockOrgMembersResponse);
  }),

  mockApi(zeroOrgMembersContract.updateRole, ({ respond }) => {
    return respond(200, { message: "Role updated" });
  }),

  mockApi(zeroOrgMembersContract.removeMember, ({ respond }) => {
    return respond(200, { message: "Member removed" });
  }),

  mockApi(zeroOrgInviteContract.invite, ({ respond }) => {
    return respond(200, { message: "Invitation sent" });
  }),

  mockApi(zeroOrgInviteContract.revoke, ({ respond }) => {
    return respond(200, { message: "Invitation revoked" });
  }),

  mockApi(zeroOrgMembershipRequestsContract.accept, ({ respond }) => {
    return respond(200, { message: "Request accepted" });
  }),

  mockApi(zeroOrgMembershipRequestsContract.reject, ({ respond }) => {
    return respond(200, { message: "Request rejected" });
  }),
];
