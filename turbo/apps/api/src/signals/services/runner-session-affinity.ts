import type { SessionAffinityResource } from "@vm0/api-contracts/contracts/runners";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import {
  and,
  arrayContains,
  eq,
  exists,
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
  readonly reuseKey: SQLWrapper;
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
  const heldSessionStates = sql`jsonb_build_array(
    jsonb_build_object(
      'reuseKey', cast(${args.reuseKey} as text),
      'reusableSandbox', ${reusableSandbox}
    )
  )`;
  return arrayContains(runnerState.heldSessionStates, heldSessionStates);
}

function capableWorkspaceCondition(args: {
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
}): SQL {
  const heldSessionStates = sql`jsonb_build_array(
    jsonb_build_object(
      'reuseKey', cast(${args.reuseKey} as text),
      'workspaceCaches', jsonb_build_array(
        jsonb_build_object(
          'profile', cast(${args.profile} as text),
          'workspaceAffinityVersion', 1
        )
      )
    )
  )`;
  const admittableProfiles = sql`jsonb_build_array(
    cast(${args.profile} as text)
  )`;
  return sql`(
    ${arrayContains(runnerState.heldSessionStates, heldSessionStates)}
    AND ${arrayContains(runnerState.admittableProfiles, admittableProfiles)}
  )`;
}

function runnerStateHas(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly freshAfter: Date;
  readonly resourceCondition: SQL;
}): SQL {
  return exists(
    args.db
      .select({ runnerId: runnerState.runnerId })
      .from(runnerState)
      .where(
        and(
          eq(runnerState.runnerGroup, args.runnerGroup),
          ...(args.runnerId ? [eq(runnerState.runnerId, args.runnerId)] : []),
          eq(runnerState.mode, "running"),
          gt(runnerState.lastSeenAt, args.freshAfter),
          args.resourceCondition,
        ),
      ),
  );
}

export function runnerSessionAffinityPollPriority(args: {
  readonly db: Pick<Db, "select">;
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
  const reuseKey = runnerJobQueue.reuseKey;
  const profile = runnerJobQueue.profile;
  const exactCondition = reusableSandboxCondition({
    reuseKey,
    profile,
    historyGenerationRunId: targetGenerationRunId,
  });
  const reusableCondition = reusableSandboxCondition({ reuseKey, profile });
  const workspaceCondition = capableWorkspaceCondition({ reuseKey, profile });
  const global = (resourceCondition: SQL) => {
    return runnerStateHas({
      db: args.db,
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const local = (resourceCondition: SQL) => {
    return runnerStateHas({
      db: args.db,
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
    WHEN ${and(
      gt(runnerJobQueue.createdAt, generationProtectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      isNotNull(targetGenerationRunId),
      hasGlobalExact,
    )}
    THEN CASE WHEN ${hasLocalExact} THEN 5 ELSE 0 END
    WHEN ${and(
      gt(runnerJobQueue.createdAt, protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalReusable,
    )}
    THEN CASE WHEN ${hasLocalReusable} THEN 4 ELSE 0 END
    WHEN ${and(
      gt(runnerJobQueue.createdAt, protectedAfter),
      isNotNull(runnerJobQueue.reuseKey),
      hasGlobalWorkspace,
    )}
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
  reuseKey: string | null,
  createdAt: Date,
): Date | null {
  if (!reuseKey) {
    return null;
  }
  return new Date(createdAt.getTime() + RUNNER_SESSION_AFFINITY_PROTECTION_MS);
}

function historyGenerationAffinityProtectedUntil(args: {
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
}): Date | null {
  if (!args.reuseKey || !args.historyGenerationRunId) {
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
  readonly reuseKey: string;
  readonly historyGenerationRunId: string | undefined;
  readonly freshAfter: Date;
  readonly shouldLookUpExactGeneration: boolean;
}): Promise<RunnerSessionAffinityHolders> {
  const reusableCondition = reusableSandboxCondition({
    reuseKey: sql.param(args.reuseKey),
    profile: sql.param(args.profile),
  });
  const workspaceCondition = capableWorkspaceCondition({
    reuseKey: sql.param(args.reuseKey),
    profile: sql.param(args.profile),
  });
  const exactGenerationCondition =
    args.shouldLookUpExactGeneration &&
    args.historyGenerationRunId !== undefined
      ? reusableSandboxCondition({
          reuseKey: sql.param(args.reuseKey),
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
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
  readonly currentDate: Date;
}): Promise<RunnerSessionAffinityProtection> {
  const protectedUntil = affinityProtectedUntil(args.reuseKey, args.createdAt);
  const historyGenerationProtectedUntil =
    historyGenerationAffinityProtectedUntil(args);
  if (!args.reuseKey) {
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
    reuseKey: args.reuseKey,
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
