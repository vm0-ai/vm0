import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgCache } from "../../db/schema/org-cache";
import { org } from "../../db/schema/org";
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
 * Read tier from the org table (source of truth).
 * Returns "free" if the org row does not exist.
 */
async function readTier(orgId: string): Promise<string> {
  const db = globalThis.services.db;
  const [orgRow] = await db
    .select({ tier: org.tier })
    .from(org)
    .where(eq(org.orgId, orgId))
    .limit(1);
  return orgRow?.tier ?? "free";
}

/**
 * Get org data from cache or Clerk API.
 *
 * - slug: cached from Clerk (org_cache, 1-min TTL)
 * - tier: read from org table (owned by platform, always fresh)
 */
export async function getOrgData(orgId: string): Promise<OrgData> {
  const db = globalThis.services.db;

  // Read tier from org table (source of truth)
  const tier = await readTier(orgId);

  // Check slug cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return { orgId, slug: cached.slug, tier };
  }

  // Fetch slug from Clerk (source of truth for slug)
  const client = await clerkClient();
  const clerkOrg = await client.organizations.getOrganization({
    organizationId: orgId,
  });

  if (!clerkOrg.slug) {
    throw new Error(`Clerk organization ${orgId} has no slug — cannot cache`);
  }
  const slug = clerkOrg.slug;

  // Upsert slug cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({ orgId, slug, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, cachedAt: now },
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
 * - slug: cached from Clerk (org_cache, 1-min TTL)
 * - tier: read from org table (owned by platform, always fresh)
 *
 * Returns null when the slug does not exist in Clerk.
 */
export async function getOrgBySlug(slug: string): Promise<OrgData | null> {
  const db = globalThis.services.db;

  // Check slug cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.slug, slug))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    const tier = await readTier(cached.orgId);
    return { orgId: cached.orgId, slug: cached.slug, tier };
  }

  // Fetch from Clerk by slug
  const client = await clerkClient();
  let clerkOrg;
  try {
    clerkOrg = await client.organizations.getOrganization({ slug });
  } catch {
    return null;
  }

  if (!clerkOrg.slug) {
    log.warn(`Clerk organization looked up by slug '${slug}' has no slug`);
    return null;
  }

  const tier = await readTier(clerkOrg.id);

  // Upsert slug cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({ orgId: clerkOrg.id, slug: clerkOrg.slug, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug: clerkOrg.slug, cachedAt: now },
    });

  log.debug("org cache refreshed (by slug)", {
    orgId: clerkOrg.id,
    slug: clerkOrg.slug,
    tier,
  });

  return { orgId: clerkOrg.id, slug: clerkOrg.slug, tier };
}
