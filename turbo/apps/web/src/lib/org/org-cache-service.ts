import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgCache } from "../../db/schema/org-cache";
import { logger } from "../logger";

const log = logger("service:org-cache");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

interface OrgData {
  orgId: string;
  slug: string;
  tier: string;
}

/**
 * Get org data from cache or Clerk API.
 *
 * 1. Check org_cache by orgId
 * 2. If fresh (< 1 min): return cached data
 * 3. If miss or stale: call Clerk API, upsert cache, return
 */
export async function getOrgData(orgId: string): Promise<OrgData> {
  const db = globalThis.services.db;

  // 1. Check cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return { orgId, slug: cached.slug, tier: cached.tier };
  }

  // 2. Fetch from Clerk (source of truth)
  const client = await clerkClient();
  const org = await client.organizations.getOrganization({
    organizationId: orgId,
  });

  if (!org.slug) {
    throw new Error(`Clerk organization ${orgId} has no slug — cannot cache`);
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
    .values({ orgId, slug, tier, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, tier, cachedAt: now },
    });

  log.debug("org cache refreshed", { orgId, slug, tier });

  return { orgId, slug, tier };
}

/**
 * Invalidate (delete) an org_cache entry so the next getOrgData call
 * re-fetches from Clerk. Used after mutations that change org data
 * (e.g. slug updates) to avoid returning stale cached values.
 */
export async function invalidateOrgCache(orgId: string): Promise<void> {
  const db = globalThis.services.db;
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
}

/**
 * Get org data by slug from cache or Clerk API (reverse lookup).
 *
 * 1. Check org_cache by slug
 * 2. If fresh (< 1 min): return cached data
 * 3. If miss or stale: call Clerk API with { slug }, upsert cache, return
 *
 * Returns null when the slug does not exist in Clerk.
 */
export async function getOrgBySlug(slug: string): Promise<OrgData | null> {
  const db = globalThis.services.db;

  // 1. Check cache by slug
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.slug, slug))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return {
      orgId: cached.orgId,
      slug: cached.slug,
      tier: cached.tier,
    };
  }

  // 2. Fetch from Clerk by slug
  const client = await clerkClient();
  let org;
  try {
    org = await client.organizations.getOrganization({ slug });
  } catch {
    return null;
  }

  if (!org.slug) {
    log.warn(`Clerk organization looked up by slug '${slug}' has no slug`);
    return null;
  }

  const metadata = org.publicMetadata as Record<string, unknown> | undefined;
  const rawTier = metadata?.tier;
  const tier =
    typeof rawTier === "string" && rawTier.length > 0 ? rawTier : "free";

  // 3. Upsert cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({ orgId: org.id, slug: org.slug, tier, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug: org.slug, tier, cachedAt: now },
    });

  log.debug("org cache refreshed (by slug)", {
    orgId: org.id,
    slug: org.slug,
    tier,
  });

  return { orgId: org.id, slug: org.slug, tier };
}
