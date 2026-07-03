import { runnerState } from "@vm0/db/schema/runner-state";
import { and, eq, gt, sql } from "drizzle-orm";

import type { Db } from "../external/db";

const RUNNER_SESSION_AFFINITY_PROTECTION_MS = 2000;
const RUNNER_SESSION_AFFINITY_HOLDER_FRESH_MS = 30_000;

type RunnerSessionAffinityStatus =
  | "no_session"
  | "expired"
  | "protected"
  | "no_viable_holder"
  | "lookup_error";

interface RunnerSessionAffinityProtection {
  readonly protectedUntil: Date | null;
  readonly status: RunnerSessionAffinityStatus;
}

export function runnerSessionAffinityLookupError(): RunnerSessionAffinityProtection {
  return {
    protectedUntil: null,
    status: "lookup_error",
  };
}

function affinityProtectedUntil(
  cliAgentSessionId: string | null,
  createdAt: Date,
): Date | null {
  if (!cliAgentSessionId) {
    return null;
  }
  return new Date(createdAt.getTime() + RUNNER_SESSION_AFFINITY_PROTECTION_MS);
}

export async function runnerSessionAffinityProtection(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly createdAt: Date;
  readonly currentDate: Date;
}): Promise<RunnerSessionAffinityProtection> {
  const protectedUntil = affinityProtectedUntil(
    args.cliAgentSessionId,
    args.createdAt,
  );
  if (!args.cliAgentSessionId) {
    return { protectedUntil: null, status: "no_session" };
  }
  if (!protectedUntil || protectedUntil <= args.currentDate) {
    return { protectedUntil: null, status: "expired" };
  }

  const freshAfter = new Date(
    args.currentDate.getTime() - RUNNER_SESSION_AFFINITY_HOLDER_FRESH_MS,
  );
  const heldSessionProbe = JSON.stringify([
    { sessionId: args.cliAgentSessionId },
  ]);
  const availableProfileProbe = JSON.stringify([args.profile]);
  const [holder] = await args.db
    .select({ runnerId: runnerState.runnerId })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, args.runnerGroup),
        eq(runnerState.mode, "running"),
        gt(runnerState.lastSeenAt, freshAfter),
        sql`${runnerState.heldSessionStates} @> ${heldSessionProbe}::jsonb`,
        sql`${runnerState.availableProfiles} @> ${availableProfileProbe}::jsonb`,
      ),
    )
    .limit(1);

  if (!holder) {
    return { protectedUntil: null, status: "no_viable_holder" };
  }

  return { protectedUntil, status: "protected" };
}
