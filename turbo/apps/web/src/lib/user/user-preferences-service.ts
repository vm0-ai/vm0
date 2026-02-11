import { eq, and } from "drizzle-orm";
import { scopes } from "../../db/schema/scope";
import { badRequest } from "../errors";

interface UserPreferences {
  timezone: string | null;
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
    .select({ timezone: scopes.timezone })
    .from(scopes)
    .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")));

  return {
    timezone: scope?.timezone ?? null,
  };
}

/**
 * Update user preferences by Clerk user ID
 * Timezone is stored on the user's personal scope
 */
export async function updateUserPreferences(
  clerkUserId: string,
  prefs: { timezone?: string },
): Promise<UserPreferences> {
  if (prefs.timezone !== undefined) {
    if (!isValidTimezone(prefs.timezone)) {
      throw badRequest(`Invalid timezone: ${prefs.timezone}`);
    }
  }

  const [updated] = await globalThis.services.db
    .update(scopes)
    .set({
      timezone: prefs.timezone,
      updatedAt: new Date(),
    })
    .where(and(eq(scopes.ownerId, clerkUserId), eq(scopes.type, "personal")))
    .returning({ timezone: scopes.timezone });

  return {
    timezone: updated?.timezone ?? null,
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
