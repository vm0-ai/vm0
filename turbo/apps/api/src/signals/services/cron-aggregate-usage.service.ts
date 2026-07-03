import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageDaily } from "@vm0/db/schema/usage-daily";
import { command } from "ccstate";
import { sql } from "drizzle-orm";

import { nowDate } from "../external/time";
import { writeDb$ } from "../external/db";

interface AggregateUsageResult {
  readonly date: string;
  readonly aggregated: number;
}

export const aggregateUsageDaily$ = command(
  async ({ set }, signal: AbortSignal): Promise<AggregateUsageResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const yesterday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
    );
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const targetDate = yesterday.toISOString().split("T")[0]!;

    const result = await db.execute(sql`
      INSERT INTO ${usageDaily} (user_id, org_id, date, run_count, run_time_ms)
      SELECT
        ${agentRuns.userId},
        ${agentRuns.orgId},
        ${targetDate}::date,
        COUNT(*)::int,
        COALESCE(SUM(EXTRACT(EPOCH FROM (${agentRuns.completedAt} - ${agentRuns.startedAt})) * 1000), 0)::bigint
      FROM ${agentRuns}
      WHERE ${agentRuns.createdAt} >= ${yesterday}
        AND ${agentRuns.createdAt} < ${today}
        AND ${agentRuns.completedAt} IS NOT NULL
      GROUP BY ${agentRuns.userId}, ${agentRuns.orgId}
      ON CONFLICT (user_id, org_id, date) DO UPDATE SET
        run_count = EXCLUDED.run_count,
        run_time_ms = EXCLUDED.run_time_ms,
        updated_at = NOW()
    `);
    signal.throwIfAborted();

    return {
      date: targetDate,
      aggregated: result.rowCount ?? 0,
    };
  },
);
