import { z } from "zod";

/**
 * Org list item schema
 */
export const orgListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
});
export type OrgListItem = z.infer<typeof orgListItemSchema>;

/**
 * Org list response schema
 */
export const orgListResponseSchema = z.object({
  orgs: z.array(orgListItemSchema),
});
export type OrgListResponse = z.infer<typeof orgListResponseSchema>;
