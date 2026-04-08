import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgCache } from "../../db/schema/org-cache";
import { logger } from "../shared/logger";

const log = logger("service:org-cache");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

interface OrgIdentity {
  orgId: string;
  slug: string;
  name: string;
}

/**
 * Get org name and slug from cache or Clerk API.
 *
 * **WARNING: This function may call the Clerk API on cache miss (1-min TTL),
 * adding 500-700ms of latency.**
 *
 * - slug, name: cached from Clerk (org_cache, 1-min TTL)
 */
export async function getOrgNameAndSlug(orgId: string): Promise<OrgIdentity> {
  const db = globalThis.services.db;

  // Check slug cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return { orgId, slug: cached.slug, name: cached.name };
  }

  // Cache miss — fetch from Clerk (source of truth for slug)
  const client = await clerkClient();
  const clerkOrg = await client.organizations.getOrganization({
    organizationId: orgId,
  });

  if (!clerkOrg.slug) {
    throw new Error(`Clerk organization ${orgId} has no slug — cannot cache`);
  }
  const slug = clerkOrg.slug;
  const name = clerkOrg.name;

  // Upsert slug cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({ orgId, slug, name, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, name, cachedAt: now },
    });

  log.debug("org cache refreshed", { orgId, slug });

  return { orgId, slug, name };
}

/**
 * Invalidate (delete) an org_cache entry so the next getOrgNameAndSlug call
 * re-fetches from Clerk. Used after mutations that change org data
 * (e.g. slug updates) to avoid returning stale cached values.
 */
export async function invalidateOrgCache(orgId: string): Promise<void> {
  const db = globalThis.services.db;
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
}

/**
 * Look up an org's ID by slug from cache or Clerk API (reverse lookup).
 *
 * Returns the orgId, or null when the slug does not exist in Clerk.
 * The org_cache is still populated as a side effect.
 */
export async function getOrgIdBySlug(slug: string): Promise<string | null> {
  const db = globalThis.services.db;

  // Check slug cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.slug, slug))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return cached.orgId;
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

  // Upsert slug cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({
      orgId: clerkOrg.id,
      slug: clerkOrg.slug,
      name: clerkOrg.name,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug: clerkOrg.slug, name: clerkOrg.name, cachedAt: now },
    });

  log.debug("org cache refreshed (by slug)", {
    orgId: clerkOrg.id,
    slug: clerkOrg.slug,
  });

  return clerkOrg.id;
}
