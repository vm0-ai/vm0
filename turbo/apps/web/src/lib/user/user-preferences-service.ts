import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { badRequest } from "../errors";
import { logger } from "../logger";

const log = logger("service:user-preferences");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

interface UserPreferences {
  timezone: string | null;
  notifyEmail: boolean;
  notifySlack: boolean;
}

/**
 * Validate timezone using Intl.DateTimeFormat
 */
function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read preferences from org_members_cache, falling back to Clerk API on miss/stale.
 */
async function getCachedMemberPreferences(
  orgId: string,
  userId: string,
): Promise<UserPreferences> {
  const db = globalThis.services.db;

  // 1. Check cache
  const [cached] = await db
    .select()
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);

  if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return {
      timezone: cached.timezone,
      notifyEmail: cached.notifyEmail,
      notifySlack: cached.notifySlack,
    };
  }

  // 2. Fetch from Clerk API (source of truth)
  const client = await clerkClient();
  const memberships = await client.organizations.getOrganizationMembershipList({
    organizationId: orgId,
  });

  const membership = memberships.data.find(
    (m) => m.publicUserData?.userId === userId,
  );

  const meta = membership?.publicMetadata as
    | Record<string, unknown>
    | undefined;

  const prefs: UserPreferences = {
    timezone: typeof meta?.timezone === "string" ? meta.timezone : null,
    notifyEmail:
      typeof meta?.notify_email === "boolean" ? meta.notify_email : false,
    notifySlack:
      typeof meta?.notify_slack === "boolean" ? meta.notify_slack : true,
  };

  // 3. Upsert cache
  const now = new Date();
  await db
    .insert(orgMembersCache)
    .values({
      orgId,
      userId,
      timezone: prefs.timezone,
      notifyEmail: prefs.notifyEmail,
      notifySlack: prefs.notifySlack,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        timezone: prefs.timezone,
        notifyEmail: prefs.notifyEmail,
        notifySlack: prefs.notifySlack,
        cachedAt: now,
      },
    });

  log.debug("org members cache refreshed", { orgId, userId });

  return prefs;
}

/**
 * Upsert preferences into org_members_cache.
 */
async function upsertMemberCache(
  orgId: string,
  userId: string,
  prefs: Partial<UserPreferences>,
): Promise<void> {
  const now = new Date();
  const db = globalThis.services.db;

  await db
    .insert(orgMembersCache)
    .values({
      orgId,
      userId,
      timezone: prefs.timezone ?? null,
      notifyEmail: prefs.notifyEmail ?? false,
      notifySlack: prefs.notifySlack ?? true,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: {
        ...(prefs.timezone !== undefined && { timezone: prefs.timezone }),
        ...(prefs.notifyEmail !== undefined && {
          notifyEmail: prefs.notifyEmail,
        }),
        ...(prefs.notifySlack !== undefined && {
          notifySlack: prefs.notifySlack,
        }),
        cachedAt: now,
      },
    });
}

/**
 * Build Clerk publicMetadata payload from preference fields.
 */
function buildClerkMetadata(prefs: {
  timezone?: string;
  notifyEmail?: boolean;
  notifySlack?: boolean;
}): Record<string, unknown> {
  return {
    ...(prefs.timezone !== undefined && { timezone: prefs.timezone }),
    ...(prefs.notifyEmail !== undefined && {
      notify_email: prefs.notifyEmail,
    }),
    ...(prefs.notifySlack !== undefined && {
      notify_slack: prefs.notifySlack,
    }),
  };
}

/**
 * Get user preferences from Clerk membership metadata.
 *
 * Fast path: when sessionClaims are provided (JWT context), reads from
 * Clerk membership JWT claims — zero DB/API calls.
 *
 * Fallback: when no claims (cron, run-builder, CLI tokens), reads from
 * org_members_cache (DB-backed read-through cache of Clerk membership data).
 */
export async function getUserPreferences(
  orgId: string,
  userId: string,
  sessionClaims?: CustomJwtSessionClaims,
): Promise<UserPreferences> {
  // JWT fast path: use Clerk membership claims
  if (
    sessionClaims &&
    (sessionClaims.membership_timezone !== undefined ||
      sessionClaims.membership_notify_email !== undefined ||
      sessionClaims.membership_notify_slack !== undefined)
  ) {
    return {
      timezone: sessionClaims.membership_timezone ?? null,
      notifyEmail: sessionClaims.membership_notify_email ?? false,
      notifySlack: sessionClaims.membership_notify_slack ?? true,
    };
  }

  // Cache-backed Clerk API fallback
  return getCachedMemberPreferences(orgId, userId);
}

/**
 * Update user preferences in Clerk membership metadata and local cache.
 */
export async function updateUserPreferences(
  orgId: string,
  userId: string,
  prefs: { timezone?: string; notifyEmail?: boolean; notifySlack?: boolean },
): Promise<UserPreferences> {
  if (prefs.timezone !== undefined) {
    if (!isValidTimezone(prefs.timezone)) {
      throw badRequest(`Invalid timezone: ${prefs.timezone}`);
    }
  }

  // Read existing preferences to merge with partial update
  const existing = await getCachedMemberPreferences(orgId, userId);

  const merged: UserPreferences = {
    timezone: prefs.timezone !== undefined ? prefs.timezone : existing.timezone,
    notifyEmail:
      prefs.notifyEmail !== undefined
        ? prefs.notifyEmail
        : existing.notifyEmail,
    notifySlack:
      prefs.notifySlack !== undefined
        ? prefs.notifySlack
        : existing.notifySlack,
  };

  // Write to Clerk membership metadata
  const client = await clerkClient();
  await client.organizations.updateOrganizationMembershipMetadata({
    organizationId: orgId,
    userId,
    publicMetadata: buildClerkMetadata(prefs),
  });

  // Update local cache with merged result
  await upsertMemberCache(orgId, userId, merged);

  return merged;
}

/**
 * Set user timezone if not already set (for auto-detection on first login).
 * Writes to Clerk membership metadata and local cache.
 */
export async function setTimezoneIfNotSet(
  orgId: string,
  userId: string,
  timezone: string,
  sessionClaims?: CustomJwtSessionClaims,
): Promise<void> {
  if (!isValidTimezone(timezone)) {
    return; // Silently ignore invalid timezone during auto-detection
  }

  const { timezone: existingTimezone } = await getUserPreferences(
    orgId,
    userId,
    sessionClaims,
  );

  if (existingTimezone === null) {
    try {
      const client = await clerkClient();
      await client.organizations.updateOrganizationMembershipMetadata({
        organizationId: orgId,
        userId,
        publicMetadata: { timezone },
      });

      await upsertMemberCache(orgId, userId, { timezone });
    } catch (err) {
      log.error("Failed to write timezone to Clerk metadata", {
        error: err,
        userId,
      });
    }
  }
}
