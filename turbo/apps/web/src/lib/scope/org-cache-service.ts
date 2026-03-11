import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgCache } from "../../db/schema/org-cache";
import { logger } from "../logger";

const log = logger("service:org-cache");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

interface OrgData {
  clerkOrgId: string;
  slug: string;
  tier: string;
}

/**
 * Get org data from cache or Clerk API.
 *
 * 1. Check org_cache by clerkOrgId
 * 2. If fresh (< 1 min): return cached data
 * 3. If miss or stale: call Clerk API, upsert cache, return
 */
export async function getOrgData(clerkOrgId: string): Promise<OrgData> {
  const db = globalThis.services.db;

  // 1. Check cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.clerkOrgId, clerkOrgId))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return { clerkOrgId, slug: cached.slug, tier: cached.tier };
  }

  // 2. Fetch from Clerk (source of truth)
  const client = await clerkClient();
  const org = await client.organizations.getOrganization({
    organizationId: clerkOrgId,
  });

  if (!org.slug) {
    throw new Error(
      `Clerk organization ${clerkOrgId} has no slug — cannot cache`,
    );
  }
  const slug = org.slug;
  const metadata = org.publicMetadata as Record<string, unknown> | undefined;
  const rawTier = metadata?.tier;
  const tier =
    typeof rawTier === "string" && rawTier.length > 0 ? rawTier : "free";

  // 3. Upsert cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({ clerkOrgId, slug, tier, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.clerkOrgId,
      set: { slug, tier, cachedAt: now },
    });

  log.debug("org cache refreshed", { clerkOrgId, slug, tier });

  return { clerkOrgId, slug, tier };
}
