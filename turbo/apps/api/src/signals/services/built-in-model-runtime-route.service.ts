import {
  getProviderRuntimeModel,
  getVm0ConcreteProviderType,
  getVm0Vendor,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";

interface BuiltInModelRuntimeTarget {
  readonly selectedModel: string;
  readonly providerType: ModelProviderType;
  readonly upstreamModel: string;
  readonly vendor: string;
}

export interface BuiltInModelRuntimeRoute {
  readonly selectedModel: string;
  readonly providerType: ModelProviderType;
  readonly upstreamModel: string;
  readonly modelKeyId: string;
}

export interface ModelRuntimeSessionRoute {
  readonly modelProvider: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
}

export function builtInModelRuntimeTarget(
  selectedModel: string,
): BuiltInModelRuntimeTarget {
  return {
    selectedModel,
    providerType: getVm0ConcreteProviderType(selectedModel),
    upstreamModel: getProviderRuntimeModel("vm0", selectedModel),
    vendor: getVm0Vendor(selectedModel),
  };
}

export async function resolveBuiltInModelRuntimeRoute(
  db: Db,
  selectedModel: string,
): Promise<BuiltInModelRuntimeRoute | null> {
  const target = builtInModelRuntimeTarget(selectedModel);
  const [key] = await db
    .select({ id: builtInModelKeys.id })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.vendor, target.vendor))
    .limit(1);
  return key
    ? {
        selectedModel: target.selectedModel,
        providerType: target.providerType,
        upstreamModel: target.upstreamModel,
        modelKeyId: key.id,
      }
    : null;
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
