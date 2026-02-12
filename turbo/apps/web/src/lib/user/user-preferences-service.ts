import { eq, and } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { badRequest } from "../errors";

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
 * Get user preferences by Clerk user ID
 * Timezone is stored on the user's personal scope
 */
export async function getUserPreferences(
  clerkUserId: string,
): Promise<UserPreferences> {
  const [scope] = await globalThis.services.db
    .select({
      timezone: scopes.timezone,
      notifyEmail: scopes.notifyEmail,
      notifySlack: scopes.notifySlack,
    })
    .from(scopes)
    .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")));

  return {
    timezone: scope?.timezone ?? null,
    notifyEmail: scope?.notifyEmail ?? false,
    notifySlack: scope?.notifySlack ?? true,
  };
}

/**
 * Update user preferences by Clerk user ID
 * Timezone is stored on the user's personal scope
 */
export async function updateUserPreferences(
  clerkUserId: string,
  prefs: { timezone?: string; notifyEmail?: boolean; notifySlack?: boolean },
): Promise<UserPreferences> {
  if (prefs.timezone !== undefined) {
    if (!isValidTimezone(prefs.timezone)) {
      throw badRequest(`Invalid timezone: ${prefs.timezone}`);
    }
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
    .update(scopes)
    .set(setValues)
    .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")))
    .returning({
      timezone: scopes.timezone,
      notifyEmail: scopes.notifyEmail,
      notifySlack: scopes.notifySlack,
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
  clerkUserId: string,
  timezone: string,
): Promise<void> {
  if (!isValidTimezone(timezone)) {
    return; // Silently ignore invalid timezone during auto-detection
  }

  const { timezone: existingTimezone } = await getUserPreferences(clerkUserId);

  if (existingTimezone === null) {
    await globalThis.services.db
      .update(scopes)
      .set({
        timezone,
        updatedAt: new Date(),
      })
      .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")));
  }
}
