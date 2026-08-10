import type { UsagePeriod } from "./usage-period";

const HOUR_MS = 3_600_000;

function ceilFinalizedUsageHour(value: Date): Date {
  return new Date(Math.ceil(value.getTime() / HOUR_MS) * HOUR_MS);
}

export function normalizeFinalizedUsagePeriod(
  period: UsagePeriod,
): UsagePeriod {
  return {
    start: ceilFinalizedUsageHour(period.start),
    end: ceilFinalizedUsageHour(period.end),
  };
}
