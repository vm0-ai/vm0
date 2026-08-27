import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

const DEFAULT_COOLDOWN_SECONDS = 5 * 60;
const INTERVENTION_COOLDOWN_SECONDS = 30 * 60;
const TRANSPORT_FAILURE_MINIMUM_SECONDS = 60;
const TRANSPORT_FAILURE_MAXIMUM_GAP_SECONDS = 60;
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
  | "failure_kind"
  | "legacy_connection"
  | "provider_response"
  | "sustained_transport";

interface BuiltInModelProviderFailureRun {
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
  readonly disposition: "ineligible_run";
}

interface ObservationTransition extends TransitionBase {
  readonly kind: "observation";
  readonly outcome: "observed";
  readonly source: "upstream_transport";
  readonly disposition: "continued" | "restarted" | "started";
  readonly observationStartedAt: Date;
  readonly observationUntil: Date;
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
  readonly activationReason: ActivationReason;
  readonly failureKind: FailureKind;
  readonly retryAfterSeconds: number;
  readonly unavailableUntil: Date;
}

type BuiltInModelProviderFailureTransition =
  | CooldownTransition
  | CooldownUnchangedTransition
  | IgnoredTransition
  | ObservationTransition;

interface LockedRoute {
  readonly unavailableUntil: Date;
  readonly connectionObservationStartedAt: Date | null;
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
  const [row] = await tx
    .select({
      unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      connectionObservationStartedAt:
        builtInModelCandidateCooldown.connectionObservationStartedAt,
      connectionObservationUntil:
        builtInModelCandidateCooldown.connectionObservationUntil,
    })
    .from(builtInModelCandidateCooldown)
    .where(routeCondition(route))
    .for("update")
    .limit(1);
  if (!row) {
    throw new Error("Expected built-in model candidate route state");
  }
  return row;
}

async function loadReportRun(
  tx: Tx,
  runId: string,
): Promise<BuiltInModelProviderFailureRun | null> {
  const [run] = await tx
    .select({
      modelProvider: agentRuns.modelProvider,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      builtInModelKeyId: agentRuns.builtInModelKeyId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return run ?? null;
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
    args.row.connectionObservationStartedAt !== null ||
    args.row.connectionObservationUntil !== null;

  if (deadlineChanged || observationCleared) {
    await tx
      .update(builtInModelCandidateCooldown)
      .set({
        unavailableUntil,
        connectionObservationStartedAt: null,
        connectionObservationUntil: null,
      })
      .where(routeCondition(args.route));
  }

  const base = {
    runId: args.runId,
    route: args.route,
    source: args.source,
    activationReason: args.activationReason,
    failureKind: args.failureKind,
    retryAfterSeconds: args.retryAfterSeconds,
    unavailableUntil,
  } as const;
  if (!deadlineChanged) {
    return { kind: "cooldown_unchanged", outcome: "recorded", ...base };
  }
  return { kind: "cooldown", outcome: "recorded", ...base };
}

async function observeTransportFailure(
  tx: Tx,
  args: {
    readonly runId: string;
    readonly route: RouteIdentity;
    readonly row: LockedRoute;
    readonly timestamp: Date;
  },
): Promise<
  CooldownTransition | CooldownUnchangedTransition | ObservationTransition
> {
  const currentObservation =
    args.row.connectionObservationStartedAt !== null &&
    args.row.connectionObservationUntil !== null &&
    args.row.connectionObservationUntil >= args.timestamp;

  if (
    currentObservation &&
    args.timestamp.getTime() -
      args.row.connectionObservationStartedAt.getTime() >=
      TRANSPORT_FAILURE_MINIMUM_SECONDS * 1000
  ) {
    return await activateLockedRoute(tx, {
      ...args,
      failureKind: "connection",
      source: "upstream_transport",
      retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      activationReason: "sustained_transport",
    });
  }

  const observationStartedAt = currentObservation
    ? args.row.connectionObservationStartedAt
    : args.timestamp;
  const observationUntil = new Date(
    args.timestamp.getTime() + TRANSPORT_FAILURE_MAXIMUM_GAP_SECONDS * 1000,
  );
  await tx
    .update(builtInModelCandidateCooldown)
    .set({
      connectionObservationStartedAt: observationStartedAt,
      connectionObservationUntil: observationUntil,
    })
    .where(routeCondition(args.route));
  return {
    kind: "observation",
    outcome: "observed",
    runId: args.runId,
    route: args.route,
    source: "upstream_transport",
    disposition: currentObservation
      ? "continued"
      : args.row.connectionObservationStartedAt === null
        ? "started"
        : "restarted",
    observationStartedAt,
    observationUntil,
  };
}

export async function reportBuiltInModelProviderFailure(
  db: Db,
  args: {
    readonly runId: string;
    readonly failureKind: FailureKind;
    readonly connectionSource?: ConnectionSource;
    readonly retryAfterSeconds?: number;
  },
): Promise<BuiltInModelProviderFailureTransition> {
  return await db.transaction(async (tx) => {
    const run = await loadReportRun(tx, args.runId);
    const route = run ? routeForRun(run) : null;
    if (!route) {
      return {
        kind: "ignored",
        outcome: "ignored",
        runId: args.runId,
        disposition: "ineligible_run",
      };
    }

    const row = await materializeAndLockRoute(tx, route);
    const timestamp = nowDate();
    if (args.connectionSource === "upstream_transport") {
      return await observeTransportFailure(tx, {
        runId: args.runId,
        route,
        row,
        timestamp,
      });
    }

    return await activateLockedRoute(tx, {
      runId: args.runId,
      route,
      row,
      timestamp,
      failureKind: args.failureKind,
      source: failureSource(args.connectionSource),
      retryAfterSeconds: cooldownSeconds(args),
      activationReason: immediateActivationReason(args),
    });
  });
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
      failureKind: transition.failureKind,
      retryAfterSeconds: transition.retryAfterSeconds,
      unavailableUntil: transition.unavailableUntil.toISOString(),
      activationReason: transition.activationReason,
    });
    return;
  }
  L.warn("Built-in model provider failure observation updated", {
    type: "built_in_model_provider_observation",
    ...dimensions,
    disposition: transition.disposition,
    observationStartedAt: transition.observationStartedAt.toISOString(),
    observationUntil: transition.observationUntil.toISOString(),
    minimumSustainedSeconds: TRANSPORT_FAILURE_MINIMUM_SECONDS,
    maximumGapSeconds: TRANSPORT_FAILURE_MAXIMUM_GAP_SECONDS,
  });
}
