import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { scopeSlugSchema } from "./scopes";

const c = initContract();

/**
 * Organization role enum
 */
export const orgRoleSchema = z.enum(["admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * Organization member schema
 */
export const orgMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

/**
 * Organization status response schema
 */
export const orgStatusResponseSchema = z.object({
  slug: z.string(),
  role: orgRoleSchema,
  members: z.array(orgMemberSchema),
  createdAt: z.string(),
});
export type OrgStatusResponse = z.infer<typeof orgStatusResponseSchema>;

/**
 * Create organization request schema
 */
export const createOrgRequestSchema = z.object({
  slug: scopeSlugSchema,
});
export type CreateOrgRequest = z.infer<typeof createOrgRequestSchema>;

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
 * Organization contract for /api/org
 */
export const orgContract = c.router({
  /**
   * POST /api/org
   * Create a new organization
   */
  create: {
    method: "POST",
    path: "/api/org",
    headers: authHeadersSchema,
    body: createOrgRequestSchema,
    responses: {
      201: orgStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a new organization",
  },

  /**
   * GET /api/org/status
   * Get current organization status and members
   */
  status: {
    method: "GET",
    path: "/api/org/status",
    headers: authHeadersSchema,
    responses: {
      200: orgStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get organization status and members",
  },

  /**
   * POST /api/org/leave
   * Leave the current organization
   */
  leave: {
    method: "POST",
    path: "/api/org/leave",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: messageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Leave the current organization",
  },

  /**
   * POST /api/org/invite
   * Invite a member to the organization
   */
  invite: {
    method: "POST",
    path: "/api/org/invite",
    headers: authHeadersSchema,
    body: inviteRequestSchema,
    responses: {
      200: messageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the organization",
  },

  /**
   * DELETE /api/org/members
   * Remove a member from the organization
   */
  removeMember: {
    method: "DELETE",
    path: "/api/org/members",
    headers: authHeadersSchema,
    body: removeMemberRequestSchema,
    responses: {
      200: messageResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a member from the organization",
  },
});

export type OrgContract = typeof orgContract;
