import { usageAllowanceAllocations } from "@vm0/db/schema/org-usage-allowance";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usageEventHourly } from "@vm0/db/schema/usage-event-hourly";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";

const FINALIZED_USAGE_RELATION_ALIAS = "finalized_usage";

interface FinalizedUsageBounds {
  readonly start?: Date;
  readonly end?: Date;
}

export function buildFinalizedUsageRelation(bounds?: FinalizedUsageBounds) {
  const queryBuilder = new QueryBuilder();
  const rawRows = queryBuilder
    .select({
      processedHour: sql`date_trunc('hour', ${usageEvent.processedAt})`
        .mapWith(usageEvent.processedAt)
        .as("processed_hour"),
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      runId: usageEvent.runId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      shortWindowId: usageAllowanceAllocations.shortWindowId,
      weeklyWindowId: usageAllowanceAllocations.weeklyWindowId,
      quantity: usageEvent.quantity,
      creditsCharged: sql`COALESCE(${usageEvent.creditsCharged}, 0)::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits_charged"),
      allowanceUnits:
        sql`COALESCE(${usageAllowanceAllocations.unitsApplied}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("allowance_units"),
    })
    .from(usageEvent)
    .leftJoin(
      usageAllowanceAllocations,
      eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
    )
    .where(
      and(
        eq(usageEvent.status, "processed"),
        isNotNull(usageEvent.processedAt),
        bounds?.start ? gte(usageEvent.processedAt, bounds.start) : undefined,
        bounds?.end ? lt(usageEvent.processedAt, bounds.end) : undefined,
      ),
    );
  const hourlyRows = queryBuilder
    .select({
      processedHour: usageEventHourly.processedHour,
      orgId: usageEventHourly.orgId,
      userId: usageEventHourly.userId,
      runId: usageEventHourly.runId,
      kind: usageEventHourly.kind,
      provider: usageEventHourly.provider,
      category: usageEventHourly.category,
      shortWindowId: usageEventHourly.shortWindowId,
      weeklyWindowId: usageEventHourly.weeklyWindowId,
      quantity: usageEventHourly.quantity,
      creditsCharged: usageEventHourly.creditsCharged,
      allowanceUnits: usageEventHourly.allowanceUnits,
    })
    .from(usageEventHourly)
    .where(
      and(
        bounds?.start
          ? gte(usageEventHourly.processedHour, bounds.start)
          : undefined,
        bounds?.end
          ? lt(usageEventHourly.processedHour, bounds.end)
          : undefined,
      ),
    );

  return rawRows.unionAll(hourlyRows).as(FINALIZED_USAGE_RELATION_ALIAS);
}

export type FinalizedUsageRelation = ReturnType<
  typeof buildFinalizedUsageRelation
>;
