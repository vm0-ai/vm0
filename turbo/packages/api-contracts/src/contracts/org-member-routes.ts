import { z } from "zod";
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
  orgInvitationPurchasePreviewResponseSchema,
  previewOrgInvitationPurchaseRequestSchema,
} from "./org-members";

const c = initContract();

const invitationPurchaseConfirmResponseSchema = z.union([
  orgMessageResponseSchema,
  z.object({
    status: z.literal("pending_payment"),
    hostedInvoiceUrl: z.string().url(),
    message: z.string().optional(),
  }),
  z.object({
    status: z.literal("checkout_required"),
    checkoutUrl: z.string().url(),
    message: z.string().optional(),
  }),
]);

/**
 * Zero contract for /api/okou/org/members
 * Proxies to /api/org/members
 */
export const orgMembersContract = c.router({
  members: {
    method: "GET",
    path: "/api/okou/org/members",
    headers: authHeadersSchema,
    responses: {
      200: orgMembersResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get org members (zero proxy)",
  },
  updateRole: {
    method: "PATCH",
    path: "/api/okou/org/members",
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
    path: "/api/okou/org/members",
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

export type OrgMembersContract = typeof orgMembersContract;

/**
 * Zero contract for POST /api/okou/org/invite
 * Proxies to POST /api/org/invite
 */
export const orgInviteContract = c.router({
  invite: {
    method: "POST",
    path: "/api/okou/org/invite",
    headers: authHeadersSchema,
    body: inviteOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the org (zero proxy)",
  },
  previewPurchase: {
    method: "POST",
    path: "/api/okou/org/invite/purchase/preview",
    headers: authHeadersSchema,
    body: previewOrgInvitationPurchaseRequestSchema,
    responses: {
      200: orgInvitationPurchasePreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Preview a prorated usage pack purchase for an org invitation",
  },
  confirmPurchase: {
    method: "POST",
    path: "/api/okou/org/invite/purchase/:purchaseId/confirm",
    pathParams: z.object({ purchaseId: z.uuid() }),
    headers: authHeadersSchema,
    body: z.object({
      paymentMethodPreviewToken: z.string().min(1).optional(),
    }),
    responses: {
      200: invitationPurchaseConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Confirm an org invitation usage pack purchase",
  },
  revoke: {
    method: "DELETE",
    path: "/api/okou/org/invite",
    headers: authHeadersSchema,
    body: revokeInvitationRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Revoke a pending invitation (zero proxy)",
  },
});

export type OrgInviteContract = typeof orgInviteContract;

/**
 * Zero contract for /api/okou/org/membership-requests
 */
export const orgMembershipRequestsContract = c.router({
  accept: {
    method: "POST",
    path: "/api/okou/org/membership-requests",
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
    path: "/api/okou/org/membership-requests",
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

export type OrgMembershipRequestsContract =
  typeof orgMembershipRequestsContract;
