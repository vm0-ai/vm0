import { z } from "zod";

/**
 * Org list item schema
 */
export const orgListItemSchema = z.object({
  slug: z.string(),
  role: z.string(),
});
export type OrgListItem = z.infer<typeof orgListItemSchema>;

/**
 * Org list response schema
 */
export const orgListResponseSchema = z.object({
  orgs: z.array(orgListItemSchema),
  active: z.string().optional(),
});
export type OrgListResponse = z.infer<typeof orgListResponseSchema>;
