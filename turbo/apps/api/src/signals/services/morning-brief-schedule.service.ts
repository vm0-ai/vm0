import { morningBriefSchedules } from "@vm0/db/schema/morning-brief";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { calculateNextRun } from "./time-automation";

// Fixed product schedule: the brief always targets 7:00 in the member's
// local timezone.
const MORNING_BRIEF_CRON = "0 7 * * *";

/** Next 7:00 in the member's local timezone strictly after `from`. */
export function nextMorningBriefRunAt(timezone: string, from: Date): Date {
  const next = calculateNextRun(MORNING_BRIEF_CRON, timezone, from);
  if (!next) {
    throw new Error(`No next 7:00 occurrence for timezone ${timezone}`);
  }
  return next;
}

/** Member-local calendar date (YYYY-MM-DD) for `date`. */
export function morningBriefLocalDate(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * UTC instants of the member-local day containing the (delayed) fire time.
 * Anchored on local midnights so the calendar window matches "today" as the
 * member sees it.
 */
export function morningBriefDayBounds(
  timezone: string,
  currentTime: Date,
): { readonly dayStart: Date; readonly dayEnd: Date } {
  const midnightCron = "0 0 * * *";
  const dayEnd = calculateNextRun(midnightCron, timezone, currentTime);
  if (!dayEnd) {
    throw new Error(`No next midnight for timezone ${timezone}`);
  }
  const dayStart = calculateNextRun(
    midnightCron,
    timezone,
    new Date(dayEnd.getTime() - 26 * 60 * 60 * 1000),
  );
  if (!dayStart) {
    throw new Error(`No previous midnight for timezone ${timezone}`);
  }
  return { dayStart, dayEnd };
}

interface SyncMorningBriefScheduleArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly timezone: string | null;
  readonly enabled: boolean;
  readonly currentTime: Date;
}

/**
 * Reconcile the member's schedule row with the current preference state.
 * A reliable timezone plus an enabled preference schedules the next 7:00
 * local run; anything else pauses the schedule (next_run_at = null) while
 * keeping the row so re-enabling resumes without losing the thread binding.
 */
export async function syncMorningBriefSchedule(
  db: Db,
  args: SyncMorningBriefScheduleArgs,
): Promise<void> {
  const nextRunAt =
    args.enabled && args.timezone
      ? nextMorningBriefRunAt(args.timezone, args.currentTime)
      : null;

  if (nextRunAt) {
    await db
      .insert(morningBriefSchedules)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        nextRunAt,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoUpdate({
        target: [morningBriefSchedules.orgId, morningBriefSchedules.userId],
        set: { nextRunAt, updatedAt: args.currentTime },
      });
    return;
  }

  await db
    .update(morningBriefSchedules)
    .set({ nextRunAt: null, updatedAt: args.currentTime })
    .where(
      and(
        eq(morningBriefSchedules.orgId, args.orgId),
        eq(morningBriefSchedules.userId, args.userId),
      ),
    );
}
