import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Scope role enum
 */
export const orgRoleSchema = z.enum(["admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * Scope member schema
 */
export const scopeMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type ScopeMember = z.infer<typeof scopeMemberSchema>;

/**
 * Scope members response schema (status + members list)
 */
export const scopeMembersResponseSchema = z.object({
  slug: z.string(),
  role: orgRoleSchema,
  members: z.array(scopeMemberSchema),
  createdAt: z.string(),
});
export type ScopeMembersResponse = z.infer<typeof scopeMembersResponseSchema>;

/**
 * Invite member request schema
 */
export const inviteScopeMemberRequestSchema = z.object({
  email: z.string().email(),
});
export type InviteScopeMemberRequest = z.infer<
  typeof inviteScopeMemberRequestSchema
>;

/**
 * Remove member request schema
 */
export const removeScopeMemberRequestSchema = z.object({
  email: z.string().email(),
});
export type RemoveScopeMemberRequest = z.infer<
  typeof removeScopeMemberRequestSchema
>;

/**
 * Simple message response schema
 */
export const scopeMessageResponseSchema = z.object({
  message: z.string(),
});
export type ScopeMessageResponse = z.infer<typeof scopeMessageResponseSchema>;

/**
 * Scope members contract for /api/scope/* member management endpoints
 */
export const scopeMembersContract = c.router({
  /**
   * GET /api/scope/members
   * Get scope members and status
   */
  members: {
    method: "GET",
    path: "/api/scope/members",
    headers: authHeadersSchema,
    responses: {
      200: scopeMembersResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get scope members and status",
  },

  /**
   * POST /api/scope/invite
   * Invite a member to the scope
   */
  invite: {
    method: "POST",
    path: "/api/scope/invite",
    headers: authHeadersSchema,
    body: inviteScopeMemberRequestSchema,
    responses: {
      200: scopeMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the scope",
  },

  /**
   * POST /api/scope/leave
   * Leave the current scope
   */
  leave: {
    method: "POST",
    path: "/api/scope/leave",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: scopeMessageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Leave the current scope",
  },

  /**
   * DELETE /api/scope/members
   * Remove a member from the scope
   */
  removeMember: {
    method: "DELETE",
    path: "/api/scope/members",
    headers: authHeadersSchema,
    body: removeScopeMemberRequestSchema,
    responses: {
      200: scopeMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a member from the scope",
  },
});

export type ScopeMembersContract = typeof scopeMembersContract;
