import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import { and, eq, gt, sql, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";

const RUNNER_SESSION_AFFINITY_PROTECTION_MS = 2000;
const RUNNER_HISTORY_GENERATION_AFFINITY_PROTECTION_MS = Math.min(
  500,
  RUNNER_SESSION_AFFINITY_PROTECTION_MS,
);
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
  const generationProtectedAfter = new Date(
    args.currentDate.getTime() -
      RUNNER_HISTORY_GENERATION_AFFINITY_PROTECTION_MS,
  );
  const freshAfter = runnerSessionAffinityHolderFreshAfter(args.currentDate);
  const targetGenerationRunId = sql<
    string | null
  >`${runnerJobQueue.executionContext}->'resumeSession'->>'historyGenerationRunId'`;
  return sql<number>`CASE
    WHEN ${runnerJobQueue.createdAt} > ${generationProtectedAfter}
    AND ${runnerJobQueue.cliAgentSessionId} IS NOT NULL
    AND ${targetGenerationRunId} IS NOT NULL
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
              'profile', ${runnerJobQueue.profile},
              'historyGenerationRunId', ${targetGenerationRunId}
            )
          )
        )
    )
    THEN 2
    WHEN ${runnerJobQueue.createdAt} > ${protectedAfter}
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
    THEN 1
    ELSE 0
  END`;
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
  readonly historyGenerationProtectedUntil: Date | null;
  readonly historyGenerationStatus: RunnerHistoryGenerationAffinityStatus;
}

type RunnerHistoryGenerationAffinityStatus =
  | "no_session"
  | "no_target"
  | "expired"
  | "protected"
  | "no_exact_holder"
  | "lookup_error";

export function runnerSessionAffinityLookupError(): RunnerSessionAffinityProtection {
  return {
    protectedUntil: null,
    status: "lookup_error",
    historyGenerationProtectedUntil: null,
    historyGenerationStatus: "lookup_error",
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

function historyGenerationAffinityProtectedUntil(args: {
  readonly cliAgentSessionId: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
}): Date | null {
  if (!args.cliAgentSessionId || !args.historyGenerationRunId) {
    return null;
  }
  return new Date(
    args.createdAt.getTime() + RUNNER_HISTORY_GENERATION_AFFINITY_PROTECTION_MS,
  );
}

export async function runnerSessionAffinityProtection(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
  readonly currentDate: Date;
}): Promise<RunnerSessionAffinityProtection> {
  const protectedUntil = affinityProtectedUntil(
    args.cliAgentSessionId,
    args.createdAt,
  );
  const historyGenerationProtectedUntil =
    historyGenerationAffinityProtectedUntil(args);
  if (!args.cliAgentSessionId) {
    return {
      protectedUntil: null,
      status: "no_session",
      historyGenerationProtectedUntil: null,
      historyGenerationStatus: "no_session",
    };
  }
  if (!protectedUntil || protectedUntil <= args.currentDate) {
    return {
      protectedUntil: null,
      status: "expired",
      historyGenerationProtectedUntil: null,
      historyGenerationStatus: args.historyGenerationRunId
        ? "expired"
        : "no_target",
    };
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
  const shouldLookUpExactGeneration =
    historyGenerationProtectedUntil !== null &&
    historyGenerationProtectedUntil > args.currentDate;
  const exactGenerationProbe = shouldLookUpExactGeneration
    ? JSON.stringify([
        {
          sessionId: args.cliAgentSessionId,
          reusableSandbox: {
            profile: args.profile,
            historyGenerationRunId: args.historyGenerationRunId,
          },
        },
      ])
    : null;
  const admittableProfileProbe = JSON.stringify([args.profile]);
  const sessionHolderCondition = sql<boolean>`(
    (
      ${runnerState.heldSessionStates} @> ${heldSessionProbe}::jsonb
      AND ${runnerState.admittableProfiles} @> ${admittableProfileProbe}::jsonb
    )
    OR ${runnerState.heldSessionStates} @> ${reusableSessionProbe}::jsonb
  )`;
  const exactGenerationHolderCondition = exactGenerationProbe
    ? sql<boolean>`${runnerState.heldSessionStates} @> ${exactGenerationProbe}::jsonb`
    : sql<boolean>`false`;
  const [holders] = await args.db
    .select({
      hasSessionHolder: sql<boolean>`coalesce(bool_or(${sessionHolderCondition}), false)`,
      hasExactGenerationHolder: sql<boolean>`coalesce(bool_or(${exactGenerationHolderCondition}), false)`,
    })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, args.runnerGroup),
        eq(runnerState.mode, "running"),
        gt(runnerState.lastSeenAt, freshAfter),
        sessionHolderCondition,
      ),
    );

  const hasSessionHolder = holders?.hasSessionHolder ?? false;
  const hasExactGenerationHolder = holders?.hasExactGenerationHolder ?? false;
  const historyGenerationStatus: RunnerHistoryGenerationAffinityStatus =
    !args.historyGenerationRunId
      ? "no_target"
      : !shouldLookUpExactGeneration
        ? "expired"
        : hasExactGenerationHolder
          ? "protected"
          : "no_exact_holder";

  return {
    protectedUntil: hasSessionHolder ? protectedUntil : null,
    status: hasSessionHolder ? "protected" : "no_viable_holder",
    historyGenerationProtectedUntil: hasExactGenerationHolder
      ? historyGenerationProtectedUntil
      : null,
    historyGenerationStatus,
  };
}
