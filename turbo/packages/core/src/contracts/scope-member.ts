import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Scope member role enum
 */
export const memberRoleSchema = z.enum(["admin", "member"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

/**
 * Scope member schema
 */
export const scopeMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: memberRoleSchema,
  joinedAt: z.string(),
});
export type ScopeMember = z.infer<typeof scopeMemberSchema>;

/**
 * Scope members response schema
 */
export const scopeMembersResponseSchema = z.object({
  slug: z.string(),
  role: memberRoleSchema,
  members: z.array(scopeMemberSchema),
  createdAt: z.string(),
});
export type ScopeMembersResponse = z.infer<typeof scopeMembersResponseSchema>;

/**
 * Invite member request schema
 */
export const inviteRequestSchema = z.object({
  email: z.string().email(),
});
export type InviteRequest = z.infer<typeof inviteRequestSchema>;

/**
 * Remove member request schema
 */
export const removeMemberRequestSchema = z.object({
  email: z.string().email(),
});
export type RemoveMemberRequest = z.infer<typeof removeMemberRequestSchema>;

/**
 * Simple message response schema
 */
export const messageResponseSchema = z.object({
  message: z.string(),
});
export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Scope member contract for /api/scope member management
 */
export const scopeMemberContract = c.router({
  /**
   * GET /api/scope/members
   * Get scope members and status
   */
  status: {
    method: "GET",
    path: "/api/scope/members",
    headers: authHeadersSchema,
    responses: {
      200: scopeMembersResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get scope members and status",
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
      200: messageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Leave the current scope",
  },

  /**
   * POST /api/scope/invite
   * Invite a member to the scope
   */
  invite: {
    method: "POST",
    path: "/api/scope/invite",
    headers: authHeadersSchema,
    body: inviteRequestSchema,
    responses: {
      200: messageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the scope",
  },

  /**
   * DELETE /api/scope/members
   * Remove a member from the scope
   */
  removeMember: {
    method: "DELETE",
    path: "/api/scope/members",
    headers: authHeadersSchema,
    body: removeMemberRequestSchema,
    responses: {
      200: messageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a member from the scope",
  },
});

export type ScopeMemberContract = typeof scopeMemberContract;
