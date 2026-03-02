// ---------------------------------------------------------------------------
// Shared cron expression utilities
// ---------------------------------------------------------------------------

export type ScheduleTimeOption =
  | "every-weekday"
  | "every-day"
  | "every-week"
  | "every-month";

export function buildCronExpression(opts: {
  timeOption: ScheduleTimeOption;
  hour: string;
  minute?: string;
  dayOfWeek?: string;
  dayOfMonth?: string;
}): string {
  const h = Number.parseInt(opts.hour, 10);
  const m = opts.minute !== undefined ? Number.parseInt(opts.minute, 10) : 0;
  switch (opts.timeOption) {
    case "every-weekday": {
      return `${String(m)} ${String(h)} * * 1-5`;
    }
    case "every-day": {
      return `${String(m)} ${String(h)} * * *`;
    }
    case "every-week": {
      const dow = opts.dayOfWeek ?? "1";
      return `${String(m)} ${String(h)} * * ${dow}`;
    }
    case "every-month": {
      const dom = opts.dayOfMonth ?? "1";
      return `${String(m)} ${String(h)} ${dom} * *`;
    }
  }
}
