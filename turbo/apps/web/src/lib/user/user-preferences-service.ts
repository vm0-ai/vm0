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
 * Get user preferences from scope_members (primary admin membership)
 */
export async function getUserPreferences(
  userId: string,
): Promise<UserPreferences> {
  const member = await getPrimaryAdminMembership(userId);

  return {
    timezone: member?.timezone ?? null,
    notifyEmail: member?.notifyEmail ?? false,
    notifySlack: member?.notifySlack ?? true,
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
  userId: string,
  timezone: string,
): Promise<void> {
  if (!isValidTimezone(timezone)) {
    return; // Silently ignore invalid timezone during auto-detection
  }

  const { timezone: existingTimezone } = await getUserPreferences(userId);

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
            publicMetadata: { timezone },
          });
        }
      } catch (err) {
        log.error("Failed to write timezone to Clerk metadata", {
          error: err,
          userId,
        });
      }
    }
  }
}
