import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { and, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "../external/db";

interface OrgUserPair {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * Load each member's preferred timezone, keyed by `${orgId}:${userId}`.
 * Members without an explicit timezone are omitted; callers fall back to UTC.
 */
export async function resolveUserTimezones(
  db: Db,
  orgUserPairs: readonly OrgUserPair[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  if (orgUserPairs.length === 0) {
    return new Map();
  }

  const userIds = [
    ...new Set(
      orgUserPairs.map((pair) => {
        return pair.userId;
      }),
    ),
  ];

  const rows = await db
    .select({
      orgId: orgMembersMetadata.orgId,
      userId: orgMembersMetadata.userId,
      timezone: orgMembersMetadata.timezone,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        inArray(orgMembersMetadata.userId, userIds),
        isNotNull(orgMembersMetadata.timezone),
      ),
    );
  signal.throwIfAborted();

  const tzMap = new Map<string, string>();
  for (const row of rows) {
    if (row.timezone) {
      tzMap.set(`${row.orgId}:${row.userId}`, row.timezone);
    }
  }
  return tzMap;
}

/**
 * UTC instant of the most recent local-midnight in `timezone` at or before
 * `now` (the start of the user's current local day).
 */
function getLocalDayStartUtc(timezone: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const localMidnight = new Date(`${parts}T00:00:00`);
  const utcStr = localMidnight.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = localMidnight.toLocaleString("en-US", { timeZone: timezone });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  const offsetMs = utcDate.getTime() - tzDate.getTime();
  return new Date(localMidnight.getTime() + offsetMs);
}

/**
 * The calendar date (YYYY-MM-DD) of `instant` in `timezone`.
 */
export function localDateLabel(timezone: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * The UTC instant of local midnight for `dateLabel` (YYYY-MM-DD) in `timezone`.
 *
 * Unlike `getLocalDayStartUtc`, this never re-parses a formatted string as a
 * machine-local date, so it is stable regardless of the host's `TZ` and safe to
 * call repeatedly while walking a range of calendar days.
 */
export function localMidnightUtc(timezone: string, dateLabel: string): Date {
  // Anchor: treat the label as a UTC wall-clock, then measure how far that
  // instant's wall-clock in `timezone` differs from UTC and correct for it.
  const anchor = new Date(`${dateLabel}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(anchor);
  const get = (type: string): number => {
    const value = parts.find((part) => {
      return part.type === type;
    })?.value;
    return Number(value);
  };
  const asUtcOfLocalParts = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = asUtcOfLocalParts - anchor.getTime();
  return new Date(anchor.getTime() - offsetMs);
}

/**
 * Calendar date label (YYYY-MM-DD) and UTC window for the user's local "today
 * so far": from local midnight to `now`.
 */
export function getLocalToday(
  timezone: string,
  now: Date,
): {
  readonly targetDate: string;
  readonly dayStart: Date;
  readonly dayEnd: Date;
} {
  const dayStart = getLocalDayStartUtc(timezone, now);
  const targetDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { targetDate, dayStart, dayEnd: now };
}
