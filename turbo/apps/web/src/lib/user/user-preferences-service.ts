import { eq } from "drizzle-orm";
import { scopeMembers } from "../../db/schema/scope-member";
import { badRequest } from "../errors";
import { getPrimaryAdminMembership } from "../scope/scope-member-service";

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
    }
  }
}
