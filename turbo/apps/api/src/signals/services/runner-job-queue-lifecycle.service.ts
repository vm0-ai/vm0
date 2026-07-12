import { sql, type SQL } from "drizzle-orm";

import { nowDate } from "../external/time";

interface RunnerJobQueueTimestamps {
  readonly createdAt: Date;
  readonly expiresAt: SQL;
}

/**
 * Capture the closest safe persisted approximation of queue availability.
 * The row is committed before notification, so this is insertion time rather
 * than commit, notification, or runner discovery time. The API clock owns the
 * telemetry/affinity boundary, while the database clock owns queue expiry.
 */
export function runnerJobQueueTimestamps(): RunnerJobQueueTimestamps {
  return {
    createdAt: nowDate(),
    expiresAt: sql`clock_timestamp() AT TIME ZONE 'UTC' + interval '2 hours'`,
  };
}
