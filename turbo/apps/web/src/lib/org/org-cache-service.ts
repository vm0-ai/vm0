import { eq, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgCache } from "../../db/schema/org-cache";
import { orgMetadata } from "../../db/schema/org-metadata";
import { logger } from "../logger";
import { getStripe } from "../stripe";

const log = logger("service:org-cache");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

/** Billing period cache TTL — period changes monthly, no need for frequent refresh */
const BILLING_CACHE_TTL_MS = 300_000; // 5 minutes

interface OrgData {
  orgId: string;
  slug: string;
  name: string;
  tier: string;
}

/**
 * Read tier from the org table (source of truth).
 * Returns "free" if the org row does not exist.
 */
async function readTier(orgId: string): Promise<string> {
  const db = globalThis.services.db;
  const [orgRow] = await db
    .select({ tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
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

  // Check slug cache
  const [cached] = await db
    .select()
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    const tier = await readTier(orgId);
    return { orgId, slug: cached.slug, name: cached.name, tier };
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

  const tier = await readTier(orgId);

  // Upsert slug cache
  const now = new Date();
  await db
    .insert(orgCache)
    .values({ orgId, slug, name, cachedAt: now })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, name, cachedAt: now },
    });

  log.debug("org cache refreshed", { orgId, slug, tier });

  return { orgId, slug, name, tier };
}

/**
 * Batch-fetch org data for multiple org IDs.
 * Performs 2 DB queries (org_cache + org_metadata) instead of 2N,
 * then falls back to individual Clerk API calls only for cache misses.
 */
export async function batchGetOrgData(
  orgIds: string[],
): Promise<Map<string, OrgData>> {
  if (orgIds.length === 0) return new Map();

  const db = globalThis.services.db;

  // Batch query: all cached org slugs/names
  const cachedRows = await db
    .select()
    .from(orgCache)
    .where(inArray(orgCache.orgId, orgIds));

  const cacheMap = new Map(cachedRows.map((r) => [r.orgId, r]));

  // Batch query: all org tiers
  const tierRows = await db
    .select({ orgId: orgMetadata.orgId, tier: orgMetadata.tier })
    .from(orgMetadata)
    .where(inArray(orgMetadata.orgId, orgIds));

  const tierMap = new Map(tierRows.map((r) => [r.orgId, r.tier]));

  const result = new Map<string, OrgData>();

  // Identify cache hits vs misses
  const missingIds: string[] = [];
  for (const orgId of orgIds) {
    const cached = cacheMap.get(orgId);
    if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
      result.set(orgId, {
        orgId,
        slug: cached.slug,
        name: cached.name,
        tier: tierMap.get(orgId) ?? "free",
      });
    } else {
      missingIds.push(orgId);
    }
  }

  // Fetch cache misses from Clerk individually (no batch API available)
  if (missingIds.length > 0) {
    const client = await clerkClient();
    const now = new Date();

    await Promise.all(
      missingIds.map(async (orgId) => {
        const clerkOrg = await client.organizations.getOrganization({
          organizationId: orgId,
        });

        if (!clerkOrg.slug) {
          throw new Error(
            `Clerk organization ${orgId} has no slug — cannot cache`,
          );
        }

        // Upsert cache
        await db
          .insert(orgCache)
          .values({
            orgId,
            slug: clerkOrg.slug,
            name: clerkOrg.name,
            cachedAt: now,
          })
          .onConflictDoUpdate({
            target: orgCache.orgId,
            set: { slug: clerkOrg.slug, name: clerkOrg.name, cachedAt: now },
          });

        result.set(orgId, {
          orgId,
          slug: clerkOrg.slug,
          name: clerkOrg.name,
          tier: tierMap.get(orgId) ?? "free",
        });
      }),
    );
  }

  return result;
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
    return { orgId: cached.orgId, slug: cached.slug, name: cached.name, tier };
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
    tier,
  });

  return { orgId: clerkOrg.id, slug: clerkOrg.slug, name: clerkOrg.name, tier };
}

/**
 * Get the current billing period for an org, using org_cache as a read-through
 * cache with independent 5-min TTL.
 *
 * Returns `{ start, end }` for paying orgs, or `null` for free tier (no billing period).
 * Free-tier null results are cached to avoid repeated DB/Stripe lookups.
 */
export async function getOrgBillingPeriod(
  orgId: string,
): Promise<{ start: Date; end: Date } | null> {
  const db = globalThis.services.db;

  // 1. Check cache
  const [cached] = await db
    .select({
      currentPeriodStart: orgCache.currentPeriodStart,
      currentPeriodEnd: orgCache.currentPeriodEnd,
      billingCachedAt: orgCache.billingCachedAt,
    })
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);

  if (
    cached?.billingCachedAt &&
    Date.now() - cached.billingCachedAt.getTime() < BILLING_CACHE_TTL_MS
  ) {
    // Cache hit — return cached values or null (negative cache for free tier)
    if (cached.currentPeriodEnd && cached.currentPeriodStart) {
      return { start: cached.currentPeriodStart, end: cached.currentPeriodEnd };
    }
    return null;
  }

  // 2. Cache miss/stale — read from org_metadata
  const [orgRow] = await db
    .select({
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  let periodEnd = orgRow?.currentPeriodEnd ?? null;

  if (!periodEnd && orgRow?.stripeSubscriptionId) {
    // Has subscription but no period cached in metadata — fetch from Stripe.
    // In Stripe v2025 API, current_period_end was removed from Subscription.
    // Use the latest_invoice.period_end instead.
    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(
      orgRow.stripeSubscriptionId,
    );
    if (subscription.latest_invoice) {
      const invoiceId =
        typeof subscription.latest_invoice === "string"
          ? subscription.latest_invoice
          : subscription.latest_invoice.id;
      const latestInvoice = await stripe.invoices.retrieve(invoiceId);
      periodEnd = new Date(latestInvoice.period_end * 1000);

      // Update org_metadata so future lookups skip Stripe
      await db
        .update(orgMetadata)
        .set({ currentPeriodEnd: periodEnd, updatedAt: new Date() })
        .where(eq(orgMetadata.orgId, orgId));
    }
  }

  const now = new Date();

  if (periodEnd) {
    // Compute start = end - 1 month
    const periodStart = new Date(periodEnd);
    periodStart.setMonth(periodStart.getMonth() - 1);

    // Cache the result
    await db
      .update(orgCache)
      .set({
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        billingCachedAt: now,
      })
      .where(eq(orgCache.orgId, orgId));

    log.debug("billing period cached", { orgId, periodStart, periodEnd });
    return { start: periodStart, end: periodEnd };
  }

  // Free tier — cache negative result
  await db
    .update(orgCache)
    .set({ billingCachedAt: now })
    .where(eq(orgCache.orgId, orgId));

  log.debug("billing period cached (free tier)", { orgId });
  return null;
}
