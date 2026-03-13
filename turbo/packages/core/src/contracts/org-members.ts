import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Org role enum
 */
export const orgRoleSchema = z.enum(["admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * Org member schema
 */
export const orgMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

/**
 * Org members response schema (status + members list)
 */
export const orgMembersResponseSchema = z.object({
  slug: z.string(),
  role: orgRoleSchema,
  members: z.array(orgMemberSchema),
  createdAt: z.string(),
});
export type OrgMembersResponse = z.infer<typeof orgMembersResponseSchema>;

/**
 * Invite member request schema
 */
export const inviteOrgMemberRequestSchema = z.object({
  email: z.string().email(),
});
export type InviteOrgMemberRequest = z.infer<
  typeof inviteOrgMemberRequestSchema
>;

/**
 * Remove member request schema
 */
export const removeOrgMemberRequestSchema = z.object({
  email: z.string().email(),
});
export type RemoveOrgMemberRequest = z.infer<
  typeof removeOrgMemberRequestSchema
>;

/**
 * Simple message response schema
 */
export const orgMessageResponseSchema = z.object({
  message: z.string(),
});
export type OrgMessageResponse = z.infer<typeof orgMessageResponseSchema>;

/**
 * Org members contract for /api/org/* member management endpoints
 */
export const orgMembersContract = c.router({
  /**
   * GET /api/org/members
   * Get org members and status
   */
  members: {
    method: "GET",
    path: "/api/org/members",
    headers: authHeadersSchema,
    responses: {
      200: orgMembersResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get org members and status",
  },

  /**
   * POST /api/org/invite
   * Invite a member to the org
   */
  invite: {
    method: "POST",
    path: "/api/org/invite",
    headers: authHeadersSchema,
    body: inviteOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the org",
  },

  /**
   * POST /api/org/leave
   * Leave the current org
   */
  leave: {
    method: "POST",
    path: "/api/org/leave",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: orgMessageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Leave the current org",
  },

  /**
   * DELETE /api/org/members
   * Remove a member from the org
   */
  removeMember: {
    method: "DELETE",
    path: "/api/org/members",
    headers: authHeadersSchema,
    body: removeOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a member from the org",
  },
});

export type OrgMembersContract = typeof orgMembersContract;
