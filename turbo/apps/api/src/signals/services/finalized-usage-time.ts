const HOUR_MS = 3_600_000;

interface UsageTimePeriod {
  readonly start: Date;
  readonly end: Date;
}

export function ceilFinalizedUsageHour(value: Date): Date {
  return new Date(Math.ceil(value.getTime() / HOUR_MS) * HOUR_MS);
}

export function normalizeFinalizedUsagePeriod(
  period: UsageTimePeriod,
): UsageTimePeriod {
  return {
    start: ceilFinalizedUsageHour(period.start),
    end: ceilFinalizedUsageHour(period.end),
  };
}
