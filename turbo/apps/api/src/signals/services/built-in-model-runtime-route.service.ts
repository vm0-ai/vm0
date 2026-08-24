import { AsyncLocalStorage } from "node:async_hooks";

import {
  getVm0ManagedRouteCandidates,
  type Vm0ManagedRouteProviderType,
  type Vm0ManagedRouteTarget,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { managedModelCandidateCooldown } from "@okouai/db/schema/managed-model-cooldown";
import { and, eq, gt, sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: Vm0ManagedRouteProviderType;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
}

export interface ModelRuntimeSessionRoute {
  readonly modelProvider: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
}

interface ManagedModelCandidateIdentity {
  readonly selectedModel: string;
  readonly providerType: string;
  readonly upstreamModel: string;
}

const unavailableRuntimeRouteModelsForTest = singleton(() => {
  return new AsyncLocalStorage<ReadonlySet<string>>();
});

/**
 * Operator-managed model keys are global rows, so a missing-key API test cannot
 * safely delete them while other test workers are running. Keep that impossible
 * external state scoped to the calling async chain instead of mutating shared
 * database state.
 */
export async function withBuiltInModelRuntimeRouteUnavailableForTest<T>(
  selectedModel: string,
  work: () => Promise<T>,
): Promise<T> {
  const inherited = unavailableRuntimeRouteModelsForTest.peek()?.getStore();
  return await unavailableRuntimeRouteModelsForTest().run(
    new Set([...(inherited ?? []), selectedModel]),
    work,
  );
}

function runtimeRouteUnavailableForTest(selectedModel: string): boolean {
  return (
    unavailableRuntimeRouteModelsForTest
      .peek()
      ?.getStore()
      ?.has(selectedModel) === true
  );
}

function routeFromTarget(
  target: Vm0ManagedRouteTarget,
  key: { readonly id: string },
): BuiltInModelRuntimeRoute {
  return {
    selectedModel: target.selectedModel,
    providerType: target.providerType,
    upstreamModel: target.upstreamModel,
    modelKeyId: key.id,
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
    .select({ id: builtInModelKeys.id })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.vendor, target.vendor))
    .limit(1);
  return key ? routeFromTarget(target, key) : null;
}

export async function resolveBuiltInModelRuntimeRoute(
  db: Db,
  selectedModel: string,
  fallbackEnabled = false,
): Promise<BuiltInModelRuntimeRoute | null> {
  if (runtimeRouteUnavailableForTest(selectedModel)) {
    return null;
  }
  if (!fallbackEnabled) {
    return await resolvePrimaryRoute(db, selectedModel);
  }

  const timestamp = nowDate();
  for (const target of getVm0ManagedRouteCandidates(selectedModel)) {
    const [key] = await db
      .select({ id: builtInModelKeys.id })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, target.vendor))
      .limit(1);
    if (!key) {
      continue;
    }

    const [managedCooldowns, builtInCooldowns] = await Promise.all([
      db
        .select({
          unavailableUntil: managedModelCandidateCooldown.unavailableUntil,
        })
        .from(managedModelCandidateCooldown)
        .where(
          and(
            eq(
              managedModelCandidateCooldown.selectedModel,
              target.selectedModel,
            ),
            eq(managedModelCandidateCooldown.providerType, target.providerType),
            eq(
              managedModelCandidateCooldown.upstreamModel,
              target.upstreamModel,
            ),
            gt(managedModelCandidateCooldown.unavailableUntil, timestamp),
          ),
        )
        .limit(1),
      db
        .select({
          unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
        })
        .from(builtInModelCandidateCooldown)
        .where(
          and(
            eq(
              builtInModelCandidateCooldown.selectedModel,
              target.selectedModel,
            ),
            eq(builtInModelCandidateCooldown.providerType, target.providerType),
            eq(
              builtInModelCandidateCooldown.upstreamModel,
              target.upstreamModel,
            ),
            gt(builtInModelCandidateCooldown.unavailableUntil, timestamp),
          ),
        )
        .limit(1),
    ]);
    if (managedCooldowns.length > 0 || builtInCooldowns.length > 0) {
      continue;
    }

    return routeFromTarget(target, key);
  }
  return null;
}

export async function extendManagedModelCandidateCooldown(
  db: Db,
  args: ManagedModelCandidateIdentity & {
    readonly retryAfterSeconds: number;
  },
): Promise<Date> {
  const unavailableUntil = new Date(
    nowDate().getTime() + args.retryAfterSeconds * 1000,
  );
  return await db.transaction(async (tx) => {
    const [managedCooldown] = await tx
      .insert(managedModelCandidateCooldown)
      .values({
        selectedModel: args.selectedModel,
        providerType: args.providerType,
        upstreamModel: args.upstreamModel,
        unavailableUntil,
      })
      .onConflictDoUpdate({
        target: [
          managedModelCandidateCooldown.selectedModel,
          managedModelCandidateCooldown.providerType,
          managedModelCandidateCooldown.upstreamModel,
        ],
        set: {
          unavailableUntil: sql`GREATEST(${managedModelCandidateCooldown.unavailableUntil}, EXCLUDED.unavailable_until)`,
        },
      })
      .returning({
        unavailableUntil: managedModelCandidateCooldown.unavailableUntil,
      });
    if (!managedCooldown) {
      throw new Error(
        "Expected managed model candidate cooldown to be written",
      );
    }

    const [builtInCooldown] = await tx
      .insert(builtInModelCandidateCooldown)
      .values({
        selectedModel: args.selectedModel,
        providerType: args.providerType,
        upstreamModel: args.upstreamModel,
        unavailableUntil,
      })
      .onConflictDoUpdate({
        target: [
          builtInModelCandidateCooldown.selectedModel,
          builtInModelCandidateCooldown.providerType,
          builtInModelCandidateCooldown.upstreamModel,
        ],
        set: {
          unavailableUntil: sql`GREATEST(${builtInModelCandidateCooldown.unavailableUntil}, EXCLUDED.unavailable_until)`,
        },
      })
      .returning({
        unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      });
    if (!builtInCooldown) {
      throw new Error(
        "Expected built-in model candidate cooldown to be written",
      );
    }

    return managedCooldown.unavailableUntil > builtInCooldown.unavailableUntil
      ? managedCooldown.unavailableUntil
      : builtInCooldown.unavailableUntil;
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
