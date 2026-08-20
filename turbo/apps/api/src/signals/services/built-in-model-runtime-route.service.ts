import { randomUUID } from "node:crypto";

import {
  getVm0ManagedRouteCandidates,
  type Vm0ManagedRouteProviderType,
  type Vm0ManagedRouteTarget,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import {
  managedModelCandidateHealth,
  managedModelCredentialHealth,
} from "@okouai/db/schema/managed-model-health";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

const PROBE_LEASE_MS = 10 * 60 * 1000;
const CREDENTIAL_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_CANDIDATE_COOLDOWN_SECONDS = 60;
const MIN_CANDIDATE_COOLDOWN_SECONDS = 1;
const MAX_CANDIDATE_COOLDOWN_SECONDS = 300;

export interface BuiltInModelRuntimeHealthSnapshot {
  readonly credentialGeneration: number;
  readonly candidateGeneration: number;
  readonly credentialProbe: boolean;
  readonly candidateProbe: boolean;
  readonly probeLeaseId: string | null;
}

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: Vm0ManagedRouteProviderType;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
  readonly modelKeyRevision: number;
  readonly health: BuiltInModelRuntimeHealthSnapshot | null;
}

export interface ModelRuntimeSessionRoute {
  readonly modelProvider: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
}

export type ManagedModelRuntimeOutcome =
  | { readonly kind: "success" }
  | {
      readonly kind: "credential_failure";
      readonly failureKind: "authentication" | "billing";
    }
  | {
      readonly kind: "candidate_failure";
      readonly failureKind:
        | "rate_limit"
        | "unavailable"
        | "overload"
        | "server_failure"
        | "timeout";
      readonly retryAfterSeconds?: number;
    };

interface HealthRow {
  readonly state: string;
  readonly generation: number;
  readonly cooldownUntil: Date | null;
  readonly probeLeaseId: string | null;
  readonly probeLeaseExpiresAt: Date | null;
}

interface HealthAvailability {
  readonly available: boolean;
  readonly generation: number;
  readonly probe: boolean;
}

function healthAvailability(
  row: HealthRow | undefined,
  timestamp: Date,
): HealthAvailability {
  if (!row || row.state === "closed") {
    return { available: true, generation: row?.generation ?? 0, probe: false };
  }
  if (row.cooldownUntil && row.cooldownUntil.getTime() > timestamp.getTime()) {
    return { available: false, generation: row.generation, probe: false };
  }
  if (
    row.probeLeaseId &&
    row.probeLeaseExpiresAt &&
    row.probeLeaseExpiresAt.getTime() > timestamp.getTime()
  ) {
    return { available: false, generation: row.generation, probe: false };
  }
  return { available: true, generation: row.generation, probe: true };
}

function routeFromTarget(
  target: Vm0ManagedRouteTarget,
  key: { readonly id: string; readonly revision: number },
  health: BuiltInModelRuntimeHealthSnapshot | null,
): BuiltInModelRuntimeRoute {
  return {
    selectedModel: target.selectedModel,
    providerType: target.providerType,
    upstreamModel: target.upstreamModel,
    modelKeyId: key.id,
    modelKeyRevision: key.revision,
    health,
  };
}

export function builtInModelRuntimeTarget(
  selectedModel: string,
): Vm0ManagedRouteTarget {
  const [target] = getVm0ManagedRouteCandidates(selectedModel);
  if (!target) {
    throw new Error(`Managed model has no candidates: ${selectedModel}`);
  }
  return target;
}

async function resolvePrimaryRoute(
  db: Db,
  selectedModel: string,
): Promise<BuiltInModelRuntimeRoute | null> {
  const target = builtInModelRuntimeTarget(selectedModel);
  const [key] = await db
    .select({ id: builtInModelKeys.id, revision: builtInModelKeys.revision })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.vendor, target.vendor))
    .limit(1);
  return key ? routeFromTarget(target, key, null) : null;
}

export async function resolveBuiltInModelRuntimeRoute(
  db: Db,
  selectedModel: string,
  fallbackEnabled = false,
): Promise<BuiltInModelRuntimeRoute | null> {
  if (!fallbackEnabled) {
    return await resolvePrimaryRoute(db, selectedModel);
  }

  return await db.transaction(async (tx) => {
    const timestamp = nowDate();
    for (const target of getVm0ManagedRouteCandidates(selectedModel)) {
      const [key] = await tx
        .select({
          id: builtInModelKeys.id,
          revision: builtInModelKeys.revision,
        })
        .from(builtInModelKeys)
        .where(eq(builtInModelKeys.vendor, target.vendor))
        .limit(1)
        .for("update");
      if (!key) {
        continue;
      }

      const [credentialHealth] = await tx
        .select({
          state: managedModelCredentialHealth.state,
          generation: managedModelCredentialHealth.generation,
          cooldownUntil: managedModelCredentialHealth.cooldownUntil,
          probeLeaseId: managedModelCredentialHealth.probeLeaseId,
          probeLeaseExpiresAt: managedModelCredentialHealth.probeLeaseExpiresAt,
        })
        .from(managedModelCredentialHealth)
        .where(
          and(
            eq(managedModelCredentialHealth.modelKeyId, key.id),
            eq(managedModelCredentialHealth.modelKeyRevision, key.revision),
          ),
        )
        .limit(1)
        .for("update");
      const credential = healthAvailability(credentialHealth, timestamp);
      if (!credential.available) {
        continue;
      }

      const candidateIdentity = and(
        eq(managedModelCandidateHealth.selectedModel, target.selectedModel),
        eq(managedModelCandidateHealth.providerType, target.providerType),
        eq(managedModelCandidateHealth.upstreamModel, target.upstreamModel),
        eq(managedModelCandidateHealth.modelKeyId, key.id),
        eq(managedModelCandidateHealth.modelKeyRevision, key.revision),
      );
      const [candidateHealth] = await tx
        .select({
          state: managedModelCandidateHealth.state,
          generation: managedModelCandidateHealth.generation,
          cooldownUntil: managedModelCandidateHealth.cooldownUntil,
          probeLeaseId: managedModelCandidateHealth.probeLeaseId,
          probeLeaseExpiresAt: managedModelCandidateHealth.probeLeaseExpiresAt,
        })
        .from(managedModelCandidateHealth)
        .where(candidateIdentity)
        .limit(1)
        .for("update");
      const candidate = healthAvailability(candidateHealth, timestamp);
      if (!candidate.available) {
        continue;
      }

      const probeLeaseId =
        credential.probe || candidate.probe ? randomUUID() : null;
      const probeLeaseExpiresAt = new Date(
        timestamp.getTime() + PROBE_LEASE_MS,
      );
      if (credential.probe && probeLeaseId) {
        await tx
          .update(managedModelCredentialHealth)
          .set({ probeLeaseId, probeLeaseExpiresAt, updatedAt: timestamp })
          .where(
            and(
              eq(managedModelCredentialHealth.modelKeyId, key.id),
              eq(managedModelCredentialHealth.modelKeyRevision, key.revision),
              eq(
                managedModelCredentialHealth.generation,
                credential.generation,
              ),
            ),
          );
      }
      if (candidate.probe && probeLeaseId) {
        await tx
          .update(managedModelCandidateHealth)
          .set({ probeLeaseId, probeLeaseExpiresAt, updatedAt: timestamp })
          .where(candidateIdentity);
      }

      return routeFromTarget(target, key, {
        credentialGeneration: credential.generation,
        candidateGeneration: candidate.generation,
        credentialProbe: credential.probe,
        candidateProbe: candidate.probe,
        probeLeaseId,
      });
    }
    return null;
  });
}

function candidateCooldownSeconds(
  retryAfterSeconds: number | undefined,
): number {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) {
    return DEFAULT_CANDIDATE_COOLDOWN_SECONDS;
  }
  return Math.min(
    MAX_CANDIDATE_COOLDOWN_SECONDS,
    Math.max(MIN_CANDIDATE_COOLDOWN_SECONDS, Math.ceil(retryAfterSeconds)),
  );
}

function credentialHealthIdentity(route: BuiltInModelRuntimeRoute) {
  return and(
    eq(managedModelCredentialHealth.modelKeyId, route.modelKeyId),
    eq(managedModelCredentialHealth.modelKeyRevision, route.modelKeyRevision),
  );
}

function candidateHealthIdentity(route: BuiltInModelRuntimeRoute) {
  return and(
    eq(managedModelCandidateHealth.selectedModel, route.selectedModel),
    eq(managedModelCandidateHealth.providerType, route.providerType),
    eq(managedModelCandidateHealth.upstreamModel, route.upstreamModel),
    eq(managedModelCandidateHealth.modelKeyId, route.modelKeyId),
    eq(managedModelCandidateHealth.modelKeyRevision, route.modelKeyRevision),
  );
}

async function closeManagedModelProbeHealth(
  tx: Tx,
  route: BuiltInModelRuntimeRoute,
  health: BuiltInModelRuntimeHealthSnapshot,
  timestamp: Date,
): Promise<void> {
  const values = {
    state: "closed",
    cooldownUntil: null,
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    updatedAt: timestamp,
  } as const;
  if (health.credentialProbe) {
    await tx
      .update(managedModelCredentialHealth)
      .set(values)
      .where(credentialHealthIdentity(route));
  }
  if (health.candidateProbe) {
    await tx
      .update(managedModelCandidateHealth)
      .set(values)
      .where(candidateHealthIdentity(route));
  }
}

async function openManagedModelCredentialHealth(
  args: Readonly<{
    tx: Tx;
    route: BuiltInModelRuntimeRoute;
    health: BuiltInModelRuntimeHealthSnapshot;
    outcome: Extract<
      ManagedModelRuntimeOutcome,
      { kind: "credential_failure" }
    >;
    credentialExists: boolean;
    timestamp: Date;
  }>,
): Promise<void> {
  const { tx, route, health, outcome, credentialExists, timestamp } = args;
  const values = {
    modelKeyId: route.modelKeyId,
    modelKeyRevision: route.modelKeyRevision,
    state: "open",
    generation: health.credentialGeneration + 1,
    cooldownUntil: new Date(timestamp.getTime() + CREDENTIAL_COOLDOWN_MS),
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    lastFailureKind: outcome.failureKind,
    lastFailureAt: timestamp,
    updatedAt: timestamp,
  } as const;
  if (credentialExists) {
    await tx
      .update(managedModelCredentialHealth)
      .set(values)
      .where(credentialHealthIdentity(route));
  } else {
    await tx
      .insert(managedModelCredentialHealth)
      .values(values)
      .onConflictDoNothing();
  }
  if (health.candidateProbe) {
    await tx
      .update(managedModelCandidateHealth)
      .set({
        probeLeaseId: null,
        probeLeaseExpiresAt: null,
        updatedAt: timestamp,
      })
      .where(candidateHealthIdentity(route));
  }
}

async function openManagedModelCandidateHealth(
  args: Readonly<{
    tx: Tx;
    route: BuiltInModelRuntimeRoute;
    health: BuiltInModelRuntimeHealthSnapshot;
    outcome: Extract<ManagedModelRuntimeOutcome, { kind: "candidate_failure" }>;
    candidateExists: boolean;
    timestamp: Date;
  }>,
): Promise<void> {
  const { tx, route, health, outcome, candidateExists, timestamp } = args;
  if (health.credentialProbe) {
    await tx
      .update(managedModelCredentialHealth)
      .set({
        state: "closed",
        cooldownUntil: null,
        probeLeaseId: null,
        probeLeaseExpiresAt: null,
        updatedAt: timestamp,
      })
      .where(credentialHealthIdentity(route));
  }
  const values = {
    selectedModel: route.selectedModel,
    providerType: route.providerType,
    upstreamModel: route.upstreamModel,
    modelKeyId: route.modelKeyId,
    modelKeyRevision: route.modelKeyRevision,
    state: "open",
    generation: health.candidateGeneration + 1,
    cooldownUntil: new Date(
      timestamp.getTime() +
        candidateCooldownSeconds(outcome.retryAfterSeconds) * 1000,
    ),
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    lastFailureKind: outcome.failureKind,
    lastFailureAt: timestamp,
    updatedAt: timestamp,
  } as const;
  if (candidateExists) {
    await tx
      .update(managedModelCandidateHealth)
      .set(values)
      .where(candidateHealthIdentity(route));
  } else {
    await tx
      .insert(managedModelCandidateHealth)
      .values(values)
      .onConflictDoNothing();
  }
}

/**
 * Applies trusted normalized evidence against one immutable route snapshot.
 * The first production caller is intentionally deferred to #28193.
 */
export async function applyManagedModelRuntimeOutcome(
  db: Db,
  route: BuiltInModelRuntimeRoute,
  outcome: ManagedModelRuntimeOutcome,
  fallbackEnabled: boolean,
): Promise<void> {
  const health = route.health;
  if (!fallbackEnabled || !health) {
    return;
  }

  await db.transaction(async (tx) => {
    const timestamp = nowDate();
    const [key] = await tx
      .select({ revision: builtInModelKeys.revision })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.id, route.modelKeyId))
      .limit(1)
      .for("update");
    if (!key || key.revision !== route.modelKeyRevision) {
      return;
    }

    const [credential] = await tx
      .select({
        generation: managedModelCredentialHealth.generation,
        probeLeaseId: managedModelCredentialHealth.probeLeaseId,
      })
      .from(managedModelCredentialHealth)
      .where(credentialHealthIdentity(route))
      .limit(1)
      .for("update");

    const [candidate] = await tx
      .select({
        generation: managedModelCandidateHealth.generation,
        probeLeaseId: managedModelCandidateHealth.probeLeaseId,
      })
      .from(managedModelCandidateHealth)
      .where(candidateHealthIdentity(route))
      .limit(1)
      .for("update");

    const credentialGeneration = credential?.generation ?? 0;
    const candidateGeneration = candidate?.generation ?? 0;
    if (
      credentialGeneration !== health.credentialGeneration ||
      candidateGeneration !== health.candidateGeneration
    ) {
      return;
    }
    if (
      (health.credentialProbe &&
        credential?.probeLeaseId !== health.probeLeaseId) ||
      (health.candidateProbe && candidate?.probeLeaseId !== health.probeLeaseId)
    ) {
      return;
    }

    if (outcome.kind === "success") {
      await closeManagedModelProbeHealth(tx, route, health, timestamp);
      return;
    }

    if (outcome.kind === "credential_failure") {
      await openManagedModelCredentialHealth({
        tx,
        route,
        health,
        outcome,
        credentialExists: Boolean(credential),
        timestamp,
      });
      return;
    }

    await openManagedModelCandidateHealth({
      tx,
      route,
      health,
      outcome,
      candidateExists: Boolean(candidate),
      timestamp,
    });
  });
}

export function hasIncompatibleBuiltInModelRuntimeRoute(args: {
  readonly previous: ModelRuntimeSessionRoute;
  readonly next: ModelRuntimeSessionRoute;
}): boolean {
  if (
    args.previous.modelProvider !== "vm0" &&
    args.next.modelProvider !== "vm0"
  ) {
    return false;
  }
  return (
    args.previous.modelProvider !== args.next.modelProvider ||
    args.previous.modelRuntimeProvider !== args.next.modelRuntimeProvider ||
    args.previous.modelRuntimeModel !== args.next.modelRuntimeModel
  );
}
