/**
 * In-process fixtures for compacted usage history.
 *
 * Production hourly rows are created only by the later compactor. Reader and
 * account-cleanup tests seed the final immutable representation directly.
 */
import { createStore } from "ccstate";
import { count, eq } from "drizzle-orm";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usageEventHourly } from "@vm0/db/schema/usage-event-hourly";

import { writeDb$ } from "../signals/external/db";

interface UsageEventHourlyFixture {
  readonly processedHour: Date;
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string | null;
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly creditsCharged: number;
  readonly allowanceUnits: number;
  readonly sourceEventCount: number;
  readonly maxProcessedAt: Date;
}

interface UsageEventStorageCounts {
  readonly raw: number;
  readonly hourly: number;
}

export async function insertUsageEventHourlyFixture(
  values: UsageEventHourlyFixture,
): Promise<string> {
  const [row] = await createStore()
    .set(writeDb$)
    .insert(usageEventHourly)
    .values(values)
    .returning({ id: usageEventHourly.id });
  if (!row) {
    throw new Error("Expected hourly usage fixture insertion to return an ID");
  }
  return row.id;
}

export async function countUsageEventStorageByOrgFixture(
  orgId: string,
): Promise<UsageEventStorageCounts> {
  const db = createStore().set(writeDb$);
  const [[raw], [hourly]] = await Promise.all([
    db
      .select({ count: count() })
      .from(usageEvent)
      .where(eq(usageEvent.orgId, orgId)),
    db
      .select({ count: count() })
      .from(usageEventHourly)
      .where(eq(usageEventHourly.orgId, orgId)),
  ]);
  return {
    raw: raw?.count ?? 0,
    hourly: hourly?.count ?? 0,
  };
}

export async function countUsageEventStorageByUserFixture(
  userId: string,
): Promise<UsageEventStorageCounts> {
  const db = createStore().set(writeDb$);
  const [[raw], [hourly]] = await Promise.all([
    db
      .select({ count: count() })
      .from(usageEvent)
      .where(eq(usageEvent.userId, userId)),
    db
      .select({ count: count() })
      .from(usageEventHourly)
      .where(eq(usageEventHourly.userId, userId)),
  ]);
  return {
    raw: raw?.count ?? 0,
    hourly: hourly?.count ?? 0,
  };
}
