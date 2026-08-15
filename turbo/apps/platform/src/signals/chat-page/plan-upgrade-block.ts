import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface PlanUpgradeDescriptor {
  readonly href: string;
}

export type PlanUpgradeSignals = PlanUpgradeDescriptor;

type PlanUpgradeCardSignalsRegistry = CardSignalsRegistry<
  PlanUpgradeDescriptor,
  PlanUpgradeSignals
>;

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
  return createCardSignalsRegistry(
    (descriptor: PlanUpgradeDescriptor) => {
      return descriptor.href;
    },
    (descriptor) => {
      return descriptor;
    },
  );
}
