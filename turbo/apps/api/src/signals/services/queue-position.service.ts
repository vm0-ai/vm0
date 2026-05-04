import { computed, type Computed } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { and, eq, lte } from "drizzle-orm";

import { db$ } from "../external/db";

interface QueuePosition {
  readonly position: number;
  readonly total: number;
}

interface QueuePositionArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId?: string;
}

export function queuePosition(
  args: QueuePositionArgs,
): Computed<Promise<QueuePosition | null>> {
  return computed(async (get): Promise<QueuePosition | null> => {
    const db = get(db$);
    const [run] = await db
      .select({ id: agentRuns.id, orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          ...(args.orgId ? [eq(agentRuns.orgId, args.orgId)] : []),
        ),
      )
      .limit(1);

    if (!run) {
      return null;
    }

    const [entry] = await db
      .select({ createdAt: agentRunQueue.createdAt })
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, args.runId))
      .limit(1);

    if (!entry) {
      return { position: 0, total: 0 };
    }

    const ahead = await db
      .select({ runId: agentRunQueue.runId })
      .from(agentRunQueue)
      .where(
        and(
          eq(agentRunQueue.orgId, run.orgId),
          lte(agentRunQueue.createdAt, entry.createdAt),
        ),
      );

    return {
      position: ahead.length,
      total: ahead.length,
    };
  });
}
