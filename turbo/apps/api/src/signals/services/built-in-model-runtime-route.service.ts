import {
  getVm0ManagedRouteCandidates,
  type Vm0ManagedRouteProviderType,
  type Vm0ManagedRouteTarget,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { managedModelCandidateCooldown } from "@okouai/db/schema/managed-model-cooldown";
import { and, eq, gt } from "drizzle-orm";

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

    const [candidateCooldown] = await db
      .select({
        unavailableUntil: managedModelCandidateCooldown.unavailableUntil,
      })
      .from(managedModelCandidateCooldown)
      .where(
        and(
          eq(managedModelCandidateCooldown.selectedModel, target.selectedModel),
          eq(managedModelCandidateCooldown.providerType, target.providerType),
          eq(managedModelCandidateCooldown.upstreamModel, target.upstreamModel),
          gt(managedModelCandidateCooldown.unavailableUntil, timestamp),
        ),
      )
      .limit(1);
    if (candidateCooldown) {
      continue;
    }

    return routeFromTarget(target, key);
  }
  return null;
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
