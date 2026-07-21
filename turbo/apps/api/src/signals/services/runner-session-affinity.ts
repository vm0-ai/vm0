import type { SessionAffinityResource } from "@vm0/api-contracts/contracts/runners";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import {
  and,
  eq,
  gt,
  isNotNull,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
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

function reusableSandboxCondition(args: {
  readonly sessionId: SQLWrapper;
  readonly profile: SQLWrapper;
  readonly historyGenerationRunId?: SQLWrapper;
}): SQL {
  const reusableSandbox =
    args.historyGenerationRunId !== undefined
      ? sql`jsonb_build_object(
        'profile', cast(${args.profile} as text),
        'historyGenerationRunId', cast(${args.historyGenerationRunId} as text)
      )`
      : sql`jsonb_build_object('profile', cast(${args.profile} as text))`;
  return sql`${runnerState.heldSessionStates} @> jsonb_build_array(
    jsonb_build_object(
      'sessionId', cast(${args.sessionId} as text),
      'reusableSandbox', ${reusableSandbox}
    )
  )`;
}

function capableWorkspaceCondition(args: {
  readonly sessionId: SQLWrapper;
  readonly profile: SQLWrapper;
}): SQL {
  return sql`(
    ${runnerState.heldSessionStates} @> jsonb_build_array(
      jsonb_build_object(
        'sessionId', cast(${args.sessionId} as text),
        'workspaceCaches', jsonb_build_array(
          jsonb_build_object(
            'profile', cast(${args.profile} as text),
            'workspaceAffinityVersion', 1
          )
        )
      )
    )
    AND ${runnerState.admittableProfiles} @> jsonb_build_array(
      cast(${args.profile} as text)
    )
  )`;
}

function runnerStateHas(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly freshAfter: Date;
  readonly resourceCondition: SQL;
}): SQL {
  const runnerCondition = args.runnerId
    ? sql`AND ${eq(runnerState.runnerId, args.runnerId)}`
    : sql``;
  return sql`EXISTS (
    SELECT 1
    FROM ${runnerState}
    WHERE ${eq(runnerState.runnerGroup, args.runnerGroup)}
      ${runnerCondition}
      AND ${runnerState.mode} = 'running'
      AND ${gt(runnerState.lastSeenAt, args.freshAfter)}
      AND ${args.resourceCondition}
  )`;
}

export function runnerSessionAffinityPollPriority(args: {
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly currentDate: Date;
}): SQL {
  const protectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_SESSION_AFFINITY_PROTECTION_MS,
  );
  const generationProtectedAfter = new Date(
    args.currentDate.getTime() -
      RUNNER_HISTORY_GENERATION_AFFINITY_PROTECTION_MS,
  );
  const freshAfter = runnerSessionAffinityHolderFreshAfter(args.currentDate);
  const targetGenerationRunId = sql`${runnerJobQueue.executionContext}->'resumeSession'->>'historyGenerationRunId'`;
  const sessionId = sql`${runnerJobQueue.cliAgentSessionId}`;
  const profile = sql`${runnerJobQueue.profile}`;
  const exactCondition = reusableSandboxCondition({
    sessionId,
    profile,
    historyGenerationRunId: targetGenerationRunId,
  });
  const reusableCondition = reusableSandboxCondition({ sessionId, profile });
  const workspaceCondition = capableWorkspaceCondition({ sessionId, profile });
  const global = (resourceCondition: SQL) => {
    return runnerStateHas({
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const local = (resourceCondition: SQL) => {
    return runnerStateHas({
      runnerId: args.runnerId,
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const hasGlobalExact = global(exactCondition);
  const hasLocalExact = local(exactCondition);
  const hasGlobalReusable = global(reusableCondition);
  const hasLocalReusable = local(reusableCondition);
  const hasGlobalWorkspace = global(workspaceCondition);
  const hasLocalWorkspace = local(workspaceCondition);
  return sql`CASE
    WHEN ${gt(runnerJobQueue.createdAt, generationProtectedAfter)}
    AND ${isNotNull(runnerJobQueue.cliAgentSessionId)}
    AND ${isNotNull(targetGenerationRunId)}
    AND ${hasGlobalExact}
    THEN CASE WHEN ${hasLocalExact} THEN 5 ELSE 0 END
    WHEN ${gt(runnerJobQueue.createdAt, protectedAfter)}
    AND ${isNotNull(runnerJobQueue.cliAgentSessionId)}
    AND ${hasGlobalReusable}
    THEN CASE WHEN ${hasLocalReusable} THEN 4 ELSE 0 END
    WHEN ${gt(runnerJobQueue.createdAt, protectedAfter)}
    AND ${isNotNull(runnerJobQueue.cliAgentSessionId)}
    AND ${hasGlobalWorkspace}
    THEN CASE
      WHEN ${hasLocalReusable} THEN 4
      WHEN ${hasLocalWorkspace} THEN 3
      ELSE 0
    END
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
  readonly resource: SessionAffinityResource | null;
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
    resource: null,
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

interface RunnerSessionAffinityHolders {
  readonly hasSessionHolder: boolean;
  readonly hasExactGenerationHolder: boolean;
  readonly resource: SessionAffinityResource | null;
}

async function runnerSessionAffinityHolders(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cliAgentSessionId: string;
  readonly historyGenerationRunId: string | undefined;
  readonly freshAfter: Date;
  readonly shouldLookUpExactGeneration: boolean;
}): Promise<RunnerSessionAffinityHolders> {
  const reusableCondition = reusableSandboxCondition({
    sessionId: sql.param(args.cliAgentSessionId),
    profile: sql.param(args.profile),
  });
  const workspaceCondition = capableWorkspaceCondition({
    sessionId: sql.param(args.cliAgentSessionId),
    profile: sql.param(args.profile),
  });
  const exactGenerationCondition =
    args.shouldLookUpExactGeneration &&
    args.historyGenerationRunId !== undefined
      ? reusableSandboxCondition({
          sessionId: sql.param(args.cliAgentSessionId),
          profile: sql.param(args.profile),
          historyGenerationRunId: sql.param(args.historyGenerationRunId),
        })
      : sql`false`;
  const [holders] = await args.db
    .select({
      hasReusableHolder:
        sql`coalesce(bool_or(${reusableCondition}), false)`.mapWith(
          pgBooleanDecoder,
        ),
      hasWorkspaceHolder:
        sql`coalesce(bool_or(${workspaceCondition}), false)`.mapWith(
          pgBooleanDecoder,
        ),
      hasExactGenerationHolder:
        sql`coalesce(bool_or(${exactGenerationCondition}), false)`.mapWith(
          pgBooleanDecoder,
        ),
    })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, args.runnerGroup),
        eq(runnerState.mode, "running"),
        gt(runnerState.lastSeenAt, args.freshAfter),
      ),
    );

  const hasReusableHolder = holders?.hasReusableHolder ?? false;
  const hasWorkspaceHolder = holders?.hasWorkspaceHolder ?? false;
  return {
    hasSessionHolder: hasReusableHolder || hasWorkspaceHolder,
    hasExactGenerationHolder: holders?.hasExactGenerationHolder ?? false,
    resource: hasReusableHolder
      ? "reusableSandbox"
      : hasWorkspaceHolder
        ? "workspaceCache"
        : null,
  };
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
      resource: null,
      historyGenerationProtectedUntil: null,
      historyGenerationStatus: "no_session",
    };
  }
  if (!protectedUntil || protectedUntil <= args.currentDate) {
    return {
      protectedUntil: null,
      status: "expired",
      resource: null,
      historyGenerationProtectedUntil: null,
      historyGenerationStatus: args.historyGenerationRunId
        ? "expired"
        : "no_target",
    };
  }

  const freshAfter = runnerSessionAffinityHolderFreshAfter(args.currentDate);
  const shouldLookUpExactGeneration =
    historyGenerationProtectedUntil !== null &&
    historyGenerationProtectedUntil > args.currentDate;
  const holders = await runnerSessionAffinityHolders({
    db: args.db,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    cliAgentSessionId: args.cliAgentSessionId,
    historyGenerationRunId: args.historyGenerationRunId,
    freshAfter,
    shouldLookUpExactGeneration,
  });
  const historyGenerationStatus: RunnerHistoryGenerationAffinityStatus =
    !args.historyGenerationRunId
      ? "no_target"
      : !shouldLookUpExactGeneration
        ? "expired"
        : holders.hasExactGenerationHolder
          ? "protected"
          : "no_exact_holder";

  return {
    protectedUntil: holders.hasSessionHolder ? protectedUntil : null,
    status: holders.hasSessionHolder ? "protected" : "no_viable_holder",
    resource: holders.resource,
    historyGenerationProtectedUntil: holders.hasExactGenerationHolder
      ? historyGenerationProtectedUntil
      : null,
    historyGenerationStatus,
  };
}

export function runnerSessionAffinityTelemetryResource(
  affinity: RunnerSessionAffinityProtection,
): "reusableSandbox" | "workspaceCache" | "none" {
  return affinity.resource ?? "none";
}
