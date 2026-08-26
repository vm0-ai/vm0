import {
  runStatusSchema,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, eq, gt, lte } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

const DEFAULT_COOLDOWN_SECONDS = 5 * 60;
const INTERVENTION_COOLDOWN_SECONDS = 30 * 60;
const INACTIVE_DEADLINE_MS = 0;

type FailureKind =
  | "authentication"
  | "billing"
  | "rate_limit"
  | "provider_unavailable"
  | "timeout"
  | "connection";
type ConnectionSource = "provider_response" | "upstream_transport";
type FailureSource = ConnectionSource | "legacy";
type ActivationReason =
  | "active_extension"
  | "distinct_run"
  | "failed_run"
  | "failure_kind"
  | "legacy_connection"
  | "provider_response";

export interface BuiltInModelProviderFailureRun {
  readonly id: string;
  readonly status: RunStatus;
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
  readonly builtInModelKeyId: string | null;
}

interface RouteIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

interface TransitionBase {
  readonly runId: string;
  readonly route: RouteIdentity;
  readonly source: FailureSource;
}

interface IgnoredTransition {
  readonly kind: "ignored";
  readonly outcome: "ignored";
  readonly runId: string;
  readonly disposition:
    | "ineligible_run"
    | "terminal_cancelled"
    | "terminal_completed";
}

interface ObservationTransition extends TransitionBase {
  readonly kind: "observation";
  readonly outcome: "observed";
  readonly source: "upstream_transport";
  readonly disposition: "created" | "replaced" | "same_run";
  readonly observationUntil: Date;
}

interface ObservationClearedTransition extends TransitionBase {
  readonly kind: "observation_cleared";
  readonly source: "upstream_transport";
  readonly disposition: "cancelled" | "completed";
}

interface CooldownTransition extends TransitionBase {
  readonly kind: "cooldown";
  readonly outcome: "recorded";
  readonly activationReason: ActivationReason;
  readonly failureKind: FailureKind;
  readonly retryAfterSeconds: number;
  readonly unavailableUntil: Date;
}

interface CooldownUnchangedTransition extends TransitionBase {
  readonly kind: "cooldown_unchanged";
  readonly outcome: "recorded";
  readonly failureKind: FailureKind;
  readonly retryAfterSeconds: number;
  readonly unavailableUntil: Date;
}

export type BuiltInModelProviderFailureTransition =
  | IgnoredTransition
  | ObservationTransition
  | ObservationClearedTransition
  | CooldownTransition
  | CooldownUnchangedTransition;

type BuiltInModelProviderFailureReportTransition = Exclude<
  BuiltInModelProviderFailureTransition,
  ObservationClearedTransition
>;

interface LockedRoute {
  readonly unavailableUntil: Date;
  readonly connectionObservationRunId: string | null;
  readonly connectionObservationUntil: Date | null;
}

function routeForRun(
  run: BuiltInModelProviderFailureRun,
): RouteIdentity | null {
  if (
    !isBuiltInModelProviderType(run.modelProvider) ||
    !run.selectedModel ||
    !run.modelRuntimeProvider ||
    !run.modelRuntimeModel ||
    !run.builtInModelKeyId
  ) {
    return null;
  }
  return {
    selectedModel: run.selectedModel,
    providerType: run.modelRuntimeProvider,
    upstreamModel: run.modelRuntimeModel,
  };
}

function routeCondition(route: RouteIdentity) {
  return and(
    eq(builtInModelCandidateCooldown.selectedModel, route.selectedModel),
    eq(builtInModelCandidateCooldown.providerType, route.providerType),
    eq(builtInModelCandidateCooldown.upstreamModel, route.upstreamModel),
  );
}

async function lockExistingRoute(
  tx: Tx,
  route: RouteIdentity,
): Promise<LockedRoute | null> {
  const [row] = await tx
    .select({
      unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      connectionObservationRunId:
        builtInModelCandidateCooldown.connectionObservationRunId,
      connectionObservationUntil:
        builtInModelCandidateCooldown.connectionObservationUntil,
    })
    .from(builtInModelCandidateCooldown)
    .where(routeCondition(route))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function hasReconcilableObservation(
  tx: Tx,
  args: {
    readonly route: RouteIdentity;
    readonly runId: string;
    readonly timestamp: Date;
  },
): Promise<boolean> {
  const [row] = await tx
    .select({
      connectionObservationRunId:
        builtInModelCandidateCooldown.connectionObservationRunId,
    })
    .from(builtInModelCandidateCooldown)
    .where(
      and(
        routeCondition(args.route),
        eq(
          builtInModelCandidateCooldown.connectionObservationRunId,
          args.runId,
        ),
        gt(
          builtInModelCandidateCooldown.connectionObservationUntil,
          args.timestamp,
        ),
        lte(builtInModelCandidateCooldown.unavailableUntil, args.timestamp),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function materializeAndLockRoute(
  tx: Tx,
  route: RouteIdentity,
): Promise<LockedRoute> {
  await tx
    .insert(builtInModelCandidateCooldown)
    .values({ ...route, unavailableUntil: new Date(INACTIVE_DEADLINE_MS) })
    .onConflictDoNothing({
      target: [
        builtInModelCandidateCooldown.selectedModel,
        builtInModelCandidateCooldown.providerType,
        builtInModelCandidateCooldown.upstreamModel,
      ],
    });
  const row = await lockExistingRoute(tx, route);
  if (!row) {
    throw new Error("Expected built-in model candidate route state");
  }
  return row;
}

function failureSource(source: ConnectionSource | undefined): FailureSource {
  return source ?? "legacy";
}

function cooldownSeconds(args: {
  readonly failureKind: FailureKind;
  readonly retryAfterSeconds?: number;
}): number {
  return args.failureKind === "authentication" || args.failureKind === "billing"
    ? INTERVENTION_COOLDOWN_SECONDS
    : (args.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS);
}

function immediateActivationReason(args: {
  readonly failureKind: FailureKind;
  readonly connectionSource?: ConnectionSource;
}): ActivationReason {
  if (args.connectionSource === "provider_response") {
    return "provider_response";
  }
  return args.failureKind === "connection"
    ? "legacy_connection"
    : "failure_kind";
}

async function activateLockedRoute(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly route: RouteIdentity;
    readonly row: LockedRoute;
    readonly timestamp: Date;
    readonly failureKind: FailureKind;
    readonly source: FailureSource;
    readonly retryAfterSeconds: number;
    readonly activationReason: ActivationReason;
  },
): Promise<CooldownTransition | CooldownUnchangedTransition> {
  const requestedUntil = new Date(
    args.timestamp.getTime() + args.retryAfterSeconds * 1000,
  );
  const unavailableUntil =
    args.row.unavailableUntil > requestedUntil
      ? args.row.unavailableUntil
      : requestedUntil;
  const deadlineChanged =
    unavailableUntil.getTime() !== args.row.unavailableUntil.getTime();
  const observationCleared =
    args.row.connectionObservationRunId !== null ||
    args.row.connectionObservationUntil !== null;

  if (deadlineChanged || observationCleared) {
    await tx
      .update(builtInModelCandidateCooldown)
      .set({
        unavailableUntil,
        connectionObservationRunId: null,
        connectionObservationUntil: null,
      })
      .where(routeCondition(args.route));
  }

  const base = {
    runId: args.runId,
    route: args.route,
    source: args.source,
    failureKind: args.failureKind,
    retryAfterSeconds: args.retryAfterSeconds,
    unavailableUntil,
  } as const;
  if (!deadlineChanged) {
    return { kind: "cooldown_unchanged", outcome: "recorded", ...base };
  }
  return {
    kind: "cooldown",
    outcome: "recorded",
    activationReason: args.activationReason,
    ...base,
  };
}

async function lockReportRun(
  tx: Tx,
  runId: string,
): Promise<BuiltInModelProviderFailureRun | null> {
  const [run] = await tx
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      modelProvider: agentRuns.modelProvider,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      builtInModelKeyId: agentRuns.builtInModelKeyId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update", { of: agentRuns })
    .limit(1);
  return run ? { ...run, status: runStatusSchema.parse(run.status) } : null;
}

export async function reportBuiltInModelProviderFailure(
  db: Db,
  args: {
    readonly runId: string;
    readonly failureKind: FailureKind;
    readonly connectionSource?: ConnectionSource;
    readonly retryAfterSeconds?: number;
  },
): Promise<BuiltInModelProviderFailureReportTransition> {
  return await db.transaction(async (tx) => {
    const run = await lockReportRun(tx, args.runId);
    const route = run ? routeForRun(run) : null;
    if (!run || !route) {
      return {
        kind: "ignored",
        outcome: "ignored",
        runId: args.runId,
        disposition: "ineligible_run",
      };
    }

    const source = failureSource(args.connectionSource);
    if (args.connectionSource !== "upstream_transport") {
      const timestamp = nowDate();
      const row = await materializeAndLockRoute(tx, route);
      return await activateLockedRoute(tx, {
        runId: run.id,
        route,
        row,
        timestamp,
        failureKind: args.failureKind,
        source,
        retryAfterSeconds: cooldownSeconds(args),
        activationReason: immediateActivationReason(args),
      });
    }

    if (run.status === "completed" || run.status === "cancelled") {
      return {
        kind: "ignored",
        outcome: "ignored",
        runId: run.id,
        disposition:
          run.status === "completed"
            ? "terminal_completed"
            : "terminal_cancelled",
      };
    }

    const timestamp = nowDate();
    const row = await materializeAndLockRoute(tx, route);
    const retryAfterSeconds = DEFAULT_COOLDOWN_SECONDS;
    if (run.status === "failed") {
      return await activateLockedRoute(tx, {
        runId: run.id,
        route,
        row,
        timestamp,
        failureKind: args.failureKind,
        source,
        retryAfterSeconds,
        activationReason: "failed_run",
      });
    }
    if (row.unavailableUntil > timestamp) {
      return await activateLockedRoute(tx, {
        runId: run.id,
        route,
        row,
        timestamp,
        failureKind: args.failureKind,
        source,
        retryAfterSeconds,
        activationReason: "active_extension",
      });
    }

    const currentObservation =
      row.connectionObservationRunId !== null &&
      row.connectionObservationUntil !== null &&
      row.connectionObservationUntil > timestamp;
    if (currentObservation && row.connectionObservationRunId !== run.id) {
      return await activateLockedRoute(tx, {
        runId: run.id,
        route,
        row,
        timestamp,
        failureKind: args.failureKind,
        source,
        retryAfterSeconds,
        activationReason: "distinct_run",
      });
    }
    if (currentObservation) {
      return {
        kind: "observation",
        outcome: "observed",
        runId: run.id,
        route,
        source: "upstream_transport",
        disposition: "same_run",
        observationUntil: row.connectionObservationUntil,
      };
    }

    const observationUntil = new Date(
      timestamp.getTime() + DEFAULT_COOLDOWN_SECONDS * 1000,
    );
    await tx
      .update(builtInModelCandidateCooldown)
      .set({
        connectionObservationRunId: run.id,
        connectionObservationUntil: observationUntil,
      })
      .where(routeCondition(route));
    return {
      kind: "observation",
      outcome: "observed",
      runId: run.id,
      route,
      source: "upstream_transport",
      disposition:
        row.connectionObservationRunId === null ? "created" : "replaced",
      observationUntil,
    };
  });
}

export async function reconcileBuiltInModelProviderFailureObservation(
  tx: Tx,
  args: {
    readonly run: BuiltInModelProviderFailureRun;
    readonly terminalStatus: "cancelled" | "completed" | "failed";
  },
): Promise<BuiltInModelProviderFailureTransition | undefined> {
  const route = routeForRun(args.run);
  if (!route) {
    return undefined;
  }
  const timestamp = nowDate();
  if (
    !(await hasReconcilableObservation(tx, {
      route,
      runId: args.run.id,
      timestamp,
    }))
  ) {
    return undefined;
  }
  const row = await lockExistingRoute(tx, route);
  if (
    !row ||
    row.unavailableUntil > timestamp ||
    row.connectionObservationRunId !== args.run.id ||
    row.connectionObservationUntil === null ||
    row.connectionObservationUntil <= timestamp
  ) {
    return undefined;
  }

  if (args.terminalStatus === "failed") {
    return await activateLockedRoute(tx, {
      runId: args.run.id,
      route,
      row,
      timestamp,
      failureKind: "connection",
      source: "upstream_transport",
      retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      activationReason: "failed_run",
    });
  }

  await tx
    .update(builtInModelCandidateCooldown)
    .set({
      connectionObservationRunId: null,
      connectionObservationUntil: null,
    })
    .where(routeCondition(route));
  return {
    kind: "observation_cleared",
    runId: args.run.id,
    route,
    source: "upstream_transport",
    disposition: args.terminalStatus,
  };
}

export function logBuiltInModelProviderFailureTransition(
  transition: BuiltInModelProviderFailureTransition,
): void {
  const L = logger("Runners");

  if (transition.kind === "ignored") {
    L.warn("Built-in model provider failure report ignored", {
      runId: transition.runId,
      disposition: transition.disposition,
    });
    return;
  }

  const dimensions = {
    runId: transition.runId,
    selectedModel: transition.route.selectedModel,
    providerType: transition.route.providerType,
    upstreamModel: transition.route.upstreamModel,
    connectionSource: transition.source,
  };
  if (transition.kind === "cooldown") {
    L.error("Built-in model provider failure report recorded", {
      type: "built_in_model_provider_cooldown",
      ...dimensions,
      failureKind: transition.failureKind,
      retryAfterSeconds: transition.retryAfterSeconds,
      unavailableUntil: transition.unavailableUntil.toISOString(),
      activationReason: transition.activationReason,
    });
    return;
  }
  if (transition.kind === "cooldown_unchanged") {
    L.warn("Built-in model provider cooldown unchanged", {
      type: "built_in_model_provider_observation",
      ...dimensions,
      disposition: "active_retained",
      unavailableUntil: transition.unavailableUntil.toISOString(),
    });
    return;
  }
  if (transition.kind === "observation") {
    L.warn("Built-in model provider failure observation updated", {
      type: "built_in_model_provider_observation",
      ...dimensions,
      disposition: transition.disposition,
      observationUntil: transition.observationUntil.toISOString(),
    });
    return;
  }
  L.warn("Built-in model provider failure observation cleared", {
    type: "built_in_model_provider_observation",
    ...dimensions,
    disposition: transition.disposition,
  });
}
