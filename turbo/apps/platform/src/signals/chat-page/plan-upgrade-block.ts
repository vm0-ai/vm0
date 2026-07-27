import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface PlanUpgradeDescriptor {
  readonly href: string;
}

export type PlanUpgradeSignals = PlanUpgradeDescriptor;

export interface PlanUpgradeCardSignalsRegistry {
  register(descriptor: PlanUpgradeDescriptor): PlanUpgradeSignals;
  resolve(resourceKey: string): PlanUpgradeSignals;
}

export function parsePlanUpgradeUrl(
  value: string,
): PlanUpgradeDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (
    !url ||
    url.pathname !== "/" ||
    url.searchParams.get("settings") !== "billing" ||
    url.searchParams.get("billingView") !== "plans"
  ) {
    return null;
  }

  return {
    href: "/?settings=billing&billingView=plans",
  };
}

export function createPlanUpgradeCardSignalsRegistry(): PlanUpgradeCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, PlanUpgradeSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.href,
        () => {
          return descriptor;
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}
