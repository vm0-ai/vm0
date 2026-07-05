import { Cron } from "croner";

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
 * Next run after a completion callback (the run finished, success or failure).
 * Cron advances from the cron expression captured at dispatch (null when the
 * one-time callback carried no expression); a loop advances by the trigger's
 * interval and requires one to be present. Disabling collapses the next run to
 * null.
 */
export function advanceTimeTriggerAfterCompletion(args: {
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
    throw new Error("Loop trigger is missing intervalSeconds");
  }
  return new Date(args.completedAt.getTime() + args.intervalSeconds * 1000);
}
