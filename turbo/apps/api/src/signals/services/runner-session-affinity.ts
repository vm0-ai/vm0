import type { SessionAffinityResource } from "@vm0/api-contracts/contracts/runners";
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

type SessionIdSqlValue = string | SQL<string | null>;
type ProfileSqlValue = string | SQL<string>;
type GenerationSqlValue = string | SQL<string | null>;

function reusableSandboxCondition(args: {
  readonly sessionId: SessionIdSqlValue;
  readonly profile: ProfileSqlValue;
  readonly historyGenerationRunId?: GenerationSqlValue;
}): SQL<boolean> {
  const reusableSandbox = args.historyGenerationRunId
    ? sql`jsonb_build_object(
        'profile', cast(${args.profile} as text),
        'historyGenerationRunId', cast(${args.historyGenerationRunId} as text)
      )`
    : sql`jsonb_build_object('profile', cast(${args.profile} as text))`;
  return sql<boolean>`${runnerState.heldSessionStates} @> jsonb_build_array(
    jsonb_build_object(
      'sessionId', cast(${args.sessionId} as text),
      'reusableSandbox', ${reusableSandbox}
    )
  )`;
}

function capableWorkspaceCondition(args: {
  readonly sessionId: SessionIdSqlValue;
  readonly profile: ProfileSqlValue;
}): SQL<boolean> {
  return sql<boolean>`(
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

function legacySessionCondition(args: {
  readonly sessionId: SessionIdSqlValue;
  readonly profile: ProfileSqlValue;
}): SQL<boolean> {
  // Transitional fallback for runners without resource-class capabilities.
  // Remove after the rollout gate tracked by #21871.
  return sql<boolean>`(
    ${runnerState.admittableProfiles} @> jsonb_build_array(
      cast(${args.profile} as text)
    )
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${runnerState.heldSessionStates}) AS session_state(value)
      WHERE session_state.value->>'sessionId' = cast(${args.sessionId} as text)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${runnerState.heldSessionStates}) AS capable_session(value)
      CROSS JOIN LATERAL jsonb_array_elements(
        coalesce(capable_session.value->'workspaceCaches', '[]'::jsonb)
      ) AS workspace_cache(value)
      WHERE capable_session.value->>'sessionId' = cast(${args.sessionId} as text)
        AND workspace_cache.value @> '{"workspaceAffinityVersion": 1}'::jsonb
    )
  )`;
}

function runnerStateHas(args: {
  readonly runnerId?: string;
  readonly runnerGroup: string;
  readonly freshAfter: Date;
  readonly resourceCondition: SQL<boolean>;
}): SQL<boolean> {
  const runnerCondition = args.runnerId
    ? sql`AND ${runnerState.runnerId} = ${args.runnerId}`
    : sql``;
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${runnerState}
    WHERE ${runnerState.runnerGroup} = ${args.runnerGroup}
      ${runnerCondition}
      AND ${runnerState.mode} = 'running'
      AND ${runnerState.lastSeenAt} > ${args.freshAfter}
      AND ${args.resourceCondition}
  )`;
}

export function runnerSessionAffinityPollPriority(args: {
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
  const sessionId = sql<string | null>`${runnerJobQueue.cliAgentSessionId}`;
  const profile = sql<string>`${runnerJobQueue.profile}`;
  const exactCondition = reusableSandboxCondition({
    sessionId,
    profile,
    historyGenerationRunId: targetGenerationRunId,
  });
  const reusableCondition = reusableSandboxCondition({ sessionId, profile });
  const workspaceCondition = capableWorkspaceCondition({ sessionId, profile });
  const legacyCondition = legacySessionCondition({ sessionId, profile });
  const global = (resourceCondition: SQL<boolean>) => {
    return runnerStateHas({
      runnerGroup: args.runnerGroup,
      freshAfter,
      resourceCondition,
    });
  };
  const local = (resourceCondition: SQL<boolean>) => {
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
  const hasGlobalLegacy = global(legacyCondition);
  const hasLocalLegacy = local(legacyCondition);
  return sql<number>`CASE
    WHEN ${runnerJobQueue.createdAt} > ${generationProtectedAfter}
    AND ${runnerJobQueue.cliAgentSessionId} IS NOT NULL
    AND ${targetGenerationRunId} IS NOT NULL
    AND ${hasGlobalExact}
    THEN CASE WHEN ${hasLocalExact} THEN 5 ELSE 0 END
    WHEN ${runnerJobQueue.createdAt} > ${protectedAfter}
    AND ${runnerJobQueue.cliAgentSessionId} IS NOT NULL
    AND ${hasGlobalReusable}
    THEN CASE WHEN ${hasLocalReusable} THEN 4 ELSE 0 END
    WHEN ${runnerJobQueue.createdAt} > ${protectedAfter}
    AND ${runnerJobQueue.cliAgentSessionId} IS NOT NULL
    AND ${hasGlobalWorkspace}
    THEN CASE
      WHEN ${hasLocalReusable} THEN 4
      WHEN ${hasLocalWorkspace} THEN 3
      ELSE 0
    END
    WHEN ${runnerJobQueue.createdAt} > ${protectedAfter}
    AND ${runnerJobQueue.cliAgentSessionId} IS NOT NULL
    AND ${hasGlobalLegacy}
    AND ${hasLocalLegacy}
    THEN 2
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
  readonly workspaceSidecarAvailability?: RunnerWorkspaceSidecarAvailability;
}

interface RunnerWorkspaceSidecarAvailability {
  readonly exact: boolean;
  readonly different: boolean;
  readonly legacy: boolean;
  readonly absent: boolean;
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

export function runnerWorkspaceSidecarTelemetryDimensions(
  affinity: RunnerSessionAffinityProtection,
): Record<string, string> {
  const availability = affinity.workspaceSidecarAvailability;
  if (!availability) {
    return {};
  }
  return {
    workspace_sidecar_exact_holder: String(availability.exact),
    workspace_sidecar_different_holder: String(availability.different),
    workspace_sidecar_legacy_holder: String(availability.legacy),
    workspace_sidecar_absent_holder: String(availability.absent),
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
  readonly workspaceSidecarAvailability?: RunnerWorkspaceSidecarAvailability;
}

const WORKSPACE_SIDECAR_EXACT_BIT = 1;
const WORKSPACE_SIDECAR_DIFFERENT_BIT = 2;
const WORKSPACE_SIDECAR_LEGACY_BIT = 4;
const WORKSPACE_SIDECAR_ABSENT_BIT = 8;

function workspaceSidecarAvailabilityMask(args: {
  readonly sessionId: string;
  readonly profile: string;
  readonly historyGenerationRunId: string | undefined;
}): SQL<number> {
  if (!args.historyGenerationRunId) {
    return sql<number>`0`;
  }
  return sql<number>`CASE
    WHEN ${runnerState.admittableProfiles} @> jsonb_build_array(
      cast(${args.profile} as text)
    )
    THEN coalesce((
      SELECT bit_or(
        CASE
          WHEN jsonb_typeof(workspace_cache.value->'sessionHistorySidecar') IS DISTINCT FROM 'object'
            THEN cast(${WORKSPACE_SIDECAR_ABSENT_BIT} as integer)
          WHEN workspace_cache.value->'sessionHistorySidecar'->>'historyGenerationRunId' IS NULL
            THEN cast(${WORKSPACE_SIDECAR_LEGACY_BIT} as integer)
          WHEN workspace_cache.value->'sessionHistorySidecar'->>'historyGenerationRunId' = cast(${args.historyGenerationRunId} as text)
            THEN cast(${WORKSPACE_SIDECAR_EXACT_BIT} as integer)
          ELSE cast(${WORKSPACE_SIDECAR_DIFFERENT_BIT} as integer)
        END
      )
      FROM jsonb_array_elements(${runnerState.heldSessionStates}) AS session_state(value)
      CROSS JOIN LATERAL jsonb_array_elements(
        coalesce(session_state.value->'workspaceCaches', '[]'::jsonb)
      ) AS workspace_cache(value)
      WHERE session_state.value->>'sessionId' = cast(${args.sessionId} as text)
        AND workspace_cache.value->>'profile' = cast(${args.profile} as text)
        AND workspace_cache.value @> '{"workspaceAffinityVersion": 1}'::jsonb
    ), 0::integer)
    ELSE 0::integer
  END`;
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
    sessionId: args.cliAgentSessionId,
    profile: args.profile,
  });
  const workspaceCondition = capableWorkspaceCondition({
    sessionId: args.cliAgentSessionId,
    profile: args.profile,
  });
  const legacyCondition = legacySessionCondition({
    sessionId: args.cliAgentSessionId,
    profile: args.profile,
  });
  const exactGenerationCondition = args.shouldLookUpExactGeneration
    ? reusableSandboxCondition({
        sessionId: args.cliAgentSessionId,
        profile: args.profile,
        historyGenerationRunId: args.historyGenerationRunId,
      })
    : sql<boolean>`false`;
  const workspaceSidecarMask = workspaceSidecarAvailabilityMask({
    sessionId: args.cliAgentSessionId,
    profile: args.profile,
    historyGenerationRunId: args.historyGenerationRunId,
  });
  const [holders] = await args.db
    .select({
      hasReusableHolder: sql<boolean>`coalesce(bool_or(${reusableCondition}), false)`,
      hasWorkspaceHolder: sql<boolean>`coalesce(bool_or(${workspaceCondition}), false)`,
      hasLegacyHolder: sql<boolean>`coalesce(bool_or(${legacyCondition}), false)`,
      hasExactGenerationHolder: sql<boolean>`coalesce(bool_or(${exactGenerationCondition}), false)`,
      workspaceSidecarMask: sql<number>`coalesce(bit_or((${workspaceSidecarMask})::integer), 0)`,
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
  const hasLegacyHolder = holders?.hasLegacyHolder ?? false;
  const observedWorkspaceSidecarMask = holders?.workspaceSidecarMask ?? 0;
  return {
    hasSessionHolder:
      hasReusableHolder || hasWorkspaceHolder || hasLegacyHolder,
    hasExactGenerationHolder: holders?.hasExactGenerationHolder ?? false,
    resource: hasReusableHolder
      ? "reusableSandbox"
      : hasWorkspaceHolder
        ? "workspaceCache"
        : null,
    ...(args.historyGenerationRunId
      ? {
          workspaceSidecarAvailability: {
            exact:
              (observedWorkspaceSidecarMask & WORKSPACE_SIDECAR_EXACT_BIT) !==
              0,
            different:
              (observedWorkspaceSidecarMask &
                WORKSPACE_SIDECAR_DIFFERENT_BIT) !==
              0,
            legacy:
              (observedWorkspaceSidecarMask & WORKSPACE_SIDECAR_LEGACY_BIT) !==
              0,
            absent:
              (observedWorkspaceSidecarMask & WORKSPACE_SIDECAR_ABSENT_BIT) !==
              0,
          },
        }
      : {}),
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
    workspaceSidecarAvailability: holders.workspaceSidecarAvailability,
  };
}

export function runnerSessionAffinityTelemetryResource(
  affinity: RunnerSessionAffinityProtection,
): "reusableSandbox" | "workspaceCache" | "legacy" | "none" {
  if (affinity.resource) {
    return affinity.resource;
  }
  return affinity.status === "protected" ? "legacy" : "none";
}
