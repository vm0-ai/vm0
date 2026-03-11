import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { scopeMembers } from "../../db/schema/scope-member";
import { scopes } from "../../db/schema/scope";
import { badRequest } from "../errors";
import { getPrimaryAdminMembership } from "../scope/scope-member-service";
import { logger } from "../logger";

const log = logger("service:user-preferences");

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
 * Get user preferences from Clerk membership metadata.
 *
 * Fast path: when sessionClaims are provided (JWT context), reads from
 * Clerk membership JWT claims — zero DB/API calls.
 *
 * Fallback: when no claims (cron, run-builder, CLI tokens), reads from
 * Clerk membership publicMetadata via Clerk API.
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

  // Clerk API fallback: read membership publicMetadata
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

  return {
    timezone: typeof meta?.timezone === "string" ? meta.timezone : null,
    notifyEmail:
      typeof meta?.notify_email === "boolean" ? meta.notify_email : false,
    notifySlack:
      typeof meta?.notify_slack === "boolean" ? meta.notify_slack : true,
  };
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

  // Dual-write preferences to Clerk membership publicMetadata (fire-and-forget)
  try {
    const [scope] = await globalThis.services.db
      .select({ clerkOrgId: scopes.clerkOrgId })
      .from(scopes)
      .where(eq(scopes.id, memberRecord.scopeId))
      .limit(1);

    if (scope) {
      const client = await clerkClient();
      await client.organizations.updateOrganizationMembershipMetadata({
        organizationId: scope.clerkOrgId,
        userId,
        publicMetadata: {
          ...(prefs.timezone !== undefined && { timezone: prefs.timezone }),
          ...(prefs.notifyEmail !== undefined && {
            notify_email: prefs.notifyEmail,
          }),
          ...(prefs.notifySlack !== undefined && {
            notify_slack: prefs.notifySlack,
          }),
        },
      });
    }
  } catch (err) {
    log.error("Failed to write preferences to Clerk metadata", {
      error: err,
      userId,
    });
  }

  return {
    timezone: updated?.timezone ?? null,
    notifyEmail: updated?.notifyEmail ?? false,
    notifySlack: updated?.notifySlack ?? true,
  };
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

      // Dual-write timezone to Clerk membership publicMetadata (fire-and-forget)
      try {
        const client = await clerkClient();
        await client.organizations.updateOrganizationMembershipMetadata({
          organizationId: clerkOrgId,
          userId,
          publicMetadata: { timezone },
        });
      } catch (err) {
        log.error("Failed to write timezone to Clerk metadata", {
          error: err,
          userId,
        });
      }
    }
  }
}
