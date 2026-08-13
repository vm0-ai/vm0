import { agentRuns } from "@okouai/db/schema/agent-run";
import { zeroRuns } from "@okouai/db/schema/zero-run";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export type ChildAutonomyBudget =
  | { readonly kind: "ok"; readonly autonomyBudget: number }
  | { readonly kind: "exhausted" };

export function childAutonomyBudget(
  sourceAutonomyBudget: number,
): ChildAutonomyBudget {
  if (sourceAutonomyBudget === 0) {
    return { kind: "exhausted" };
  }
  return { kind: "ok", autonomyBudget: sourceAutonomyBudget - 1 };
}

export async function loadRunAutonomyBudget(
  db: ReadonlyDb,
  runId: string,
): Promise<number | null> {
  const [run] = await db
    .select({
      autonomyBudget: zeroRuns.autonomyBudget,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return run?.autonomyBudget ?? null;
}

export async function loadOwnedRunAutonomyBudget(
  db: ReadonlyDb,
  args: {
    readonly runId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<number | null> {
  const [run] = await db
    .select({
      autonomyBudget: zeroRuns.autonomyBudget,
    })
    .from(zeroRuns)
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.id, zeroRuns.id),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
      ),
    )
    .where(eq(zeroRuns.id, args.runId))
    .limit(1);
  return run?.autonomyBudget ?? null;
}
