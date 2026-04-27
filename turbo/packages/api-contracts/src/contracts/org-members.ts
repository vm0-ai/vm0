import { z } from "zod";

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
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  imageUrl: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

/**
 * Pending invitation schema
 */
export const orgPendingInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  createdAt: z.string(),
});
export type OrgPendingInvitation = z.infer<typeof orgPendingInvitationSchema>;

/**
 * Membership request schema
 */
export const orgMembershipRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  imageUrl: z.string(),
  createdAt: z.string(),
});
export type OrgMembershipRequest = z.infer<typeof orgMembershipRequestSchema>;

/**
 * Revoke invitation request schema
 */
export const revokeInvitationRequestSchema = z.object({
  invitationId: z.string(),
});
export type RevokeInvitationRequest = z.infer<
  typeof revokeInvitationRequestSchema
>;

/**
 * Membership request action schema
 */
export const membershipRequestActionSchema = z.object({
  requestId: z.string(),
});
export type MembershipRequestAction = z.infer<
  typeof membershipRequestActionSchema
>;

/**
 * Org members response schema (status + members list)
 */
export const orgMembersResponseSchema = z.object({
  slug: z.string(),
  role: orgRoleSchema,
  members: z.array(orgMemberSchema),
  pendingInvitations: z.array(orgPendingInvitationSchema).optional(),
  membershipRequests: z.array(orgMembershipRequestSchema).optional(),
  createdAt: z.string(),
});
export type OrgMembersResponse = z.infer<typeof orgMembersResponseSchema>;

/**
 * Invite member request schema
 */
export const inviteOrgMemberRequestSchema = z.object({
  email: z.string().email(),
  role: orgRoleSchema.optional().default("member"),
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
 * Update member role request schema
 */
export const updateOrgMemberRoleRequestSchema = z.object({
  email: z.string().email(),
  role: orgRoleSchema,
});
export type UpdateOrgMemberRoleRequest = z.infer<
  typeof updateOrgMemberRoleRequestSchema
>;

/**
 * Org domain schema
 */
export const orgDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  enrollmentMode: z.string(),
  verification: z.object({
    status: z.string(),
    strategy: z.string(),
  }),
  createdAt: z.string(),
});
export type OrgDomain = z.infer<typeof orgDomainSchema>;

/**
 * Org domains response schema
 */
export const orgDomainsResponseSchema = z.object({
  domains: z.array(orgDomainSchema),
});
export type OrgDomainsResponse = z.infer<typeof orgDomainsResponseSchema>;

/**
 * Add domain request schema
 */
const orgEnrollmentModeSchema = z.enum([
  "manual_invitation",
  "automatic_invitation",
  "automatic_suggestion",
]);
export type OrgEnrollmentMode = z.infer<typeof orgEnrollmentModeSchema>;

export const addDomainRequestSchema = z.object({
  name: z.string(),
  enrollmentMode: orgEnrollmentModeSchema,
});
export type AddDomainRequest = z.infer<typeof addDomainRequestSchema>;

/**
 * Domain action request schema (for delete)
 */
export const domainActionRequestSchema = z.object({
  domainId: z.string(),
});
export type DomainActionRequest = z.infer<typeof domainActionRequestSchema>;

/**
 * Domain verify/unverify request schema
 */
export const domainVerifyRequestSchema = z.object({
  domainId: z.string(),
  verified: z.boolean(),
});
export type DomainVerifyRequest = z.infer<typeof domainVerifyRequestSchema>;

/**
 * Simple message response schema
 */
export const orgMessageResponseSchema = z.object({
  message: z.string(),
});
export type OrgMessageResponse = z.infer<typeof orgMessageResponseSchema>;
