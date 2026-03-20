import { eq, and } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
import { badRequest } from "../errors";
import { logger } from "../logger";

const log = logger("service:user-preferences");

/**
 * Safely extract a string array from an unknown jsonb/metadata value.
 * Returns [] if the value is not an array of strings.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

type SendMode = "enter" | "cmd-enter";

interface UserPreferences {
  timezone: string | null;
  notifyEmail: boolean;
  notifySlack: boolean;
  pinnedAgentIds: string[];
  sendMode: SendMode;
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
  notifyEmail: false,
  notifySlack: true,
  pinnedAgentIds: [],
  sendMode: "enter",
};

/**
 * Get user preferences from org_members table.
 * Returns defaults if no row exists (new member).
 *
 * // TODO(#5514): remove this fallback after full backfill
 * Falls back to Clerk membership publicMetadata if no DB row,
 * and lazy-migrates the value to DB on first access.
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
      notifyEmail: row.notifyEmail,
      notifySlack: row.notifySlack,
      pinnedAgentIds: toStringArray(row.pinnedAgentIds),
      sendMode: parseSendMode(row.sendMode),
    };
  }

  // TODO(#5514): remove this fallback after full backfill
  const client = await clerkClient();
  const { data: memberships } =
    await client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
    });

  const membership = memberships.find(
    (m) => m.publicUserData?.userId === userId,
  );
  const meta = membership?.publicMetadata as
    | Record<string, unknown>
    | undefined;

  if (meta && Object.keys(meta).length > 0) {
    const prefs: UserPreferences = {
      timezone: typeof meta.timezone === "string" ? meta.timezone : null,
      notifyEmail: meta.notify_email === true,
      notifySlack: meta.notify_slack !== false,
      pinnedAgentIds: toStringArray(meta.pinned_agent_ids),
      sendMode: parseSendMode(meta.send_mode),
    };

    const onboardingDone = meta.onboarding_done === true;

    log.info("lazy migration: org_members preferences from Clerk", {
      orgId,
      userId,
    });
    const now = new Date();
    await db
      .insert(orgMembersMetadata)
      .values({
        orgId,
        userId,
        timezone: prefs.timezone,
        notifyEmail: prefs.notifyEmail,
        notifySlack: prefs.notifySlack,
        pinnedAgentIds: prefs.pinnedAgentIds,
        sendMode: prefs.sendMode,
        onboardingDone,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .catch((err: unknown) =>
        log.warn("lazy migration: org_members write failed", {
          orgId,
          userId,
          err,
        }),
      );

    return prefs;
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
    notifyEmail?: boolean;
    notifySlack?: boolean;
    pinnedAgentIds?: string[];
    sendMode?: SendMode;
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
    notifyEmail:
      prefs.notifyEmail !== undefined
        ? prefs.notifyEmail
        : existing.notifyEmail,
    notifySlack:
      prefs.notifySlack !== undefined
        ? prefs.notifySlack
        : existing.notifySlack,
    pinnedAgentIds:
      prefs.pinnedAgentIds !== undefined
        ? prefs.pinnedAgentIds
        : existing.pinnedAgentIds,
    sendMode: prefs.sendMode !== undefined ? prefs.sendMode : existing.sendMode,
  };

  const now = new Date();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId,
      userId,
      timezone: merged.timezone,
      notifyEmail: merged.notifyEmail,
      notifySlack: merged.notifySlack,
      pinnedAgentIds: merged.pinnedAgentIds,
      sendMode: merged.sendMode,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        ...(prefs.timezone !== undefined && { timezone: prefs.timezone }),
        ...(prefs.notifyEmail !== undefined && {
          notifyEmail: prefs.notifyEmail,
        }),
        ...(prefs.notifySlack !== undefined && {
          notifySlack: prefs.notifySlack,
        }),
        ...(prefs.pinnedAgentIds !== undefined && {
          pinnedAgentIds: prefs.pinnedAgentIds,
        }),
        ...(prefs.sendMode !== undefined && { sendMode: prefs.sendMode }),
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
