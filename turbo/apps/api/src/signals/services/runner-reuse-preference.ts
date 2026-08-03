import type {
  RunnerPreference,
  SessionAffinityResource,
} from "@vm0/api-contracts/contracts/runners";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { runnerState } from "@vm0/db/schema/runner-state";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";

const RUNNER_REUSE_PROTECTION_MS = 2000;
const RUNNER_EXACT_HISTORY_PROTECTION_MS = Math.min(
  500,
  RUNNER_REUSE_PROTECTION_MS,
);
const RUNNER_REUSE_HOLDER_FRESH_MS = 30_000;

function runnerReuseHolderFreshAfter(currentDate: Date): Date {
  return new Date(currentDate.getTime() - RUNNER_REUSE_HOLDER_FRESH_MS);
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
  const heldSandboxStates = sql`jsonb_build_array(
    jsonb_build_object(
      'reuseKey', cast(${args.reuseKey} as text),
      'reusableSandbox', ${reusableSandbox}
    )
  )`;
  return arrayContains(runnerState.heldSandboxStates, heldSandboxStates);
}

function capableWorkspaceCondition(args: {
  readonly reuseKey: SQLWrapper;
  readonly profile: SQLWrapper;
}): SQL {
  const heldWorkspaceStates = sql`jsonb_build_array(
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
    ${arrayContains(runnerState.heldWorkspaceStates, heldWorkspaceStates)}
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

export function runnerReusePreferencePollPriority(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerId: string;
  readonly runnerGroup: string;
  readonly currentDate: Date;
}): SQL {
  const protectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_REUSE_PROTECTION_MS,
  );
  const generationProtectedAfter = new Date(
    args.currentDate.getTime() - RUNNER_EXACT_HISTORY_PROTECTION_MS,
  );
  const freshAfter = runnerReuseHolderFreshAfter(args.currentDate);
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

type RunnerReusePreferenceStatus =
  | "no_session"
  | "expired"
  | "protected"
  | "no_viable_holder"
  | "lookup_error";

type RunnerHistoryGenerationPreferenceStatus =
  | "no_session"
  | "no_target"
  | "expired"
  | "protected"
  | "no_exact_holder"
  | "lookup_error";

type CurrentRunnerPreference = Omit<RunnerPreference, "reason"> & {
  readonly reason: Exclude<RunnerPreference["reason"], "finalizingPredecessor">;
};

interface RunnerReusePreferenceResolution {
  readonly runnerPreference: CurrentRunnerPreference | null;
  readonly protectedUntil: Date | null;
  readonly status: RunnerReusePreferenceStatus;
  readonly resource: SessionAffinityResource | null;
  readonly historyGenerationProtectedUntil: Date | null;
  readonly historyGenerationStatus: RunnerHistoryGenerationPreferenceStatus;
}

export function runnerReusePreferenceLookupError(): RunnerReusePreferenceResolution {
  return {
    runnerPreference: null,
    protectedUntil: null,
    status: "lookup_error",
    resource: null,
    historyGenerationProtectedUntil: null,
    historyGenerationStatus: "lookup_error",
  };
}

interface RunnerReuseHolder {
  readonly runnerIdentity: RunnerPreference["runnerIdentity"];
  readonly resource: SessionAffinityResource;
  readonly hasExactHistoryGeneration: boolean;
}

async function selectRunnerReuseHolder(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly historyGenerationRunId: string | undefined;
  readonly freshAfter: Date;
  readonly shouldLookUpExactGeneration: boolean;
}): Promise<RunnerReuseHolder | null> {
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
  const resourceRank = sql`CASE
    WHEN ${exactGenerationCondition} THEN 3
    WHEN ${reusableCondition} THEN 2
    WHEN ${workspaceCondition} THEN 1
    ELSE 0
  END`;
  const [holder] = await args.db
    .select({
      runnerId: runnerState.runnerId,
      heartbeatGeneration: runnerState.heartbeatGeneration,
      hasExactHistoryGeneration: sql`${exactGenerationCondition}`.mapWith(
        pgBooleanDecoder,
      ),
      hasReusableSandbox: sql`${reusableCondition}`.mapWith(pgBooleanDecoder),
    })
    .from(runnerState)
    .where(
      and(
        eq(runnerState.runnerGroup, args.runnerGroup),
        eq(runnerState.mode, "running"),
        gt(runnerState.lastSeenAt, args.freshAfter),
        gt(runnerState.heartbeatGeneration, 0),
        or(exactGenerationCondition, reusableCondition, workspaceCondition),
      ),
    )
    .orderBy(desc(resourceRank), asc(runnerState.runnerId))
    .limit(1);

  if (!holder) {
    return null;
  }
  return {
    runnerIdentity: {
      runnerId: holder.runnerId,
      heartbeatGeneration: holder.heartbeatGeneration,
    },
    resource: holder.hasReusableSandbox ? "reusableSandbox" : "workspaceCache",
    hasExactHistoryGeneration: holder.hasExactHistoryGeneration,
  };
}

export async function resolveRunnerReusePreference(args: {
  readonly db: Pick<Db, "select">;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string | null;
  readonly historyGenerationRunId: string | undefined;
  readonly createdAt: Date;
  readonly currentDate: Date;
}): Promise<RunnerReusePreferenceResolution> {
  if (!args.reuseKey) {
    return {
      runnerPreference: null,
      protectedUntil: null,
      status: "no_session",
      resource: null,
      historyGenerationProtectedUntil: null,
      historyGenerationStatus: "no_session",
    };
  }
  const protectedUntil = new Date(
    args.createdAt.getTime() + RUNNER_REUSE_PROTECTION_MS,
  );
  const historyGenerationProtectedUntil = args.historyGenerationRunId
    ? new Date(args.createdAt.getTime() + RUNNER_EXACT_HISTORY_PROTECTION_MS)
    : null;
  if (protectedUntil <= args.currentDate) {
    return {
      runnerPreference: null,
      protectedUntil: null,
      status: "expired",
      resource: null,
      historyGenerationProtectedUntil: null,
      historyGenerationStatus: args.historyGenerationRunId
        ? "expired"
        : "no_target",
    };
  }

  const freshAfter = runnerReuseHolderFreshAfter(args.currentDate);
  const shouldLookUpExactGeneration =
    historyGenerationProtectedUntil !== null &&
    historyGenerationProtectedUntil > args.currentDate;
  const holder = await selectRunnerReuseHolder({
    db: args.db,
    runnerGroup: args.runnerGroup,
    profile: args.profile,
    reuseKey: args.reuseKey,
    historyGenerationRunId: args.historyGenerationRunId,
    freshAfter,
    shouldLookUpExactGeneration,
  });
  const historyGenerationStatus: RunnerHistoryGenerationPreferenceStatus =
    !args.historyGenerationRunId
      ? "no_target"
      : !shouldLookUpExactGeneration
        ? "expired"
        : holder?.hasExactHistoryGeneration
          ? "protected"
          : "no_exact_holder";

  if (!holder) {
    return {
      runnerPreference: null,
      protectedUntil: null,
      status: "no_viable_holder",
      resource: null,
      historyGenerationProtectedUntil: null,
      historyGenerationStatus,
    };
  }

  const hasExactHistoryGeneration =
    holder.hasExactHistoryGeneration &&
    historyGenerationProtectedUntil !== null;

  return {
    runnerPreference: {
      runnerIdentity: holder.runnerIdentity,
      reason: hasExactHistoryGeneration
        ? "exactHistoryGeneration"
        : "matchingReuseKey",
      expiresAt: hasExactHistoryGeneration
        ? historyGenerationProtectedUntil.toISOString()
        : protectedUntil.toISOString(),
    },
    protectedUntil,
    status: "protected",
    resource: holder.resource,
    historyGenerationProtectedUntil: hasExactHistoryGeneration
      ? historyGenerationProtectedUntil
      : null,
    historyGenerationStatus,
  };
}

export function runnerReusePreferenceTelemetryResource(
  resolution: RunnerReusePreferenceResolution,
): "reusableSandbox" | "workspaceCache" | "none" {
  return resolution.resource ?? "none";
}

export function runnerReuseKeyTelemetryKind(
  reuseKey: string | null,
): "thread" | "session" | "none" {
  if (reuseKey === null) {
    return "none";
  }
  return reuseKey.startsWith("thread:") ? "thread" : "session";
}
