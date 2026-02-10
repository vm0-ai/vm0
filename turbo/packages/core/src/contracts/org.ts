import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { scopeSlugSchema, scopeResponseSchema } from "./scopes";

const c = initContract();

/**
 * Organization member role
 */
export const orgRoleSchema = z.enum(["owner", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * Organization member response
 */
export const orgMemberSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  email: z.string().optional(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});

export type OrgMember = z.infer<typeof orgMemberSchema>;

/**
 * Organization status response
 */
export const orgStatusSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  type: z.literal("organization"),
  createdAt: z.string(),
  updatedAt: z.string(),
  members: z.array(orgMemberSchema),
  memberCount: z.number(),
});

export type OrgStatus = z.infer<typeof orgStatusSchema>;

/**
 * Create organization request
 */
export const createOrgRequestSchema = z.object({
  slug: scopeSlugSchema,
});

export type CreateOrgRequest = z.infer<typeof createOrgRequestSchema>;

/**
 * Invite link response
 */
export const inviteLinkResponseSchema = z.object({
  token: z.string(),
  url: z.string(),
  expiresAt: z.string(),
});

export type InviteLinkResponse = z.infer<typeof inviteLinkResponseSchema>;

/**
 * Invitation details response
 */
export const invitationDetailsSchema = z.object({
  orgSlug: z.string(),
  orgName: z.string(),
  invitedBy: z.string().optional(),
  expiresAt: z.string(),
  isValid: z.boolean(),
});

export type InvitationDetails = z.infer<typeof invitationDetailsSchema>;

/**
 * Scope list item
 */
export const scopeListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  type: z.enum(["personal", "organization"]),
  role: orgRoleSchema.optional(),
});

export type ScopeListItem = z.infer<typeof scopeListItemSchema>;

/**
 * Scope list response
 */
export const scopeListResponseSchema = z.object({
  scopes: z.array(scopeListItemSchema),
  currentScope: z.string().optional(),
});

export type ScopeListResponse = z.infer<typeof scopeListResponseSchema>;

/**
 * Organization API contracts
 */
export const orgContract = c.router({
  /**
   * POST /api/org - Create organization
   */
  create: {
    method: "POST",
    path: "/api/org",
    headers: authHeadersSchema,
    body: createOrgRequestSchema,
    responses: {
      201: scopeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a new organization",
  },

  /**
   * GET /api/org - Get user's owned organization
   */
  get: {
    method: "GET",
    path: "/api/org",
    headers: authHeadersSchema,
    responses: {
      200: scopeResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get user's owned organization",
  },

  /**
   * GET /api/org/status - Get organization status with members
   */
  status: {
    method: "GET",
    path: "/api/org/status",
    headers: authHeadersSchema,
    responses: {
      200: orgStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get organization status with members",
  },

  /**
   * POST /api/org/invite - Create invite link
   */
  createInvite: {
    method: "POST",
    path: "/api/org/invite",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      201: inviteLinkResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create organization invite link",
  },

  /**
   * DELETE /api/org/members/:userId - Remove member
   */
  removeMember: {
    method: "DELETE",
    path: "/api/org/members/:userId",
    headers: authHeadersSchema,
    pathParams: z.object({
      userId: z.string(),
    }),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Remove member from organization",
  },

  /**
   * POST /api/org/leave - Leave organization
   */
  leave: {
    method: "POST",
    path: "/api/org/leave",
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: z.object({ success: z.literal(true) }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Leave organization (member only)",
  },
});

/**
 * Invitation API contracts
 */
export const inviteContract = c.router({
  /**
   * GET /api/invite/:token - Get invitation details
   */
  getDetails: {
    method: "GET",
    path: "/api/invite/:token",
    pathParams: z.object({
      token: z.string(),
    }),
    responses: {
      200: invitationDetailsSchema,
      404: apiErrorSchema,
    },
    summary: "Get invitation details",
  },

  /**
   * POST /api/invite/:token/accept - Accept invitation
   */
  accept: {
    method: "POST",
    path: "/api/invite/:token/accept",
    headers: authHeadersSchema,
    pathParams: z.object({
      token: z.string(),
    }),
    body: z.object({}),
    responses: {
      200: scopeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Accept invitation and join organization",
  },
});

/**
 * Scope list API contract
 */
export const scopeListContract = c.router({
  /**
   * GET /api/scope/list - List all accessible scopes
   */
  list: {
    method: "GET",
    path: "/api/scope/list",
    headers: authHeadersSchema,
    responses: {
      200: scopeListResponseSchema,
      401: apiErrorSchema,
    },
    summary: "List all accessible scopes",
  },
});

export type OrgContract = typeof orgContract;
export type InviteContract = typeof inviteContract;
export type ScopeListContract = typeof scopeListContract;
