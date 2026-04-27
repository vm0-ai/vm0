import { eq, and, gt, sql } from "drizzle-orm";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { badRequest } from "@vm0/api-services/errors";
import { logger } from "../../shared/logger";

const log = logger("service:user-preferences");

/**
 * Safely extract a string array from an unknown jsonb/metadata value.
 * Returns [] if the value is not an array of strings.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => {
    return typeof item === "string";
  });
}

type SendMode = "enter" | "cmd-enter";

interface UserPreferences {
  timezone: string | null;
  pinnedAgentIds: string[];
  sendMode: SendMode;
  captureNetworkBodiesRemaining: number;
}

function parseSendMode(value: unknown): SendMode {
  return value === "cmd-enter" ? "cmd-enter" : "enter";
}

function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const DEFAULTS: UserPreferences = {
  timezone: null,
  pinnedAgentIds: [],
  sendMode: "enter",
  captureNetworkBodiesRemaining: 0,
};

/**
 * Get user preferences from org_members table.
 * Returns defaults if no row exists (new member).
 */
export async function getUserPreferences(
  orgId: string,
  userId: string,
): Promise<UserPreferences> {
  const db = globalThis.services.db;

  const [row] = await db
    .select()
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  if (row) {
    return {
      timezone: row.timezone,
      pinnedAgentIds: toStringArray(row.pinnedAgentIds),
      sendMode: parseSendMode(row.sendMode),
      captureNetworkBodiesRemaining: row.captureNetworkBodiesRemaining ?? 0,
    };
  }

  return { ...DEFAULTS };
}

/**
 * Update user preferences in org_members table.
 */
export async function updateUserPreferences(
  orgId: string,
  userId: string,
  prefs: {
    timezone?: string;
    pinnedAgentIds?: string[];
    sendMode?: SendMode;
    captureNetworkBodiesRemaining?: number;
  },
): Promise<UserPreferences> {
  if (prefs.timezone !== undefined) {
    if (!isValidTimezone(prefs.timezone)) {
      throw badRequest(`Invalid timezone: ${prefs.timezone}`);
    }
  }

  const db = globalThis.services.db;
  const existing = await getUserPreferences(orgId, userId);

  const merged: UserPreferences = {
    timezone: prefs.timezone !== undefined ? prefs.timezone : existing.timezone,
    pinnedAgentIds:
      prefs.pinnedAgentIds !== undefined
        ? prefs.pinnedAgentIds
        : existing.pinnedAgentIds,
    sendMode: prefs.sendMode !== undefined ? prefs.sendMode : existing.sendMode,
    captureNetworkBodiesRemaining:
      prefs.captureNetworkBodiesRemaining !== undefined
        ? prefs.captureNetworkBodiesRemaining
        : existing.captureNetworkBodiesRemaining,
  };

  const now = new Date();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId,
      userId,
      timezone: merged.timezone,
      pinnedAgentIds: merged.pinnedAgentIds,
      sendMode: merged.sendMode,
      captureNetworkBodiesRemaining: merged.captureNetworkBodiesRemaining,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        ...(prefs.timezone !== undefined && { timezone: prefs.timezone }),
        ...(prefs.pinnedAgentIds !== undefined && {
          pinnedAgentIds: prefs.pinnedAgentIds,
        }),
        ...(prefs.sendMode !== undefined && { sendMode: prefs.sendMode }),
        ...(prefs.captureNetworkBodiesRemaining !== undefined && {
          captureNetworkBodiesRemaining: prefs.captureNetworkBodiesRemaining,
        }),
        updatedAt: now,
      },
    });

  log.debug("org_members preferences updated", { orgId, userId });

  return merged;
}

/**
 * Set user timezone if not already set (for auto-detection on first login).
 */
export async function setTimezoneIfNotSet(
  orgId: string,
  userId: string,
  timezone: string,
): Promise<void> {
  if (!isValidTimezone(timezone)) {
    return; // Silently ignore invalid timezone during auto-detection
  }

  const { timezone: existingTimezone } = await getUserPreferences(
    orgId,
    userId,
  );

  if (existingTimezone === null) {
    await updateUserPreferences(orgId, userId, { timezone });
  }
}

/**
 * Atomically check and decrement captureNetworkBodiesRemaining.
 * Returns true if a capture quota was consumed (remaining was > 0).
 */
export async function consumeCaptureNetworkBodies(
  orgId: string,
  userId: string,
): Promise<boolean> {
  const db = globalThis.services.db;

  const result = await db
    .update(orgMembersMetadata)
    .set({
      captureNetworkBodiesRemaining: sql`${orgMembersMetadata.captureNetworkBodiesRemaining} - 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
        gt(orgMembersMetadata.captureNetworkBodiesRemaining, 0),
      ),
    )
    .returning({ remaining: orgMembersMetadata.captureNetworkBodiesRemaining });

  return result.length > 0;
}
