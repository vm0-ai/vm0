import { z } from "zod";
import { orgRoleSchema } from "./org-members";

/**
 * Org tier values
 */
export const orgTierSchema = z.enum([
  "free",
  "limited-free-1",
  "pro-suspend",
  "pro",
  "team",
  "custom",
]);
export type OrgTier = z.infer<typeof orgTierSchema>;

const ORG_TIER_SET: ReadonlySet<string> = new Set(orgTierSchema.options);

export function isOrgTier(value: string | null | undefined): value is OrgTier {
  return typeof value === "string" && ORG_TIER_SET.has(value);
}

/**
 * Org slug validation
 * - 3-64 characters (or 1-2 for single/double char slugs)
 * - lowercase letters, numbers, and hyphens only
 * - must start and end with alphanumeric
 */
export const orgSlugSchema = z
  .string()
  .min(3, "Org slug must be at least 3 characters")
  .max(64, "Org slug must be at most 64 characters")
  .regex(
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/,
    "Org slug must contain only lowercase letters, numbers, and hyphens, and must start and end with an alphanumeric character",
  )
  .transform((s) => {
    return s.toLowerCase();
  });

/**
 * Org response schema
 */
export const orgResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  tier: z.string().optional(),
  role: orgRoleSchema.optional(),
  createdBy: z.string().optional(),
});

export type OrgResponse = z.infer<typeof orgResponseSchema>;

/**
 * Update org request schema
 */
export const updateOrgRequestSchema = z.object({
  slug: orgSlugSchema.optional(),
  name: z.string().min(1).max(128).optional(),
  force: z.boolean().optional().default(false),
});

export type UpdateOrgRequest = z.infer<typeof updateOrgRequestSchema>;
