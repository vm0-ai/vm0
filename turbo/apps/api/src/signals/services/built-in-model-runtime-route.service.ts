import { AsyncLocalStorage } from "node:async_hooks";

import {
  getVm0BuiltInModelRouteCandidates,
  isBuiltInModelProviderType,
  type BuiltInModelRouteProviderType,
  type BuiltInModelRouteTarget,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelCandidateCooldown } from "@okouai/db/schema/built-in-model-cooldown";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { and, eq, gt, sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: BuiltInModelRouteProviderType;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
}

export interface ModelRuntimeSessionRoute {
  readonly modelProvider: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
}

interface BuiltInModelCandidateIdentity {
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
  target: BuiltInModelRouteTarget,
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
): BuiltInModelRouteTarget {
  const [target] = getVm0BuiltInModelRouteCandidates(selectedModel);
  if (!target) {
    throw new Error(`Built-in model has no candidates: ${selectedModel}`);
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
  for (const target of getVm0BuiltInModelRouteCandidates(selectedModel)) {
    const [key] = await db
      .select({ id: builtInModelKeys.id })
      .from(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, target.vendor))
      .limit(1);
    if (!key) {
      continue;
    }

    const builtInCooldowns = await db
      .select({
        unavailableUntil: builtInModelCandidateCooldown.unavailableUntil,
      })
      .from(builtInModelCandidateCooldown)
      .where(
        and(
          eq(builtInModelCandidateCooldown.selectedModel, target.selectedModel),
          eq(builtInModelCandidateCooldown.providerType, target.providerType),
          eq(builtInModelCandidateCooldown.upstreamModel, target.upstreamModel),
          gt(builtInModelCandidateCooldown.unavailableUntil, timestamp),
        ),
      )
      .limit(1);
    if (builtInCooldowns.length > 0) {
      continue;
    }

    return routeFromTarget(target, key);
  }
  return null;
}

export async function extendBuiltInModelCandidateCooldown(
  db: Db,
  args: BuiltInModelCandidateIdentity & {
    readonly retryAfterSeconds: number;
  },
): Promise<Date> {
  const unavailableUntil = new Date(
    nowDate().getTime() + args.retryAfterSeconds * 1000,
  );
  const [builtInCooldown] = await db
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
    throw new Error("Expected built-in model candidate cooldown to be written");
  }
  return builtInCooldown.unavailableUntil;
}

export function hasIncompatibleBuiltInModelRuntimeRoute(args: {
  readonly previous: ModelRuntimeSessionRoute;
  readonly next: ModelRuntimeSessionRoute;
}): boolean {
  if (
    !isBuiltInModelProviderType(args.previous.modelProvider) &&
    !isBuiltInModelProviderType(args.next.modelProvider)
  ) {
    return false;
  }
  return (
    isBuiltInModelProviderType(args.previous.modelProvider) !==
      isBuiltInModelProviderType(args.next.modelProvider) ||
    args.previous.modelRuntimeProvider !== args.next.modelRuntimeProvider ||
    args.previous.modelRuntimeModel !== args.next.modelRuntimeModel
  );
}
