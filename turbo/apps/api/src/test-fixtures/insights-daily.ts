/**
 * In-process test fixture for `insights_daily` day blobs.
 *
 * Daily insight rows are written only by the aggregate-insights cron, which
 * always emits the current schema for the current sweep window. The insight
 * read surfaces must stay compatible with historical blobs that the cron can
 * no longer produce — legacy `schedules`-keyed automation entries, sparse
 * rows missing sections, and rows on arbitrary past dates (the cron only
 * writes days inside its 25h sweep). This module is the narrow test-boundary
 * exception for that stored-shape compatibility coverage: it only inserts a
 * day row for an org/user/date.
 */
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { createStore } from "ccstate";

import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";

export async function insertInsightsDailyFixture(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly date: string;
  readonly data: Record<string, unknown>;
}): Promise<void> {
  await createStore().set(writeDb$).insert(insightsDaily).values({
    orgId: values.orgId,
    userId: values.userId,
    date: values.date,
    updatedAt: nowDate(),
    data: values.data,
  });
}
