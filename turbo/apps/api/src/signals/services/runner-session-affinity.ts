import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import { and, eq, gt, or, sql, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";

const RUNNER_SESSION_AFFINITY_PROTECTION_MS = 2000;
const RUNNER_SESSION_AFFINITY_HOLDER_FRESH_MS = 30_000;

function runnerSessionAffinityHolderFreshAfter(currentDate: Date): Date {
  return new Date(
    currentDate.getTime() - RUNNER_SESSION_AFFINITY_HOLDER_FRESH_MS,
  );
}

export function runnerReusableSessionPollPriority(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly currentDate: Date;
}): SQL<number> {
  const protectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_SESSION_AFFINITY_PROTECTION_MS,
  );
  const freshAfter = runnerSessionAffinityHolderFreshAfter(args.currentDate);
  return sql<number>`CASE WHEN
    ${runnerJobQueue.createdAt} > ${protectedAfter}
    AND EXISTS (
      SELECT 1
      FROM ${runnerState}
      WHERE ${runnerState.runnerId} = ${args.runnerId}
        AND ${runnerState.runnerGroup} = ${args.runnerGroup}
        AND ${runnerState.mode} = 'running'
        AND ${runnerState.lastSeenAt} > ${freshAfter}
        AND ${runnerState.heldSessionStates} @> jsonb_build_array(
          jsonb_build_object(
            'sessionId', ${runnerJobQueue.cliAgentSessionId},
            'reusableSandbox', jsonb_build_object(
              'profile', ${runnerJobQueue.profile}
            )
          )
        )
    )
    THEN 1 ELSE 0 END`;
}

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

  const freshAfter = runnerSessionAffinityHolderFreshAfter(args.currentDate);
  const heldSessionProbe = JSON.stringify([
    { sessionId: args.cliAgentSessionId },
  ]);
  const reusableSessionProbe = JSON.stringify([
    {
      sessionId: args.cliAgentSessionId,
      reusableSandbox: { profile: args.profile },
    },
  ]);
  const admittableProfileProbe = JSON.stringify([args.profile]);
  const [holder] = await args.db
    .select({ runnerId: runnerState.runnerId })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, args.runnerGroup),
        eq(runnerState.mode, "running"),
        gt(runnerState.lastSeenAt, freshAfter),
        or(
          and(
            sql`${runnerState.heldSessionStates} @> ${heldSessionProbe}::jsonb`,
            sql`${runnerState.admittableProfiles} @> ${admittableProfileProbe}::jsonb`,
          ),
          sql`${runnerState.heldSessionStates} @> ${reusableSessionProbe}::jsonb`,
        ),
      ),
    )
    .limit(1);

  if (!holder) {
    return { protectedUntil: null, status: "no_viable_holder" };
  }

  return { protectedUntil, status: "protected" };
}
