import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { Cron } from "croner";
import { and, eq } from "drizzle-orm";

import type { Db } from "../../external/db";

type ScheduleRow = typeof zeroAgentSchedules.$inferSelect;

/**
 * Computes the next fire time for a cron expression in the given timezone,
 * starting the search from `fromDate`. Returns null when the expression has no
 * further occurrences.
 */
export function calculateNextRun(
  cronExpression: string,
  timezone: string,
  fromDate: Date,
): Date | null {
  return new Cron(cronExpression, { timezone }).nextRun(fromDate);
}

/**
 * Deploy-time recurrence inputs needed to resolve a trigger's type and first
 * run. A thin structural view of the deploy request so the trigger does not
 * depend on the contract type.
 */
interface TriggerSpec {
  readonly cronExpression?: string;
  readonly atTime?: string;
  readonly timezone: string;
  readonly enabled?: boolean;
}

/**
 * Resolved trigger shape for persistence at deploy time: the discriminating
 * trigger type and the first `nextRunAt` (null when nothing is scheduled, e.g. a
 * disabled loop).
 */
interface ResolvedTrigger {
  readonly triggerType: "cron" | "once" | "loop";
  readonly nextRunAt: Date | null;
}

/**
 * Time-based trigger: owns the scheduling math (next-run calculation and the
 * optimistic-lock claim) for `zero_agent_schedules` rows. The interpreter is
 * keyed off the Automation; this trigger is keyed off time and is the only
 * trigger implementation today (YAGNI — no registry).
 */
export class TimeTrigger {
  /**
   * Resolve the trigger type and first run from a deploy request. Cron resolves
   * to the next cron occurrence; a one-time `atTime` resolves to that instant; a
   * loop is due immediately when enabled, otherwise unscheduled.
   */
  resolve(spec: TriggerSpec, currentTime: Date): ResolvedTrigger {
    if (spec.cronExpression) {
      return {
        triggerType: "cron",
        nextRunAt: calculateNextRun(
          spec.cronExpression,
          spec.timezone,
          currentTime,
        ),
      };
    }
    if (spec.atTime) {
      return { triggerType: "once", nextRunAt: new Date(spec.atTime) };
    }
    return {
      triggerType: "loop",
      nextRunAt: spec.enabled ? currentTime : null,
    };
  }

  /**
   * Claim a due schedule row via an optimistic lock on `nextRunAt`: clear the
   * next run, stamp `lastRunAt`, reset any retry marker, and disable one-time
   * schedules. Returns the claimed row, or null when another invocation won the
   * race (the row's `nextRunAt` already moved).
   */
  async evaluate(args: {
    readonly db: Db;
    readonly schedule: ScheduleRow;
    readonly currentTime: Date;
  }): Promise<ScheduleRow | null> {
    const [claimed] = await args.db
      .update(zeroAgentSchedules)
      .set({
        nextRunAt: null,
        lastRunAt: args.currentTime,
        retryStartedAt: null,
        updatedAt: args.currentTime,
        ...(args.schedule.triggerType === "once" ? { enabled: false } : {}),
      })
      .where(
        and(
          eq(zeroAgentSchedules.id, args.schedule.id),
          eq(zeroAgentSchedules.nextRunAt, args.schedule.nextRunAt!),
        ),
      )
      .returning();
    return claimed ?? null;
  }

  /**
   * Next run after a pre-run failure in the poller (the run was never created).
   * Cron advances to the next occurrence; a loop advances by its interval when
   * one is set; one-time and interval-less loops do not reschedule. Disabling
   * collapses the next run to null.
   */
  advanceAfterPreRunFailure(args: {
    readonly schedule: ScheduleRow;
    readonly failureTime: Date;
    readonly shouldDisable: boolean;
  }): Date | null {
    if (args.shouldDisable) {
      return null;
    }
    if (args.schedule.triggerType === "cron" && args.schedule.cronExpression) {
      return calculateNextRun(
        args.schedule.cronExpression,
        args.schedule.timezone,
        args.failureTime,
      );
    }
    if (args.schedule.triggerType === "loop" && args.schedule.intervalSeconds) {
      return new Date(
        args.failureTime.getTime() + args.schedule.intervalSeconds * 1000,
      );
    }
    return null;
  }

  /**
   * Next run after a completion callback (the run finished, success or failure).
   * Cron advances from the cron expression captured at dispatch (null when the
   * one-time callback carried no expression); a loop advances by the schedule's
   * interval and requires one to be present. Disabling collapses the next run to
   * null.
   */
  advanceAfterCompletion(args: {
    readonly triggerType: "cron" | "loop";
    readonly cronExpression: string | undefined;
    readonly intervalSeconds: number | null;
    readonly timezone: string;
    readonly completedAt: Date;
    readonly shouldDisable: boolean;
  }): Date | null {
    if (args.shouldDisable) {
      return null;
    }
    if (args.triggerType === "cron") {
      return args.cronExpression
        ? calculateNextRun(args.cronExpression, args.timezone, args.completedAt)
        : null;
    }
    if (args.intervalSeconds === null) {
      throw new Error("Loop schedule is missing intervalSeconds");
    }
    return new Date(args.completedAt.getTime() + args.intervalSeconds * 1000);
  }
}
