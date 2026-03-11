import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { scopeMembers } from "../../db/schema/scope-member";
import { scopes } from "../../db/schema/scope";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { badRequest } from "../errors";
import { getPrimaryAdminMembership } from "../scope/scope-member-service";
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
  clerkOrgId: string,
  userId: string,
): Promise<UserPreferences> {
  const db = globalThis.services.db;

  // 1. Check cache
  const [cached] = await db
    .select()
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.clerkOrgId, clerkOrgId),
        eq(orgMembersCache.userId, userId),
      ),
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
    organizationId: clerkOrgId,
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
      clerkOrgId,
      userId,
      timezone: prefs.timezone,
      notifyEmail: prefs.notifyEmail,
      notifySlack: prefs.notifySlack,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.clerkOrgId, orgMembersCache.userId],
      set: {
        timezone: prefs.timezone,
        notifyEmail: prefs.notifyEmail,
        notifySlack: prefs.notifySlack,
        cachedAt: now,
      },
    });

  log.debug("org members cache refreshed", { clerkOrgId, userId });

  return prefs;
}

/**
 * Upsert preferences into org_members_cache.
 */
async function upsertMemberCache(
  clerkOrgId: string,
  userId: string,
  prefs: Partial<UserPreferences>,
): Promise<void> {
  const now = new Date();
  const db = globalThis.services.db;

  await db
    .insert(orgMembersCache)
    .values({
      clerkOrgId,
      userId,
      timezone: prefs.timezone ?? null,
      notifyEmail: prefs.notifyEmail ?? false,
      notifySlack: prefs.notifySlack ?? true,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.clerkOrgId, orgMembersCache.userId],
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
 * Dual-write preferences to Clerk metadata + local cache (fire-and-forget).
 */
async function dualWriteToClerk(
  scopeId: string,
  userId: string,
  prefs: { timezone?: string; notifyEmail?: boolean; notifySlack?: boolean },
  result: UserPreferences,
): Promise<void> {
  try {
    const [scope] = await globalThis.services.db
      .select({ clerkOrgId: scopes.clerkOrgId })
      .from(scopes)
      .where(eq(scopes.id, scopeId))
      .limit(1);

    if (scope) {
      const client = await clerkClient();
      await client.organizations.updateOrganizationMembershipMetadata({
        organizationId: scope.clerkOrgId,
        userId,
        publicMetadata: buildClerkMetadata(prefs),
      });

      await upsertMemberCache(scope.clerkOrgId, userId, result);
    }
  } catch (err) {
    log.error("Failed to write preferences to Clerk metadata", {
      error: err,
      userId,
    });
  }
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
  clerkOrgId: string,
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
  return getCachedMemberPreferences(clerkOrgId, userId);
}

/**
 * Update user preferences on scope_members (primary admin membership)
 */
export async function updateUserPreferences(
  userId: string,
  prefs: { timezone?: string; notifyEmail?: boolean; notifySlack?: boolean },
): Promise<UserPreferences> {
  if (prefs.timezone !== undefined) {
    if (!isValidTimezone(prefs.timezone)) {
      throw badRequest(`Invalid timezone: ${prefs.timezone}`);
    }
  }

  const memberRecord = await getPrimaryAdminMembership(userId);

  if (!memberRecord) {
    throw badRequest("User has no scope membership");
  }

  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (prefs.timezone !== undefined) {
    setValues.timezone = prefs.timezone;
  }
  if (prefs.notifyEmail !== undefined) {
    setValues.notifyEmail = prefs.notifyEmail;
  }
  if (prefs.notifySlack !== undefined) {
    setValues.notifySlack = prefs.notifySlack;
  }

  const [updated] = await globalThis.services.db
    .update(scopeMembers)
    .set(setValues)
    .where(eq(scopeMembers.id, memberRecord.id))
    .returning({
      timezone: scopeMembers.timezone,
      notifyEmail: scopeMembers.notifyEmail,
      notifySlack: scopeMembers.notifySlack,
    });

  const result: UserPreferences = {
    timezone: updated?.timezone ?? null,
    notifyEmail: updated?.notifyEmail ?? false,
    notifySlack: updated?.notifySlack ?? true,
  };

  await dualWriteToClerk(memberRecord.scopeId, userId, prefs, result);

  return result;
}

/**
 * Set user timezone if not already set (for auto-detection on first login)
 */
export async function setTimezoneIfNotSet(
  clerkOrgId: string,
  userId: string,
  timezone: string,
  sessionClaims?: CustomJwtSessionClaims,
): Promise<void> {
  if (!isValidTimezone(timezone)) {
    return; // Silently ignore invalid timezone during auto-detection
  }

  const { timezone: existingTimezone } = await getUserPreferences(
    clerkOrgId,
    userId,
    sessionClaims,
  );

  if (existingTimezone === null) {
    const memberRecord = await getPrimaryAdminMembership(userId);

    if (memberRecord) {
      await globalThis.services.db
        .update(scopeMembers)
        .set({
          timezone,
          updatedAt: new Date(),
        })
        .where(eq(scopeMembers.id, memberRecord.id));

      // Dual-write timezone to Clerk membership publicMetadata + local cache
      try {
        const client = await clerkClient();
        await client.organizations.updateOrganizationMembershipMetadata({
          organizationId: clerkOrgId,
          userId,
          publicMetadata: { timezone },
        });

        await upsertMemberCache(clerkOrgId, userId, { timezone });
      } catch (err) {
        log.error("Failed to write timezone to Clerk metadata", {
          error: err,
          userId,
        });
      }
    }
  }
}
