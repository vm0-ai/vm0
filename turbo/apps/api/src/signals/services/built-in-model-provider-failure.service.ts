import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
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

interface IgnoredTransition {
  readonly kind: "ignored";
  readonly outcome: "ignored";
  readonly runId: string;
  readonly disposition: "ineligible_run";
}

interface ObservationTransition {
  readonly kind: "observation";
  readonly outcome: "observed";
}

interface CooldownTransition {
  readonly kind: "cooldown";
  readonly outcome: "recorded";
  readonly runId: string;
  readonly route: RouteIdentity;
  readonly source: FailureSource;
  readonly activationReason: ActivationReason;
  readonly failureKind: FailureKind;
  readonly retryAfterSeconds: number;
  readonly unavailableUntil: Date;
}

interface CooldownUnchangedTransition {
  readonly kind: "cooldown_unchanged";
  readonly outcome: "recorded";
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
  // Old runners may omit this field while independently deployed sandboxes
  // drain. Remove the legacy path with #29672 after source-aware runners are
  // deployed and every pre-source sandbox has finished its bounded drain.
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

  if (!deadlineChanged) {
    return { kind: "cooldown_unchanged", outcome: "recorded" };
  }
  return {
    kind: "cooldown",
    outcome: "recorded",
    runId: args.runId,
    route: args.route,
    source: args.source,
    activationReason: args.activationReason,
    failureKind: args.failureKind,
    retryAfterSeconds: args.retryAfterSeconds,
    unavailableUntil,
  };
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
  const observationGapMs = TRANSPORT_FAILURE_MAXIMUM_GAP_SECONDS * 1000;
  const hasObservation =
    args.row.connectionObservationStartedAt !== null &&
    args.row.connectionObservationUntil !== null;
  // The row stores the earliest receipt and latest receipt plus the maximum
  // gap. Merge connected receipts in either lock order and ignore stale gaps.
  if (
    hasObservation &&
    args.timestamp.getTime() + observationGapMs <
      args.row.connectionObservationStartedAt.getTime()
  ) {
    return {
      kind: "observation",
      outcome: "observed",
    };
  }

  const connectedObservation =
    hasObservation &&
    args.timestamp <= args.row.connectionObservationUntil &&
    args.timestamp.getTime() + observationGapMs >=
      args.row.connectionObservationStartedAt.getTime();
  const observationStartedAt =
    connectedObservation &&
    args.row.connectionObservationStartedAt < args.timestamp
      ? args.row.connectionObservationStartedAt
      : args.timestamp;
  const currentLatestAt = connectedObservation
    ? new Date(args.row.connectionObservationUntil.getTime() - observationGapMs)
    : args.timestamp;
  const observationLatestAt =
    currentLatestAt > args.timestamp ? currentLatestAt : args.timestamp;

  if (
    connectedObservation &&
    observationLatestAt.getTime() - observationStartedAt.getTime() >=
      TRANSPORT_FAILURE_MINIMUM_SECONDS * 1000
  ) {
    return await activateLockedRoute(tx, {
      ...args,
      timestamp: observationLatestAt,
      failureKind: "connection",
      source: "upstream_transport",
      retryAfterSeconds: DEFAULT_COOLDOWN_SECONDS,
      activationReason: "sustained_transport",
    });
  }

  const observationUntil = new Date(
    observationLatestAt.getTime() + observationGapMs,
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
  };
}

export async function reportBuiltInModelProviderFailure(
  db: Db,
  args: {
    readonly runId: string;
    readonly receivedAt: Date;
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
    if (args.connectionSource === "upstream_transport") {
      return await observeTransportFailure(tx, {
        runId: args.runId,
        route,
        row,
        timestamp: args.receivedAt,
      });
    }

    return await activateLockedRoute(tx, {
      runId: args.runId,
      route,
      row,
      timestamp: args.receivedAt,
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
  if (
    transition.kind === "cooldown_unchanged" ||
    transition.kind === "observation"
  ) {
    return;
  }

  const L = logger("Runners");
  if (transition.kind === "ignored") {
    L.warn("Built-in model provider failure report ignored", {
      runId: transition.runId,
      disposition: transition.disposition,
    });
    return;
  }

  L.error("Built-in model provider failure report recorded", {
    type: "built_in_model_provider_cooldown",
    runId: transition.runId,
    selectedModel: transition.route.selectedModel,
    providerType: transition.route.providerType,
    upstreamModel: transition.route.upstreamModel,
    connectionSource: transition.source,
    failureKind: transition.failureKind,
    retryAfterSeconds: transition.retryAfterSeconds,
    unavailableUntil: transition.unavailableUntil.toISOString(),
    activationReason: transition.activationReason,
  });
}
