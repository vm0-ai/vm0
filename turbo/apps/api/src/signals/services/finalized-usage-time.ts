const HOUR_MS = 3_600_000;

interface UsageTimePeriod {
  readonly start: Date;
  readonly end: Date;
}

export function ceilFinalizedUsageHour(value: Date): Date {
  return new Date(Math.ceil(value.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Assigns every UTC-hour fact wholly to one half-open reporting window.
 * Already aligned bounds are unchanged, and exact raw timestamps have the
 * same membership as their projected hour once both bounds are aligned.
 */
export function normalizeFinalizedUsagePeriod(
  period: UsageTimePeriod,
): UsageTimePeriod {
  return {
    start: ceilFinalizedUsageHour(period.start),
    end: ceilFinalizedUsageHour(period.end),
  };
}
