import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  orgMembersResponseSchema,
  inviteOrgMemberRequestSchema,
  removeOrgMemberRequestSchema,
  updateOrgMemberRoleRequestSchema,
  revokeInvitationRequestSchema,
  membershipRequestActionSchema,
  orgMessageResponseSchema,
} from "./org-members";

const c = initContract();

/**
 * Zero contract for /api/zero/org/members
 * Proxies to /api/org/members
 */
export const zeroOrgMembersContract = c.router({
  members: {
    method: "GET",
    path: "/api/zero/org/members",
    headers: authHeadersSchema,
    responses: {
      200: orgMembersResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get org members (zero proxy)",
  },
  updateRole: {
    method: "PATCH",
    path: "/api/zero/org/members",
    headers: authHeadersSchema,
    body: updateOrgMemberRoleRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update a member's role (zero proxy)",
  },
  removeMember: {
    method: "DELETE",
    path: "/api/zero/org/members",
    headers: authHeadersSchema,
    body: removeOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a member from the org (zero proxy)",
  },
});

export type ZeroOrgMembersContract = typeof zeroOrgMembersContract;

/**
 * Zero contract for POST /api/zero/org/invite
 * Proxies to POST /api/org/invite
 */
export const zeroOrgInviteContract = c.router({
  invite: {
    method: "POST",
    path: "/api/zero/org/invite",
    headers: authHeadersSchema,
    body: inviteOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the org (zero proxy)",
  },
  revoke: {
    method: "DELETE",
    path: "/api/zero/org/invite",
    headers: authHeadersSchema,
    body: revokeInvitationRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Revoke a pending invitation (zero proxy)",
  },
});

export type ZeroOrgInviteContract = typeof zeroOrgInviteContract;

/**
 * Zero contract for /api/zero/org/membership-requests
 */
export const zeroOrgMembershipRequestsContract = c.router({
  accept: {
    method: "POST",
    path: "/api/zero/org/membership-requests",
    headers: authHeadersSchema,
    body: membershipRequestActionSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Accept a membership request (zero proxy)",
  },
  reject: {
    method: "DELETE",
    path: "/api/zero/org/membership-requests",
    headers: authHeadersSchema,
    body: membershipRequestActionSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Reject a membership request (zero proxy)",
  },
});

export type ZeroOrgMembershipRequestsContract =
  typeof zeroOrgMembershipRequestsContract;
