import { getOrgIdentity, getOrgIdentityBySlug } from "../../auth/org-cache";
import { readTier } from "./org-metadata-service";

export { invalidateOrgCache } from "../../auth/org-cache";

export interface OrgData {
  orgId: string;
  slug: string;
  name: string;
  tier: string;
}

/**
 * Get org data from cache or Clerk API.
 *
 * **WARNING: This function may call the Clerk API on cache miss (1-min TTL),
 * adding 500-700ms of latency. Prefer `getOrgMetadata()` unless you need
 * slug or name from Clerk.**
 *
 * - slug, name: cached from Clerk (org_cache, 1-min TTL)
 * - tier: read from org_metadata table (platform-owned, always fresh)
 */
export async function getOrgData(orgId: string): Promise<OrgData> {
  const identity = await getOrgIdentity(orgId);
  const tier = await readTier(orgId);
  return { ...identity, tier };
}

/**
 * Get org data by slug from cache or Clerk API (reverse lookup).
 *
 * - slug: cached from Clerk (org_cache, 1-min TTL)
 * - tier: read from org_metadata table (platform-owned, always fresh)
 *
 * Returns null when the slug does not exist in Clerk.
 */
export async function getOrgBySlug(slug: string): Promise<OrgData | null> {
  const identity = await getOrgIdentityBySlug(slug);
  if (!identity) return null;
  const tier = await readTier(identity.orgId);
  return { ...identity, tier };
}
